import { bankBookingContext } from '@/lib/bookkeeping/bank-booking-context'
import { NextResponse } from 'next/server'
import { createSupplierBankMatchEntry } from '@/lib/bookkeeping/supplier-bank-match-entry'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { planSupplierBankMatch } from '@/lib/invoices/apply-supplier-payment'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { anchorSupplierInvoiceDocument } from '@/lib/core/documents/supplier-invoice-underlag'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { MatchSupplierInvoiceSchema } from '@/lib/api/schemas'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import type { SupplierInvoice, Transaction } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

/**
 * POST /api/transactions/[id]/match-supplier-invoice
 *
 * Match a negative transaction (expense) to a supplier invoice.
 */
export const POST = withRouteContext(
  'transaction.match_supplier_invoice',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, MatchSupplierInvoiceSchema, {
      log,
      operation: 'transaction.match_supplier_invoice',
    })
    if (!validation.success) return validation.response
    const { supplier_invoice_id, lines: customLines } = validation.data

    const txLog = log.child({ transactionId, supplierInvoiceId: supplier_invoice_id })

    const { data: transaction, error: fetchTxError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()

    if (fetchTxError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', txLog, { requestId })
    }

    if (transaction.amount >= 0) {
      return errorResponseFromCode('MATCH_SI_NOT_EXPENSE', txLog, {
        requestId,
        details: { amount: transaction.amount },
      })
    }

    if (transaction.supplier_invoice_id) {
      return errorResponseFromCode('MATCH_SI_TX_ALREADY_LINKED', txLog, {
        requestId,
        details: { existingSupplierInvoiceId: transaction.supplier_invoice_id },
      })
    }

    const { data: invoice, error: fetchInvError } = await supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
      .eq('id', supplier_invoice_id)
      .eq('company_id', companyId)
      .single()

    if (fetchInvError || !invoice) {
      return errorResponseFromCode('MATCH_SI_NOT_FOUND', txLog, { requestId })
    }

    if (invoice.status === 'paid' || invoice.status === 'credited') {
      return errorResponseFromCode('MATCH_SI_ALREADY_PAID', txLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'

    // Credit the cash account THIS transaction actually belongs to, never a
    // company-wide "last used" preference: last_supplier_payment_account is
    // written by the manual mark-paid flow (e.g. a private-funds payment
    // booked to 2893) and has no relationship to which bank account a real,
    // matched transaction settled from. Reusing it here silently misbooked a
    // genuine 1930 bank payment to 2893 once a private payment had set that
    // sticky default.
    const paymentAccount = await resolveSettlementAccount(
      supabase,
      companyId!,
      transaction.cash_account_id,
      txLog,
    )

    // One payment plan for every door that matches a bank row to a supplier
    // invoice (this POST, its preview and the v1 POST): the bank fee split
    // (6570), the overshoot guard, öresavrundning (3740), the SEK and
    // kursdifferens resolution and the kontantmetoden refusals. User-edited
    // lines are not exempt: the ledger update below comes from this plan.
    // Refusing here, BEFORE any JE is created, keeps a doomed match from
    // burning a voucher number.
    const planned = planSupplierBankMatch({ invoice, transaction, accountingMethod })
    if (!planned.ok) {
      return errorResponseFromCode(planned.code, txLog, { requestId, details: planned.details })
    }
    const { plan } = planned

    // Verifikat header description for user-edited lines; the entry generators
    // below write their own.
    const desc = invoice.supplier?.name
      ? `Utbetalning leverantörsfaktura ${invoice.supplier_invoice_number}, ${invoice.supplier.name}`
      : `Utbetalning leverantörsfaktura ${invoice.supplier_invoice_number}`

    // One open-period gate for every booking shape below: the entry generators
    // only return null for a date outside an open period, which this route
    // could report as nothing better than a generic failure.
    const fiscalPeriodId = await findFiscalPeriod(supabase, companyId!, transaction.date)
    if (!fiscalPeriodId) {
      return errorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', txLog, {
        requestId,
        details: { paymentDate: transaction.date },
      })
    }

    let journalEntryId: string | null = null

    try {
      if (customLines) {
        const totalDebit = customLines.reduce((s, l) => s + l.debit_amount, 0)
        const totalCredit = customLines.reduce((s, l) => s + l.credit_amount, 0)
        if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
          return errorResponseFromCode('INVOICE_PAID_LINES_UNBALANCED', txLog, {
            requestId,
            details: { totalDebit, totalCredit },
          })
        }
        const sourceType = plan.booking.kind === 'cash' ? 'supplier_invoice_cash_payment' : 'supplier_invoice_paid'
        const journalEntry = await createJournalEntry(supabase, companyId!, user.id, {
          fiscal_period_id: fiscalPeriodId,
          entry_date: transaction.date,
          description: desc,
          source_type: sourceType,
          source_id: invoice.id,
          bank_booking_context: [bankBookingContext(transaction, paymentAccount)],
          lines: customLines,
        })
        if (journalEntry) journalEntryId = journalEntry.id
      } else {
        // The generator the plan names, with every input it carries (the 6570
        // fee and the 3740 SEK clearing debt included): the same call the v1
        // door books with, and the lines the preview shows.
        const journalEntry = await createSupplierBankMatchEntry(supabase, companyId!, user.id, {
          invoice: invoice as SupplierInvoice,
          booking: plan.booking,
          paymentAccount,
          transaction,
        })
        if (journalEntry) journalEntryId = journalEntry.id
      }
    } catch (err) {
      txLog.error('failed to create supplier invoice payment journal entry', err as Error)
      // A failed payment voucher must fail the whole match. Proceeding used to
      // mark the invoice paid with NO voucher: an unrecoverable half-state:
      // mark-paid rejects 'paid' invoices and this route rejects linked
      // transactions, so no flow could ever complete the booking afterwards.
      // The cash-method builder converts every leg through toSekOrThrow, so a
      // foreign invoice with no usable rate surfaces here as
      // SupplierInvoiceFxRateMissingError. Dispatch on its `code` (not
      // instanceof: the class is routinely vi.mock'ed away) so errorResponse
      // maps it to the registered 400 "ange fakturans växelkurs" entry instead
      // of a generic 500. Same code the preview returns for the same row.
      if ((err as { code?: unknown })?.code === 'SI_FX_RATE_MISSING') {
        return errorResponse(err, txLog, { requestId })
      }
      if (isBookkeepingError(err)) {
        return errorResponse(err, txLog, { requestId })
      }
      return errorResponseFromCode('MATCH_SI_JE_FAILED', txLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }

    if (!journalEntryId) {
      return errorResponseFromCode('MATCH_SI_JE_FAILED', txLog, { requestId })
    }

    // Ledger update from the plan computed up front. An öre-absorbed settlement
    // reports remaining 0 / status paid even though the bank paid a sub-krona
    // less (or more): the residual lives on 3740, not the supplier ledger.
    const { newRemaining, newPaidAmount, isFullyPaid, newStatus, settledAmount } = plan
    const paidAt = isFullyPaid ? paidAtFromDate(transaction.date) : null

    const { data: updatedRows, error: updateInvError } = await supabase
      .from('supplier_invoices')
      .update({
        status: newStatus,
        remaining_amount: newRemaining,
        paid_amount: newPaidAmount,
        paid_at: paidAt,
        payment_journal_entry_id: journalEntryId,
        transaction_id: transactionId,
      })
      .eq('id', supplier_invoice_id)
      .in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
      .select('id')

    if (updateInvError) {
      txLog.error('failed to update supplier invoice', updateInvError)
      return errorResponse(updateInvError, txLog, { requestId })
    }

    if (!updatedRows || updatedRows.length === 0) {
      // CAS guard: the invoice was settled by a concurrent request between
      // our read and write. The payment voucher we just posted belongs to no
      // payment: cancel it and document the gap (mirrors mark-paid).
      await cancelOrphanedPaymentEntry(
        supabase, companyId!, user.id, journalEntryId,
        'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
      )
      return errorResponseFromCode('MATCH_SI_NOT_OPEN', txLog, { requestId })
    }

    const { error: paymentInsertError } = await supabase
      .from('supplier_invoice_payments')
      .insert({
        user_id: user.id,
        company_id: companyId,
        supplier_invoice_id,
        payment_date: transaction.date,
        // Payment rows reconstruct and reverse paid_amount, so store the debt
        // settled, including any 3740 adjustment. Actual cash stays on the
        // linked bank transaction and the payment account's journal line.
        amount: settledAmount,
        currency: invoice.currency,
        journal_entry_id: journalEntryId,
        transaction_id: transactionId,
      })

    if (paymentInsertError) {
      if (paymentInsertError.code === '23505') {
        return errorResponseFromCode('MATCH_SI_DUPLICATE_PAYMENT', txLog, { requestId })
      }
      txLog.error('failed to record supplier invoice payment', paymentInsertError)
      return errorResponseFromCode('MATCH_SI_RECORD_PAYMENT_FAILED', txLog, { requestId })
    }

    // The invoice is now settled, so every OTHER transaction still carrying a
    // suggestion pointer at it is dead: retire them (issue #1259). This
    // request's own row is cleared by the update just below.
    if (isFullyPaid) {
      await clearSettledInvoiceSuggestions(
        supabase,
        companyId!,
        'supplier_invoice',
        supplier_invoice_id,
        { exceptTransactionId: transactionId },
      )
    }

    const { error: updateTxError } = await supabase
      .from('transactions')
      .update({
        supplier_invoice_id,
        // Clear the suggestion now that it is a confirmed link, mirroring the
        // customer-invoice route. Leaving it set kept a pointer at an invoice
        // this very request just marked paid, i.e. the stale-pointer state
        // every read path now has to defend against.
        potential_supplier_invoice_id: null,
        journal_entry_id: journalEntryId,
        is_business: true,
      })
      .eq('id', transactionId)

    if (updateTxError) {
      txLog.error('failed to link transaction to supplier invoice', updateTxError)
      return errorResponseFromCode('MATCH_SI_LINK_TX_FAILED', txLog, { requestId })
    }

    // Propagate a document pinned to the transaction (via /attach-document or
    // MCP) onto the payment verifikat, mirroring the categorize route (BFL
    // 5 kap 6 §: the verifikation must reference its underlag). Guarded to
    // unlinked current-version docs only: a doc already serving another
    // verifikat (e.g. the supplier invoice's own document on the registration
    // entry) must not move. Non-fatal: the match is already committed.
    if (transaction.document_id) {
      const { error: docLinkError } = await supabase
        .from('document_attachments')
        .update({ journal_entry_id: journalEntryId })
        .eq('id', transaction.document_id)
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .eq('is_current_version', true)
      if (docLinkError) {
        // Structured fields so the half-linked state (doc retained but not
        // anchored to the payment JE) can be reconstructed without an audit
        // trail dig.
        txLog.warn('failed to link transaction document to payment JE (non-critical)', {
          error: docLinkError,
          documentId: transaction.document_id,
          journalEntryId,
        })
      }
    }

    // Same requirement one table over: the SUPPLIER INVOICE's own retained
    // document must sit on a posted verifikat, or the payment verifikat we
    // just booked shows the invoice PDF while every missing-underlag surface
    // (which only accepts an anchored doc) warns "Underlag saknas". No-op when
    // it is already anchored, e.g. on the registration verifikat.
    await anchorSupplierInvoiceDocument(supabase, companyId, supplier_invoice_id)

    await logMatchEvent(supabase, user.id, transactionId, 'matched', {
      supplierInvoiceId: supplier_invoice_id,
      matchConfidence: 1.0,
      matchMethod: 'manual_confirm',
      newState: { status: newStatus, paid_amount: newPaidAmount, remaining_amount: newRemaining },
    })

    try {
      eventBus.emit({
        type: 'supplier_invoice.match_confirmed',
        payload: {
          supplierInvoice: {
            ...invoice,
            status: newStatus,
            remaining_amount: newRemaining,
            paid_amount: newPaidAmount,
            paid_at: paidAt,
            payment_journal_entry_id: journalEntryId,
            transaction_id: transactionId,
          } as SupplierInvoice,
          transaction: {
            ...transaction,
            supplier_invoice_id,
            potential_supplier_invoice_id: null,
            journal_entry_id: journalEntryId,
            is_business: true,
          } as Transaction,
          userId: user.id,
          companyId,
        },
      })
    } catch (err) {
      txLog.warn('supplier_invoice.match_confirmed event emission failed', err as Error)
    }

    return NextResponse.json({
      success: true,
      invoice_status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      journal_entry_id: journalEntryId,
    })
  },
  { requireWrite: true },
)
