import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { VoucherCandidatesQuerySchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { findMatchingVouchersForSupplierInvoice } from '@/lib/invoices/supplier-voucher-matching'
import { parseVoucherNumber } from '@/lib/invoices/voucher-label'
import { resolveSupplierSettlementSide } from '@/lib/invoices/supplier-settlement-side'
import type { Supplier, SupplierInvoice } from '@/types'
import { isMatchableSupplierInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'

/**
 * GET /api/supplier-invoices/[id]/voucher-candidates
 *
 * Returns posted verifikat candidates that could be linked as payment for
 * this supplier invoice. Used by the "Befintlig verifikation" tab in the
 * supplier-invoice mark-paid dialog to auto-suggest matches.
 *
 * `settlement_side` says which line of a voucher was searched: `ap_debit`
 * (244x debit) or `bank_credit` (19xx credit, a kontantmetod company's invoice
 * with no registration verifikat). The dialog words its intro and empty state
 * from it, so the screen never decides the side on its own.
 *
 * A person picks here, so vouchers that have more left than the invoice needs
 * are offered too (a payment of several debts): such a candidate carries
 * `link_amount`, the share the dialog proposes when it links it.
 *
 * `?voucher=A12` returns only the verifikat named by that number, at any
 * date, as on the customer side.
 */
export const GET = withRouteContext(
  'supplier_invoice.voucher_candidates',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const query = validateQuery(request, VoucherCandidatesQuerySchema, {
      log,
      operation: 'supplier_invoice.voucher_candidates',
    })
    if (!query.success) return query.response
    const voucherText = query.data.voucher
    const voucher = voucherText ? parseVoucherNumber(voucherText) : null

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

    const settlementSide = await resolveSupplierSettlementSide(supabase, companyId, id)

    if (!isMatchableSupplierInvoiceStatus(invoice.status)) {
      return NextResponse.json({
        data: {
          candidates: [],
          invoice_status: invoice.status,
          settlement_side: settlementSide.side,
        },
      })
    }

    // A search text that names no voucher number has nothing to look up.
    if (voucherText && !voucher) {
      return NextResponse.json({ data: { candidates: [], settlement_side: settlementSide.side } })
    }

    const candidates = await findMatchingVouchersForSupplierInvoice(
      supabase,
      companyId,
      // The narrow projection above means TS infers `supplier` as `{ id, name }[]`
      // from the join shorthand. The matcher only reads `supplier?.name`, so
      // cast through unknown to the runtime shape it expects.
      invoice as unknown as SupplierInvoice & { supplier?: Supplier },
      { settlementSide, includeShared: true, ...(voucher ? { voucher } : {}) },
    )

    return NextResponse.json({ data: { candidates, settlement_side: settlementSide.side } })
  },
)
