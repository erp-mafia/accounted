import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { RegisterSalesOrderDeliverySchema } from '@/lib/api/schemas'
import { registerSalesOrderDelivery } from '@/lib/sales-orders/register-delivery'
import { serviceFailureResponse } from '@/lib/sales-orders/respond'

ensureInitialized()

/** POST /api/sales-orders/[id]/deliver: register cumulative delivered quantities. */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'sales_order.deliver',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, RegisterSalesOrderDeliverySchema, { log, operation: 'sales_order.deliver' })
    if (!validation.success) return validation.response

    const result = await registerSalesOrderDelivery(supabase, { companyId, orderId: id, input: validation.data })
    if (!result.ok) return serviceFailureResponse(result, log, requestId)
    return NextResponse.json({ data: result.order })
  },
  { requireWrite: true },
)
