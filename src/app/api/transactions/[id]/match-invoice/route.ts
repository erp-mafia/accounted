import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { DashboardMatchInvoiceSchema } from '@/lib/api/schemas'
import { bookCustomerBankMatch } from '@/lib/invoices/book-customer-bank-match'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/transactions/[id]/match-invoice
 *
 * Match an income row to a customer invoice: a person confirms a suggestion
 * in the match dialog. The booking itself (the guards, the verifikat, the row
 * and invoice compare-and-sets, the payment row, the invoice PDF, the log and
 * the events) is bookCustomerBankMatch, shared with the v1 door and the
 * approval of a staged match. A row that is already booked answers 409
 * MATCH_INVOICE_TX_ALREADY_BOOKED, naming the verifikat and how to undo it
 * first; nothing here reverses anything.
 */
export const POST = withRouteContext(
  'transaction.match_invoice',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, DashboardMatchInvoiceSchema, {
      log,
      operation: 'transaction.match_invoice',
    })
    if (!validation.success) return validation.response
    const {
      invoice_id,
      force,
      expected_journal_entry_id,
      lines,
      manual_exchange_rate,
      overpayment_account,
      overpayment_amount,
      fee_account,
      fee_amount,
    } = validation.data

    const txLog = log.child({ transactionId, invoiceId: invoice_id })

    const outcome = await bookCustomerBankMatch(
      { supabase, companyId: companyId!, userId: user.id, log: txLog },
      {
        transactionId,
        invoiceId: invoice_id,
        customLines: lines,
        manualExchangeRate: manual_exchange_rate,
        overpaymentAccount: overpayment_account,
        overpaymentAmount: overpayment_amount,
        feeAccount: fee_account,
        feeAmount: fee_amount,
        force,
        expectedJournalEntryId: expected_journal_entry_id,
        overrideVia: 'dashboard_force',
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, txLog, requestId)

    return NextResponse.json({
      success: true,
      invoice_status: outcome.invoiceStatus,
      paid_at: outcome.paidAt,
      paid_amount: outcome.paidAmount,
      remaining_amount: outcome.remainingAmount,
      journal_entry_id: outcome.journalEntryId,
      // Always null since a failed voucher aborts the whole match; the field
      // survives for response-shape compatibility with existing callers.
      journal_entry_error: null,
      category: outcome.category,
      // The sale verifikat this match booked first (defer_invoice_booking).
      ...(outcome.saleJournalEntryId ? { sale_journal_entry_id: outcome.saleJournalEntryId } : {}),
      ...(outcome.saleWarnings.length > 0
        ? { warnings: outcome.saleWarnings.map((w) => ({ code: w.code, message: w.message_sv })) }
        : {}),
    })
  },
  { requireWrite: true },
)
