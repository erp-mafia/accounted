import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { VoucherCandidatesQuerySchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { findMatchingVouchersForInvoice } from '@/lib/invoices/voucher-matching'
import { parseVoucherNumber } from '@/lib/invoices/voucher-label'
import type { Invoice, Customer } from '@/types'
import { isMatchableInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'

/**
 * GET /api/invoices/[id]/voucher-candidates
 *
 * Returns posted verifikat candidates that could be linked as payment for
 * this invoice. Used by the "Befintlig verifikation" tab in
 * PaymentBookingDialog to auto-suggest matches.
 *
 * A person picks here, so a verifikat that settles several invoices is
 * offered too, with what it has left after the invoices already linked to it
 * (crm#1434): such a candidate carries `link_amount`, the share the dialog
 * proposes, and `already_linked` when other invoices use part of it.
 *
 * `?voucher=A17` returns only the verifikat named by that number, at any
 * date: a konstaterad kundförlust or a late payment can be booked long after
 * the due-date window the suggestions search.
 */
export const GET = withRouteContext(
  'invoice.voucher_candidates',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const query = validateQuery(request, VoucherCandidatesQuerySchema, {
      log,
      operation: 'invoice.voucher_candidates',
    })
    if (!query.success) return query.response
    const voucherText = query.data.voucher
    const voucher = voucherText ? parseVoucherNumber(voucherText) : null

    // Project only the fields the matcher actually reads. Avoids leaking the
    // full customer row (address, contact, etc.) into the API response.
    const { data: invoice, error } = await supabase
      .from('invoices')
      .select(
        'id, invoice_number, status, currency, total, paid_amount, remaining_amount, due_date, paid_at, exchange_rate, journal_entry_id, customer_id, customer:customers(id, name)'
      )
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !invoice) {
      return errorResponseFromCode('LINK_VOUCHER_INVOICE_NOT_FOUND', log, { requestId })
    }

    if (!isMatchableInvoiceStatus(invoice.status)) {
      return NextResponse.json({ data: { candidates: [], invoice_status: invoice.status } })
    }

    // A search text that names no voucher number has nothing to look up.
    if (voucherText && !voucher) {
      return NextResponse.json({ data: { candidates: [] } })
    }

    const candidates = await findMatchingVouchersForInvoice(
      supabase,
      companyId,
      // Narrow projection above means TS infers `customer` as `{ id, name }[]`
      // from the join shorthand. The matcher only reads `customer?.name`, so
      // cast through unknown to the runtime shape it expects.
      invoice as unknown as Invoice & { customer?: Customer },
      { includeShared: true, ...(voucher ? { voucher } : {}) },
    )

    return NextResponse.json({ data: { candidates } })
  },
)
