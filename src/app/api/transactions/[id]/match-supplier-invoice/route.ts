import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { MatchSupplierInvoiceSchema } from '@/lib/api/schemas'
import { bookSupplierBankMatch } from '@/lib/invoices/book-supplier-bank-match'
import type { SupplierInvoice } from '@/types'

/**
 * POST /api/transactions/[id]/match-supplier-invoice
 *
 * Match a negative transaction (expense) to a supplier invoice: a person
 * confirms a suggestion. The booking itself (the booked-row gate, plan,
 * verifikat, ledger update, payment row, link, log, events) is
 * bookSupplierBankMatch, shared with the v1 door, the Inkorg and the debit of
 * a bank payment order. A deferring company's unbooked invoice is booked
 * first there, by the Bokför step. A row that is already booked answers 409
 * MATCH_SI_TX_ALREADY_BOOKED; the dialog then offers to reverse the row's own
 * categorization and resends with storno_existing.
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
    const { supplier_invoice_id, lines: customLines, storno_existing } = validation.data

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

    const outcome = await bookSupplierBankMatch(supabase, {
      transaction,
      invoice: invoice as SupplierInvoice,
      userId: user.id,
      companyId: companyId!,
      log: txLog,
      customLines,
      match: { action: 'matched', method: 'manual_confirm', confidence: 1.0 },
      linkBasis: { basis: 'user_confirmed' },
      // Sent only by the dialog's "Återför och matcha", after a refusal named the verifikat.
      stornoExisting: storno_existing,
    })
    if (!outcome.ok) {
      if (outcome.error !== undefined) return errorResponse(outcome.error, txLog, { requestId })
      return errorResponseFromCode(
        outcome.code,
        txLog,
        outcome.details ? { requestId, details: outcome.details } : { requestId },
      )
    }

    return NextResponse.json({
      success: true,
      invoice_status: outcome.plan.newStatus,
      paid_amount: outcome.plan.newPaidAmount,
      remaining_amount: outcome.plan.newRemaining,
      journal_entry_id: outcome.journalEntryId,
      // The registration verifikat this match booked first, when it did.
      ...(outcome.registrationJournalEntryId
        ? { registration_journal_entry_id: outcome.registrationJournalEntryId }
        : {}),
    })
  },
  { requireWrite: true },
)
