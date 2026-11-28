import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { WebshopOrdersListQuerySchema } from '@/lib/api/schemas'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { BOOKED_EXITS_FILTER } from '@/lib/webshop-orders/booking-status'
import { listWebshopStores, type WebshopStore } from '@/lib/webshop-orders/stores'

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
    // "Booked" counts the exits that book: booked via the integration OR
    // marked as manually booked outside it, never a voided row (nothing was
    // booked); "unbooked" is the open set the Att bokfora tab shows, so a
    // manual mark, a void included, removes the row from it.
    if (booked === 'booked') {
      query = query.or(BOOKED_EXITS_FILTER)
    }
    if (booked === 'unbooked') {
      query = query.is('journal_entry_id', null).is('manually_booked_at', null)
    }

    const { data, error, count } = await query
    if (error) {
      log.error('failed to list webshop orders', error)
      return errorResponse(error, log, { requestId })
    }

    // Store facet for the filter dropdown: a distinct over the company's
    // stores, one read per store whatever the number of orders.
    let stores: WebshopStore[]
    try {
      stores = await listWebshopStores(supabase, companyId)
    } catch (facetError) {
      log.error('failed to build store facet', facetError)
      return errorResponse(facetError, log, { requestId })
    }

    return NextResponse.json({ data: data ?? [], count, stores })
  },
)
