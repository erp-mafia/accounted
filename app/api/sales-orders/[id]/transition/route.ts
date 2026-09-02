import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SalesOrderTransitionSchema } from '@/lib/api/schemas'
import { transitionSalesOrder } from '@/lib/sales-orders/transitions'
import { serviceFailureResponse } from '@/lib/sales-orders/respond'

ensureInitialized()

/** POST /api/sales-orders/[id]/transition: confirm | cancel | reopen. */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'sales_order.transition',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, SalesOrderTransitionSchema, { log, operation: 'sales_order.transition' })
    if (!validation.success) return validation.response

    const result = await transitionSalesOrder(supabase, { companyId, orderId: id, action: validation.data.action })
    if (!result.ok) return serviceFailureResponse(result, log, requestId)
    return NextResponse.json({ data: result.order })
  },
  { requireWrite: true },
)
