import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { cancelPaymentOrder } from '@/lib/payments/orders/lifecycle'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'

/** Nothing to send yet: the body is an empty JSON object. */
const CancelSchema = z.object({})

/**
 * POST /api/payments/orders/:id/cancel: cancel a bank payment. Before the
 * bank has it, it is cancelled here; after that only when the bank confirms.
 * An order whose bank outcome is unknown is resolved by a person instead
 * (POST /api/payments/orders/:id/resolve).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'payment_orders.cancel',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, CancelSchema)
    if (!validation.success) return validation.response
    const signer = signerFromRequest(request, null)
    const outcome = await cancelPaymentOrder(
      { supabase, companyId, userId: user.id, log },
      { orderId: id, signer: { ipAddress: signer.ipAddress, userAgent: signer.userAgent } },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
