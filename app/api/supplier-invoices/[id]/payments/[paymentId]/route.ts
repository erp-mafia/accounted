import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { unlinkSupplierInvoiceFromVoucher } from '@/lib/invoices/supplier-voucher-matching'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

type Params = { params: Promise<{ id: string; paymentId: string }> }

/**
 * DELETE /api/supplier-invoices/[id]/payments/[paymentId]
 *
 * Undoes a payment that only LINKS an existing verifikat to this invoice
 * (POST .../link-to-voucher, and the migration reconcile pass that uses the
 * same service). The payment row is removed and the invoice returns to its
 * payable state.
 *
 * Creates, changes and reverses nothing in the ledger: the link never wrote a
 * journal entry, so removing it is a subledger correction. A payment that DOES
 * have its own booked voucher is refused with
 * UNLINK_SI_PAYMENT_BOOKED_PAYMENT; reversing that entry (storno) is the path
 * there, and it already restores the invoice through
 * syncInvoiceStatusFromPaymentEntry.
 */
export const DELETE = withRouteContext<Params>(
  'supplier_invoice.unlink_payment',
  async (_request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id, paymentId } = await params
    const opLog = log.child({ supplierInvoiceId: id, paymentId })

    const outcome = await unlinkSupplierInvoiceFromVoucher(supabase, user.id, companyId, {
      supplierInvoiceId: id,
      paymentId,
    })

    if (!outcome.ok) {
      return errorResponseFromCode(outcome.code, opLog, {
        requestId,
        details: outcome.details,
      })
    }

    return NextResponse.json({
      data: {
        supplier_invoice_id: outcome.result.supplierInvoiceId,
        journal_entry_id: outcome.result.journalEntryId,
        payment_amount: outcome.result.paymentAmount,
        invoice_status: outcome.result.invoiceStatus,
        paid_amount: outcome.result.paidAmount,
        remaining_amount: outcome.result.remainingAmount,
      },
    })
  },
  { requireWrite: true },
)
