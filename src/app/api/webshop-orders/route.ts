import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { WebshopOrdersListQuerySchema } from '@/lib/api/schemas'
import { errorResponse } from '@/lib/errors/get-structured-error'

ensureInitialized()

const DEFAULT_LIMIT = 50

/**
 * List webshop order rows for the Orders page, with a store facet for the
 * per-shop filter. Refund rows are returned inline (they are independent
 * bookable rows) and grouped client-side under their parent.
 */
export const GET = withRouteContext(
  'webshop_order.list',
  async (request, { supabase, companyId, log, requestId }) => {
    const validation = validateQuery(request, WebshopOrdersListQuerySchema)
    if (!validation.success) return validation.response
    const { platform, store_scope, status, row_type, paid, booked } = validation.data
    const limit = validation.data.limit ?? DEFAULT_LIMIT
    const offset = validation.data.offset ?? 0

    let query = supabase
      .from('webshop_orders')
      .select('*', { count: 'exact' })
      .eq('company_id', companyId)
      .order('order_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (platform) query = query.eq('platform', platform)
    if (store_scope) query = query.eq('store_scope', store_scope)
    if (status) query = query.eq('status', status)
    if (row_type) query = query.eq('row_type', row_type)
    if (paid) query = query.eq('is_paid', paid === 'paid')
    // "Booked" counts every closed exit: booked via the integration OR
    // marked as manually booked outside it; "unbooked" is the open set the
    // Att bokfora tab shows, so a manual mark removes the row from it.
    if (booked === 'booked') {
      query = query.or('journal_entry_id.not.is.null,manually_booked_at.not.is.null')
    }
    if (booked === 'unbooked') {
      query = query.is('journal_entry_id', null).is('manually_booked_at', null)
    }

    const { data, error, count } = await query
    if (error) {
      log.error('failed to list webshop orders', error)
      return errorResponse(error, log, { requestId })
    }

    // Store facet for the filter dropdown: cheap distinct over the company's
    // stores (small cardinality; the select is capped defensively).
    const { data: facetRows, error: facetError } = await supabase
      .from('webshop_orders')
      .select('platform, store_scope, store_label')
      .eq('company_id', companyId)
      .eq('row_type', 'order')
      .order('store_scope')
      .limit(5000)
    if (facetError) {
      log.error('failed to build store facet', facetError)
      return errorResponse(facetError, log, { requestId })
    }
    const seen = new Set<string>()
    const stores: Array<{ platform: string; store_scope: string; store_label: string | null }> = []
    for (const row of facetRows ?? []) {
      const key = `${row.platform}:${row.store_scope}`
      if (seen.has(key)) continue
      seen.add(key)
      stores.push(row)
    }

    return NextResponse.json({ data: data ?? [], count, stores })
  },
)
