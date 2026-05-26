/**
 * POST /api/transactions/[id]/link-journal-entry
 *
 * Link a bank transaction to an already-posted journal entry without
 * creating new bookkeeping. Used by the duplicate-payment UI when the user
 * confirms the suggested candidate already books this receipt — typically
 * a manual verifikation made outside the match-invoice flow.
 *
 * Body:
 *   - journal_entry_id (required): the existing posted JE to link to.
 *   - invoice_id (optional): when supplied, also inserts an
 *     invoice_payments row pointing at the existing JE and flips the
 *     invoice status to 'paid' / 'partially_paid'. Same optimistic-lock
 *     pattern as match-invoice. Omit when linking against a JE that
 *     doesn't relate to a customer invoice (uncommon but supported).
 *
 * Effects:
 *   - transactions.journal_entry_id = je_id
 *   - transactions.is_business = true
 *   - transactions.potential_invoice_id = null
 *   - transactions.potential_supplier_invoice_id = null
 *   - if invoice_id provided:
 *     - invoice_payments row inserted (transaction_id, amount, journal_entry_id)
 *     - invoice.status / paid_amount / remaining_amount updated
 *
 * NEVER creates a new journal entry; the underlying double-entry already
 * exists. The match log records 'linked_to_existing_voucher' for audit.
 */
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { LinkTransactionJournalEntrySchema } from '@/lib/api/schemas'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import type { Invoice, Transaction } from '@/types'

ensureInitialized()

