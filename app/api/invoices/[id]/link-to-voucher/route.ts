import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { LinkInvoiceToVoucherSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { linkInvoiceToVoucher } from '@/lib/invoices/voucher-matching'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

/**
 * POST /api/invoices/[id]/link-to-voucher
 *
 * Marks an invoice as paid by linking an existing posted verifikat whose
 * lines already credit AR (1510). Creates no new journal entry: only an
 * invoice_payments row + invoice status advance.
 *
 * Rejects with LINK_VOUCHER_NO_AR_CREDIT for vouchers that book income
 * directly (e.g. 1930→3001): those require gnubok_correct_entry first.
 */
export const POST = withRouteContext(
  'invoice.link_to_voucher',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ invoiceId: id })

    const validation = await validateBody(request, LinkInvoiceToVoucherSchema, {
      log: opLog,
      operation: 'invoice.link_to_voucher',
    })
    if (!validation.success) return validation.response
    const { journal_entry_id, notes } = validation.data

    // Only a faktura carries a receivable to settle: proformas, delivery notes
    // and quotes are refused before the RPC (which validates status, not
    // document type). A missing row falls through to the RPC's own 404.
    const { data: docRow } = await supabase
      .from('invoices')
      .select('document_type')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()
    const docType = (docRow as { document_type?: string | null } | null)?.document_type
    if (docType && docType !== 'invoice') {
      return errorResponseFromCode('MATCH_INVOICE_NOT_INVOICE_TYPE', opLog, {
        requestId,
        details: { documentType: docType },
      })
    }

    const outcome = await linkInvoiceToVoucher(supabase, user.id, companyId, {
      invoiceId: id,
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
