import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { LinkSupplierInvoiceToVoucherSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { linkSupplierInvoiceToVoucher } from '@/lib/invoices/supplier-voucher-matching'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

/**
 * POST /api/supplier-invoices/[id]/link-to-voucher
 *
 * Marks a supplier invoice as paid (or partially paid) by linking an existing
 * posted verifikat whose lines already debit AP (2440). Creates no new journal
 * entry: only a supplier_invoice_payments row + invoice status advance.
 *
 * Rejects with LINK_SI_VOUCHER_NO_AP_DEBIT for vouchers that book the expense
 * directly without going through 2440: those require gnubok_correct_entry first.
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
    const { journal_entry_id, notes } = validation.data

    const outcome = await linkSupplierInvoiceToVoucher(supabase, user.id, companyId, {
      supplierInvoiceId: id,
      journalEntryId: journal_entry_id,
      notes,
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
        reconciled_transaction_id: outcome.result.reconciledTransactionId,
      },
    })
  },
  { requireWrite: true },
)
