import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

/**
 * GET /api/rot-rut/payout-requests
 *
 * Request history (all statuses), newest first, with per-invoice items.
 */
export const GET = withRouteContext('rot_rut.requests.list', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx

  const { searchParams } = new URL(request.url)
  const typeFilter = searchParams.get('type')

  // Explicit projections: the history list needs identifiers and amounts,
  // not every column (and never customer ids through the invoice join).
  let query = supabase
    .from('rot_rut_payout_requests')
    .select(
      'id, name, deduction_type, status, requested_total, decided_total, file_name, file_document_id, ' +
        'created_at, submitted_at, decided_at, settlement_journal_entry_id, ' +
        'items:rot_rut_payout_request_items(id, invoice_id, requested_amount, decided_amount, ' +
        'invoice:invoices(id, invoice_number))',
    )
    .eq('company_id', companyId!)
    .order('created_at', { ascending: false })
    .limit(100)

  if (typeFilter === 'rot' || typeFilter === 'rut') {
    query = query.eq('deduction_type', typeFilter)
  }

  const { data, error } = await query
  if (error) {
    log.error('failed to list rot/rut payout requests', error)
    return errorResponse(error, log, { requestId })
  }

  return NextResponse.json({ data })
})
