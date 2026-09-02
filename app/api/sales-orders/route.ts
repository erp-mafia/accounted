import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { CreateSalesOrderSchema, SalesOrderListQuerySchema } from '@/lib/api/schemas'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { maskEmbeddedCustomer } from '@/lib/customers/protect-personal-number'
import { decorate, fetchInvoicedQuantities } from '@/lib/sales-orders/load'
import { createSalesOrder } from '@/lib/sales-orders/write'
import { serviceFailureResponse } from '@/lib/sales-orders/respond'
import { errorResponse } from '@/lib/errors/get-structured-error'
import type { SalesOrder } from '@/types'

ensureInitialized()

/**
 * GET /api/sales-orders: the company's kundorder with customer, lines and
 * the derived delivery/invoicing progress. Filters: status, customer_id, q
 * (order number or customer name).
 */
export const GET = withRouteContext('sales_order.list', async (request, { supabase, companyId, log, requestId }) => {
  const query = validateQuery(request, SalesOrderListQuerySchema)
  if (!query.success) return query.response
  const { status, customer_id, q } = query.data

  let orders: SalesOrder[]
  try {
    orders = await fetchAllRows<SalesOrder>(({ from, to }) => {
      let qb = supabase
        .from('sales_orders')
        .select('*, customer:customers(id, name, customer_number, customer_type), items:sales_order_items(*)')
        .eq('company_id', companyId)
      if (status) qb = qb.eq('status', status)
      if (customer_id) qb = qb.eq('customer_id', customer_id)
      if (q) qb = qb.ilike('order_number', `%${q}%`)
      return qb.order('order_date', { ascending: false }).order('created_at', { ascending: false }).range(from, to)
    })
  } catch (err) {
    return errorResponse(err, log, { requestId })
  }

  const invoiced = await fetchInvoicedQuantities(supabase, orders.map((o) => o.id))
  if (!invoiced.ok) return errorResponse(invoiced.dbError, log, { requestId })

  const data = orders.map((o) => decorate(maskEmbeddedCustomer(o), invoiced.byItem))
  return NextResponse.json({ data })
})

/** POST /api/sales-orders: create a draft order with lines. */
export const POST = withRouteContext(
  'sales_order.create',
  async (request, { supabase, user, companyId, log, requestId }) => {
    const validation = await validateBody(request, CreateSalesOrderSchema, { log, operation: 'sales_order.create' })
    if (!validation.success) return validation.response

    const result = await createSalesOrder(supabase, { companyId, userId: user.id, input: validation.data })
    if (!result.ok) return serviceFailureResponse(result, log, requestId)
    return NextResponse.json({ data: result.order }, { status: 201 })
  },
  { requireWrite: true },
)
