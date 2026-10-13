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
 * confirms a suggestion. The booking itself (plan, verifikat, ledger update,
 * payment row, link, log, events) is bookSupplierBankMatch, shared with the
 * debit of a bank payment order, which books without this door.
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

    const outcome = await bookSupplierBankMatch(supabase, {
      transaction,
      invoice: invoice as SupplierInvoice,
      userId: user.id,
      companyId: companyId!,
      log: txLog,
      customLines,
      match: { action: 'matched', method: 'manual_confirm', confidence: 1.0 },
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
    })
  },
  { requireWrite: true },
)