export const POST = withRouteContext(
  'transaction.link_journal_entry',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, LinkTransactionJournalEntrySchema, {
      log,
      operation: 'transaction.link_journal_entry',
    })
    if (!validation.success) return validation.response
    const { journal_entry_id, invoice_id } = validation.data

    const txLog = log.child({ transactionId, journalEntryId: journal_entry_id, invoiceId: invoice_id })

    // Data minimization (GDPR Art.5(1)(c)): pull only the columns the route
    // actually uses for validation, the optimistic-lock invoice update, the
    // invoice_payments insert, and the compensating-rollback path. Avoid
    // `select('*')` so freshly-added columns (PII or otherwise) never leak
    // into the request scope or downstream logs by accident.
    const { data: transaction, error: fetchTxError } = await supabase
      .from('transactions')
      .select(
        'id, date, amount, currency, exchange_rate, journal_entry_id, invoice_id, is_business, potential_invoice_id, potential_supplier_invoice_id',
      )
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()

    if (fetchTxError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', txLog, { requestId })
    }

    if (transaction.journal_entry_id) {
      return errorResponseFromCode('LINK_TX_TX_ALREADY_LINKED', txLog, {
        requestId,
        details: { existingJournalEntryId: transaction.journal_entry_id },
      })
    }

    const { data: journalEntry, error: fetchJeError } = await supabase
      .from('journal_entries')
      .select('id, status, voucher_series, voucher_number, entry_date')
      .eq('id', journal_entry_id)
      .eq('company_id', companyId)
      .single()

    if (fetchJeError || !journalEntry) {
      return errorResponseFromCode('LINK_TX_JE_NOT_FOUND', txLog, { requestId })
    }

    if (journalEntry.status !== 'posted') {
      return errorResponseFromCode('LINK_TX_JE_NOT_POSTED', txLog, {
        requestId,
        details: { currentStatus: journalEntry.status },
      })
    }

    // If invoice_id supplied, validate + prepare invoice update.
    let invoice: (Invoice & { customer?: { name?: string } | null }) | null = null
    let newPaidAmount = 0
    let newRemaining = 0
    let isFullyPaid = false
    let newStatus: 'paid' | 'partially_paid' = 'paid'

    if (invoice_id) {
      const { data: invoiceRow, error: fetchInvError } = await supabase
        .from('invoices')
        .select('*, customer:customers(name)')
        .eq('id', invoice_id)
        .eq('company_id', companyId)
        .single()

      if (fetchInvError || !invoiceRow) {
        return errorResponseFromCode('LINK_TX_INVOICE_NOT_FOUND', txLog, { requestId })
      }

      if (
        invoiceRow.status !== 'sent' &&
        invoiceRow.status !== 'overdue' &&
        invoiceRow.status !== 'partially_paid'
      ) {
        return errorResponseFromCode('LINK_TX_INVOICE_NOT_OPEN', txLog, {
          requestId,
          details: { currentStatus: invoiceRow.status },
        })
      }

      invoice = invoiceRow as Invoice & { customer?: { name?: string } | null }

      const paidAmount = transaction.amount
      newPaidAmount = Math.round(((invoice.paid_amount || 0) + paidAmount) * 100) / 100
      const currentRemaining = invoice.remaining_amount ?? (invoice.total - (invoice.paid_amount || 0))
      newRemaining = Math.max(0, Math.round((currentRemaining - paidAmount) * 100) / 100)
      isFullyPaid = newRemaining <= 0
      newStatus = isFullyPaid ? 'paid' : 'partially_paid'
    }

    // Capture pre-link values so the compensating-rollback path below can
    // restore the row if the optimistic invoice update loses its race or
    // the invoice_payments insert fails. Without this snapshot a partial
    // state would persist: tx linked, invoice unchanged, no payment row.
    const priorTxState = {
      journal_entry_id: transaction.journal_entry_id, // validated null above
      invoice_id: transaction.invoice_id,
      potential_invoice_id: transaction.potential_invoice_id,
      potential_supplier_invoice_id: transaction.potential_supplier_invoice_id,
      is_business: transaction.is_business,
    }

    // Link the transaction first. If a subsequent step fails the compensating
    // path below restores priorTxState. Doing the tx update before the invoice
    // update preserves the "transaction disappears from inbox" UX even if the
    // invoice update races.
    const { error: updateTxError } = await supabase
      .from('transactions')
      .update({
        journal_entry_id,
        invoice_id: invoice_id ?? null,
        potential_invoice_id: null,
        potential_supplier_invoice_id: null,
        is_business: true,
      })
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .is('journal_entry_id', null)

    if (updateTxError) {
      txLog.error('failed to link transaction to journal entry', updateTxError)
      return errorResponse(updateTxError, txLog, { requestId })
    }

    async function rollbackTxLink(reason: string) {
      const { error: rollbackErr } = await supabase
        .from('transactions')
        .update(priorTxState)
        .eq('id', transactionId)
        .eq('company_id', companyId)
      if (rollbackErr) {
        // Best-effort: the original error is more useful to surface; a
        // failed rollback gets warn-logged so a reconciliation job can pick
        // up the partial state offline. PI1.3 risk is documented here so
        // the audit trail is honest about the remaining gap.
        txLog.warn('failed to roll back transaction link after subsequent step failed', {
          rollbackError: rollbackErr.message,
          reason,
        })
      }
    }

    const now = new Date().toISOString()

    if (invoice && invoice_id) {
      // Optimistic lock: only flip status if invoice is still matchable.
      const { data: updatedRows, error: updateInvError } = await supabase
        .from('invoices')
        .update({
          status: newStatus,
          paid_at: isFullyPaid ? now : null,
          paid_amount: newPaidAmount,
          remaining_amount: newRemaining,
        })
        .eq('id', invoice_id)
        .eq('company_id', companyId)
        .in('status', ['sent', 'overdue', 'partially_paid'])
        .select('id')

      if (updateInvError) {
        await rollbackTxLink('invoice update errored')
        txLog.error('failed to update invoice status', updateInvError)
        return errorResponse(updateInvError, txLog, { requestId })
      }

      if (!updatedRows || updatedRows.length === 0) {
        await rollbackTxLink('invoice optimistic lock returned 0 rows')
        return errorResponseFromCode('LINK_TX_INVOICE_RACE', txLog, { requestId })
      }

      const { error: paymentInsertError } = await supabase
        .from('invoice_payments')
        .insert({
          user_id: user.id,
          company_id: companyId,
          invoice_id,
          payment_date: transaction.date,
          amount: transaction.amount,
          currency: invoice.currency,
          exchange_rate: invoice.exchange_rate,
          journal_entry_id,
          transaction_id: transactionId,
          notes: 'Kopplad till befintlig verifikation (ingen ny bokföring skapad)',
        })

      if (paymentInsertError && paymentInsertError.code !== '23505') {
        // Compensate: revert the invoice update and the tx link before
        // surfacing the error so the ledger doesn't carry an invoice that
        // says "paid" with no corresponding payment row.
        const { error: invRevertErr } = await supabase
          .from('invoices')
          .update({
            status: invoice.status,
            paid_at: invoice.paid_at ?? null,
            paid_amount: invoice.paid_amount ?? 0,
            remaining_amount: invoice.remaining_amount ?? invoice.total,
          })
          .eq('id', invoice_id)
          .eq('company_id', companyId)
        if (invRevertErr) {
          txLog.warn('failed to revert invoice status after payment insert failed', {
            rollbackError: invRevertErr.message,
          })
        }
        await rollbackTxLink('invoice_payments insert failed')
        txLog.error('failed to record invoice payment', paymentInsertError)
        return errorResponseFromCode('MATCH_INVOICE_RECORD_PAYMENT_FAILED', txLog, { requestId })
      }
    }

    logMatchEvent(supabase, user.id, transactionId, 'linked_to_existing_voucher', {
      invoiceId: invoice_id,
      newState: {
        journal_entry_id,
        invoice_id: invoice_id ?? null,
        invoice_status: invoice ? newStatus : null,
      },
    })

    if (invoice && invoice_id) {
      try {
        eventBus.emit({
          type: 'invoice.match_confirmed',
          payload: {
            invoice: invoice as Invoice,
            transaction: transaction as Transaction,
            userId: user.id,
            companyId,
          },
        })
      } catch (err) {
        txLog.warn('invoice.match_confirmed event emission failed', err as Error)
      }
    }

    return NextResponse.json({
      success: true,
      journal_entry_id,
      voucher_label: `${journalEntry.voucher_series ?? 'A'}${journalEntry.voucher_number ?? ''}`,
      invoice_id: invoice_id ?? null,
      invoice_status: invoice ? newStatus : null,
      paid_amount: invoice ? newPaidAmount : null,
      remaining_amount: invoice ? newRemaining : null,
    })
  },
  { requireWrite: true },
)
