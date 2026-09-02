import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateSalesOrderSchema } from '@/lib/api/schemas'
import { loadSalesOrder } from '@/lib/sales-orders/load'
import { hasOpenInvoices, updateSalesOrder } from '@/lib/sales-orders/write'
import { serviceFailureResponse } from '@/lib/sales-orders/respond'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

type Ctx = { params: Promise<{ id: string }> }

/** GET /api/sales-orders/[id]: one order with lines + derived quantities. */
export const GET = withRouteContext<Ctx>(
  'sales_order.get',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const result = await loadSalesOrder(supabase, companyId, id)
    if (!result.ok) return serviceFailureResponse(result, log, requestId)
    return NextResponse.json({ data: result.order })
  },
)

/** PATCH /api/sales-orders/[id]: edit header and/or replace lines (draft or confirmed). */
export const PATCH = withRouteContext<Ctx>(
  'sales_order.update',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, UpdateSalesOrderSchema, { log, operation: 'sales_order.update' })
    if (!validation.success) return validation.response

    const result = await updateSalesOrder(supabase, { companyId, orderId: id, input: validation.data })
    if (!result.ok) return serviceFailureResponse(result, log, requestId)
    return NextResponse.json({ data: result.order })
  },
  { requireWrite: true },
)

/**
 * DELETE /api/sales-orders/[id]: hard delete a draft or cancelled order
 * that no invoice was created from. Orders never book and carry no
 * sequence obligation, so nothing is lost; the RESTRICT FKs make a linked
 * order undeletable at the DB level regardless.
 */
export const DELETE = withRouteContext<Ctx>(
  'sales_order.delete',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const current = await loadSalesOrder(supabase, companyId, id)
    if (!current.ok) return serviceFailureResponse(current, log, requestId)
    if (current.order.status !== 'draft' && current.order.status !== 'cancelled') {
      return errorResponseFromCode('SALES_ORDER_INVALID_STATE', log, {
        requestId,
        details: { status: current.order.status, action: 'delete' },
      })
    }
    const open = await hasOpenInvoices(supabase, companyId, id)
    if (!open.ok) return errorResponse(open.dbError, log, { requestId })
    if (open.open) return errorResponseFromCode('SALES_ORDER_HAS_INVOICES', log, { requestId })

    const { error } = await supabase.from('sales_orders').delete().eq('id', id).eq('company_id', companyId)
    if (error) return errorResponse(error, log, { requestId })
    return NextResponse.json({ data: { id, deleted: true } })
  },
  { requireWrite: true },
)
