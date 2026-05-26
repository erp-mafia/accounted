import { NextResponse } from 'next/server'
import {
  createInvoicePaymentJournalEntry,
  createInvoiceCashEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { AccountsNotInChartError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { MatchInvoiceSchema } from '@/lib/api/schemas'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { detectDuplicatePaymentVoucher } from '@/lib/invoices/duplicate-payment-detection'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import type { EntityType, Invoice, Transaction } from '@/types'

ensureInitialized()

/**
 * POST /api/transactions/[id]/match-invoice
 *
 * Confirms an invoice match for a transaction. Supports partial payments:
 * 1. If transaction has an auto-categorization journal entry, storno it first
 * 2. Links transaction to invoice (sets invoice_id)
 * 3. Updates invoice status to 'paid' or 'partially_paid'
 * 4. Records payment in invoice_payments table
 * 5. Creates journal entry for payment receipt
 *    - Debit 1930 Företagskonto (Bank)
 *    - Credit 1510 Kundfordringar (Accounts Receivable)
 */
export const POST = withRouteContext(
  'transaction.match_invoice',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, MatchInvoiceSchema, {
      log,
      operation: 'transaction.match_invoice',
    })
    if (!validation.success) return validation.response
    const { invoice_id, force, expected_journal_entry_id } = validation.data

    const txLog = log.child({ transactionId, invoiceId: invoice_id })

    const { data: transaction, error: fetchTxError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()

    if (fetchTxError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', txLog, { requestId })
    }

    if (transaction.amount <= 0) {
      return errorResponseFromCode('MATCH_INVOICE_NOT_INCOME', txLog, {
        requestId,
        details: { amount: transaction.amount },
      })
    }

    if (transaction.invoice_id) {
      return errorResponseFromCode('MATCH_INVOICE_TX_ALREADY_LINKED', txLog, {
        requestId,
        details: { existingInvoiceId: transaction.invoice_id },
      })
    }

    const { data: invoice, error: fetchInvError } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', invoice_id)
      .eq('company_id', companyId)
      .single()

    if (fetchInvError || !invoice) {
      return errorResponseFromCode('MATCH_INVOICE_NOT_FOUND', txLog, { requestId })
    }

    // Defense-in-depth: the InvoicePicker UI filters proformas / delivery
    // notes out of the candidate list, but a direct API call could still
    // pass a proforma id. A proforma is not a faktura per ML 17 kap 24§ —
    // no VAT obligation, no binding payment — so matching one against a
    // bank receipt would book income and VAT incorrectly.
    const docType = (invoice as { document_type?: string }).document_type ?? 'invoice'
    if (docType !== 'invoice') {
      return errorResponseFromCode('MATCH_INVOICE_NOT_INVOICE_TYPE', txLog, {
        requestId,
        details: { documentType: docType },
      })
    }

    if (invoice.status !== 'sent' && invoice.status !== 'overdue' && invoice.status !== 'partially_paid') {
      return errorResponseFromCode('MATCH_INVOICE_NOT_OPEN', txLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // Hard-duplicate guard: if the invoice is 'sent'/'overdue' but already
    // has a payment voucher attached (status leak), refuse — booking again
    // would double-credit 1510 / double-debit 1930. Partially-paid invoices
    // pass through; additional payments are legitimate.
    if (invoice.status === 'sent' || invoice.status === 'overdue') {
      const { data: existingPayments } = await supabase
        .from('invoice_payments')
        .select('journal_entry_id')
        .eq('company_id', companyId)
        .eq('invoice_id', invoice_id)
        .not('journal_entry_id', 'is', null)
        .limit(1)
      if (existingPayments && existingPayments.length > 0) {
        return errorResponseFromCode('MATCH_INVOICE_ALREADY_HAS_PAYMENT_VOUCHER', txLog, {
          requestId,
          details: {
            existing_journal_entry_id: (existingPayments[0] as { journal_entry_id: string }).journal_entry_id,
          },
        })
      }
    }

    // Soft-duplicate guard: scan for a manual verifikation that already
    // books this bank receipt outside the invoice flow. The customer's
    // exact case: they posted Dr 1930 / Cr 3100 by hand; the matcher
    // would otherwise create a second voucher and double-book. Bypassed
    // with force=true after the user reviews the candidate in the UI.
    //
    // force=true is bound to a specific candidate via expected_journal_entry_id
    // (validated by the schema). We re-detect the candidate server-side and
    // refuse the bypass if it no longer matches: a stale or fabricated
    // expected id cannot wave the guard away. The pre-flight runs even when
    // a candidate is detected so the audit log records the verifikation the
    // user opted to dismiss.
    let dismissedCandidateId: string | null = null
    try {
      const candidate = await detectDuplicatePaymentVoucher(supabase, {
        companyId: companyId!,
        transactionId,
        transactionDate: transaction.date,
        transactionAmount: transaction.amount,
      })
      if (!force) {
        if (candidate) {
          return errorResponseFromCode('MATCH_INVOICE_POSSIBLE_DUPLICATE', txLog, {
            requestId,
            details: { candidate },
          })
        }
      } else {
        if (!candidate || candidate.journal_entry_id !== expected_journal_entry_id) {
          // Either no current duplicate (force is moot — caller should retry
          // without force) or the candidate the caller claims to have seen
          // doesn't match what we detect now. Reject so an automation can't
          // smuggle force=true past the guard with a guessed id.
          return errorResponseFromCode('MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH', txLog, {
            requestId,
            details: {
              expected_journal_entry_id,
              detected_journal_entry_id: candidate?.journal_entry_id ?? null,
            },
          })
        }
        dismissedCandidateId = candidate.journal_entry_id
      }
    } catch (err) {
      // Detection failure must not block the non-force match — log and
      // continue. force=true requires a successful detection, so re-throw
      // its branch as a clean 500 via the wrapper.
      if (force) {
        txLog.error('duplicate-payment-voucher detection failed under force=true', err as Error)
        return errorResponse(err, txLog, { requestId })
      }
      txLog.warn('duplicate-payment-voucher detection failed (continuing)', err as Error)
    }

    if (force && dismissedCandidateId) {
      txLog.warn('soft-duplicate guard bypassed', {
        reason: 'force=true',
        requestId,
        transactionId,
        invoiceId: invoice_id,
        userId: user.id,
        // The verifikation the user reviewed and dismissed. Recorded so the
        // override can be traced back to the specific duplicate that was
        // surfaced in the pre-flight UI.
        dismissedJournalEntryId: dismissedCandidateId,
      })
    }

    // Storno conflicting auto-categorization JE before any other state change.
    // If storno fails, return immediately — nothing else has been modified.
    if (transaction.journal_entry_id) {
      try {
        await reverseEntry(supabase, companyId, user.id, transaction.journal_entry_id)

        const { error: clearJeError } = await supabase
          .from('transactions')
          .update({ journal_entry_id: null })
          .eq('id', transactionId)
        if (clearJeError) {
          txLog.warn('failed to clear journal_entry_id after storno', clearJeError)
        }

        logMatchEvent(supabase, user.id, transactionId, 'storno_conflict_resolved', {
          invoiceId: invoice_id,
          previousState: { journal_entry_id: transaction.journal_entry_id },
          newState: { journal_entry_id: null },
        })
      } catch (err) {
        txLog.error('failed to storno conflicting journal entry', err as Error)
        return errorResponse(err, txLog, { requestId })
      }
    }

    const now = new Date().toISOString()
    const paidAmount = transaction.amount

    const newPaidAmount = Math.round(((invoice.paid_amount || 0) + paidAmount) * 100) / 100
    const currentRemaining = invoice.remaining_amount ?? (invoice.total - (invoice.paid_amount || 0))
    const newRemaining = Math.max(0, Math.round((currentRemaining - paidAmount) * 100) / 100)
    const isFullyPaid = newRemaining <= 0
    const newStatus = isFullyPaid ? 'paid' : 'partially_paid'

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'
    const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

    let journalEntryId: string | null = null
    let journalEntryError: string | null = null

    try {
      if (accountingMethod === 'cash' && isFullyPaid) {
        const journalEntry = await createInvoiceCashEntry(
          supabase, companyId, user.id, invoice as Invoice, transaction.date,
          entityType, invoice.customer?.name,
        )
        journalEntryId = journalEntry?.id ?? null
      } else {
        // Accrual or cash partial: clearing entry against 1510. The cash-method
        // partial path is intentional — under kontantmetoden 1510 has no prior
        // balance, so this leaves a credit on 1510 that gets resolved when the
        // final payment lands and createInvoiceCashEntry runs.
        const journalEntry = await createInvoicePaymentJournalEntry(
          supabase, companyId, user.id, invoice as Invoice, transaction.date,
          undefined, invoice.customer?.name, paidAmount,
        )
        journalEntryId = journalEntry?.id ?? null
      }
    } catch (err) {
      // AccountsNotInChart is fatal so the UI can open the activation dialog.
      if (err instanceof AccountsNotInChartError) {
        return errorResponse(err, txLog, { requestId })
      }
      txLog.error('failed to create payment journal entry', err as Error)
      // Other errors are recorded but don't abort the match — the user can
      // re-book the verifikation manually.
      if (isBookkeepingError(err)) {
        journalEntryError = getErrorMessage(err, { context: 'invoice' })
      } else {
        journalEntryError = err instanceof Error ? err.message : 'Unknown error'
      }
    }

    // Underlag for the payment verifikation: re-attach the invoice PDF that
    // was archived on send to the new payment journal entry. document_
    // attachments.journal_entry_id is one-to-one, so we insert a parallel
    // row pointing at the same storage_path. Same WORM file, second JE
    // pointer — no copy, no schema change. Non-blocking (BFL 7 kap audit
    // gap, but the bank line + invoice still exist as evidence).
    if (journalEntryId && invoice.journal_entry_id) {
      try {
        const { data: invoiceDoc } = await supabase
          .from('document_attachments')
          .select('storage_path, file_name, file_size_bytes, mime_type, sha256_hash')
          .eq('journal_entry_id', invoice.journal_entry_id)
          .eq('company_id', companyId)
          .eq('is_current_version', true)
          .limit(1)
          .maybeSingle()
        if (invoiceDoc) {
          // Destructure error: Supabase client returns { data, error } on
          // postgres-level failures (unique constraint, RLS reject) instead
          // of throwing, so the surrounding try/catch only covers thrown
          // JS exceptions. Log via warn so attachment failures are visible
          // in logs even though we don't abort the match.
          const { error: attachErr } = await supabase.from('document_attachments').insert({
            user_id: user.id,
            company_id: companyId,
            uploaded_by: user.id,
            upload_source: 'system',
            storage_path: invoiceDoc.storage_path,
            file_name: invoiceDoc.file_name,
            file_size_bytes: invoiceDoc.file_size_bytes,
            mime_type: invoiceDoc.mime_type,
            sha256_hash: invoiceDoc.sha256_hash,
            journal_entry_id: journalEntryId,
          })
          if (attachErr) {
            txLog.warn('failed to attach invoice PDF to payment journal entry', {
              attachError: attachErr.message,
              paymentJournalEntryId: journalEntryId,
              invoiceJournalEntryId: invoice.journal_entry_id,
            })
          }
        }
      } catch (err) {
        txLog.warn('failed to attach invoice PDF to payment journal entry', err as Error)
      }
    }

    // Optimistic lock: only update if invoice is still in a matchable state.
    const { data: updatedRows, error: updateInvError } = await supabase
      .from('invoices')
      .update({
        status: newStatus,
        paid_at: isFullyPaid ? now : null,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
      })
      .eq('id', invoice_id)
      .in('status', ['sent', 'overdue', 'partially_paid'])
      .select('id')

    if (updateInvError) {
      txLog.error('failed to update invoice status', updateInvError)
      return errorResponse(updateInvError, txLog, { requestId })
    }

    if (!updatedRows || updatedRows.length === 0) {
      return errorResponseFromCode('MATCH_INVOICE_ALREADY_PAID', txLog, { requestId })
    }

    const paymentNotes = (accountingMethod === 'cash' && !isFullyPaid)
      ? 'Kontantmetoden: intäkt bokförs vid slutbetalning'
      : null

    const { error: paymentInsertError } = await supabase
      .from('invoice_payments')
      .insert({
        user_id: user.id,
        company_id: companyId,
        invoice_id,
        payment_date: transaction.date,
        amount: paidAmount,
        currency: invoice.currency,
        exchange_rate: invoice.exchange_rate,
        journal_entry_id: journalEntryId,
        transaction_id: transactionId,
        notes: paymentNotes,
      })

    if (paymentInsertError) {
      if (paymentInsertError.code === '23505') {
        return errorResponseFromCode('MATCH_INVOICE_DUPLICATE_PAYMENT', txLog, { requestId })
      }
      txLog.error('failed to record invoice payment', paymentInsertError)
      return errorResponseFromCode('MATCH_INVOICE_RECORD_PAYMENT_FAILED', txLog, { requestId })
    }

    const { error: updateTxError } = await supabase
      .from('transactions')
      .update({
        invoice_id: invoice_id,
        potential_invoice_id: null,
        journal_entry_id: journalEntryId,
        is_business: true,
        category: 'income_services',
      })
      .eq('id', transactionId)

    if (updateTxError) {
      txLog.error('failed to link transaction to invoice', updateTxError)
      return errorResponseFromCode('MATCH_INVOICE_LINK_TX_FAILED', txLog, { requestId })
    }

    logMatchEvent(supabase, user.id, transactionId, 'matched', {
      invoiceId: invoice_id,
      matchConfidence: 1.0,
      matchMethod: 'manual_confirm',
      newState: { status: newStatus, paid_amount: newPaidAmount, remaining_amount: newRemaining },
    })

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

    if (journalEntryError) {
      txLog.warn('match recorded but payment journal entry failed', {
        errorCode: 'MATCH_INVOICE_PARTIAL',
        message: journalEntryError,
      })
    }

    return NextResponse.json({
      success: true,
      invoice_status: newStatus,
      paid_at: isFullyPaid ? now : null,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      journal_entry_id: journalEntryId,
      journal_entry_error: journalEntryError,
      category: 'income_services',
    })
  },
  { requireWrite: true },
)
