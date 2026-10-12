import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { LinkSupplierInvoiceToVoucherSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { linkSupplierInvoiceToVoucher } from '@/lib/invoices/supplier-voucher-matching'

/**
 * POST /api/supplier-invoices/[id]/link-to-voucher
 *
 * Marks a supplier invoice as paid (or partially paid) by linking an existing
 * posted verifikat that already carries its settlement: a 244x debit, or, for
 * a kontantmetod company's invoice with no registration verifikat, a 19xx
 * credit (the side is decided by supplier_invoice_settlement_side, inside the
 * RPC). Creates no new journal entry: only a supplier_invoice_payments row +
 * invoice status advance.
 *
 * Rejects with LINK_SI_VOUCHER_NO_AP_DEBIT / LINK_SI_VOUCHER_NO_BANK_CREDIT
 * for a voucher without that side.
 *
 * `amount` states the share of the voucher that is this invoice's when the
 * voucher pays several debts; the rest of it stays available
 * (`voucher_remaining`). Without it a voucher that has more left than the
 * invoice needs is refused with LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING.
 */
export const POST = withRouteContext(
  'supplier_invoice.link_to_voucher',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierInvoiceId: id })

    const validation = await validateBody(request, LinkSupplierInvoiceToVoucherSchema, {
      log: opLog,
      operation: 'supplier_invoice.link_to_voucher',
    })
    if (!validation.success) return validation.response
    const { journal_entry_id, notes, amount } = validation.data

    const outcome = await linkSupplierInvoiceToVoucher(supabase, user.id, companyId, {
      supplierInvoiceId: id,
      journalEntryId: journal_entry_id,
      notes,
      amount,
    })

    if (!outcome.ok) {
      return errorResponseFromCode(outcome.code, opLog, {
        requestId,
        details: outcome.details,
      })
    }

    return NextResponse.json({
      data: {
        invoice_status: outcome.result.invoiceStatus,
        paid_amount: outcome.result.paidAmount,
        remaining_amount: outcome.result.remainingAmount,
        payment_amount: outcome.result.paymentAmount,
        payment_id: outcome.result.paymentId,
        journal_entry_id: outcome.result.journalEntryId,
        voucher_remaining: outcome.result.voucherRemaining,
        reconciled_transaction_id: outcome.result.reconciledTransactionId,
      },
    })
  },
  { requireWrite: true },
)
