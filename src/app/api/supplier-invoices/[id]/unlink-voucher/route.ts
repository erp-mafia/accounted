import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UnlinkSupplierInvoiceFromVoucherSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { unlinkSupplierInvoiceFromVoucher } from '@/lib/invoices/supplier-voucher-unlink'

/**
 * POST /api/supplier-invoices/[id]/unlink-voucher
 *
 * The undo of link-to-voucher: removes the payment row a link to an existing
 * verifikat wrote (`payment_id`) and gives the invoice its amount back, so an
 * invoice linked to the wrong verifikat becomes unpaid again. The verifikat
 * itself is not touched: no journal entry is created, changed or deleted.
 *
 * Only a plain link is taken back. A payment booked from a bank row, a
 * payment verifikat (storno it instead), a kvittning, a foreign-currency
 * invoice and the other cases unlink_supplier_invoice_from_voucher refuses
 * answer with their UNLINK_SI_VOUCHER_* code and change nothing.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.unlink_voucher',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierInvoiceId: id })

    const validation = await validateBody(request, UnlinkSupplierInvoiceFromVoucherSchema, {
      log: opLog,
      operation: 'supplier_invoice.unlink_voucher',
    })
    if (!validation.success) return validation.response

    const outcome = await unlinkSupplierInvoiceFromVoucher(supabase, user.id, companyId, {
      supplierInvoiceId: id,
      paymentId: validation.data.payment_id,
    })

    if (!outcome.ok) {
      return errorResponseFromCode(outcome.code, opLog, {
        requestId,
        details: outcome.details,
      })
    }

    return NextResponse.json({
      data: {
        payment_id: outcome.result.paymentId,
        journal_entry_id: outcome.result.journalEntryId,
        unlinked_amount: outcome.result.unlinkedAmount,
        invoice_status: outcome.result.invoiceStatus,
        paid_amount: outcome.result.paidAmount,
        remaining_amount: outcome.result.remainingAmount,
        document_on_voucher: outcome.result.documentOnVoucher,
      },
    })
  },
  { requireWrite: true },
)
