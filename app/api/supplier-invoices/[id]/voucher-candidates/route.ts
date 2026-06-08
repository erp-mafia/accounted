import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { findMatchingVouchersForSupplierInvoice } from '@/lib/invoices/supplier-voucher-matching'
import type { Supplier, SupplierInvoice } from '@/types'

/**
 * GET /api/supplier-invoices/[id]/voucher-candidates
 *
 * Returns posted verifikat candidates that could be linked as payment for
 * this supplier invoice. Used by the "Befintlig verifikation" tab in the
 * supplier-invoice mark-paid dialog to auto-suggest matches.
 */
export const GET = withRouteContext(
  'supplier_invoice.voucher_candidates',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    // Project only the fields the matcher actually reads. Avoids leaking the
    // full supplier row (bank details, contact info, etc.) into the response.
    const { data: invoice, error } = await supabase
      .from('supplier_invoices')
      .select(
        'id, supplier_invoice_number, arrival_number, status, currency, total, paid_amount, remaining_amount, due_date, paid_at, exchange_rate, supplier_id, supplier:suppliers(id, name)',
      )
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !invoice) {
      return errorResponseFromCode('LINK_SI_VOUCHER_INVOICE_NOT_FOUND', log, { requestId })
    }

    if (!['registered', 'approved', 'overdue', 'partially_paid'].includes(invoice.status)) {
      return NextResponse.json({ data: { candidates: [], invoice_status: invoice.status } })
    }

    const candidates = await findMatchingVouchersForSupplierInvoice(
      supabase,
      companyId,
      // The narrow projection above means TS infers `supplier` as `{ id, name }[]`
      // from the join shorthand. The matcher only reads `supplier?.name`, so
      // cast through unknown to the runtime shape it expects.
      invoice as unknown as SupplierInvoice & { supplier?: Supplier },
    )

    return NextResponse.json({ data: { candidates } })
  },
)
