import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { unapprovePaymentOrders } from '@/lib/payments/orders/lifecycle'

ensureInitialized()

const UnapproveSchema = z.object({ order_ids: z.array(z.uuid()).min(1).max(100) })

/** POST /api/payments/orders/unapprove: back to draft so the payment can be edited (approved -> draft). */
export const POST = withRouteContext(
  'payment_orders.unapprove',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, UnapproveSchema)
    if (!validation.success) return validation.response
    const outcome = await unapprovePaymentOrders({ supabase, companyId, userId: user.id, log }, { orderIds: validation.data.order_ids })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
