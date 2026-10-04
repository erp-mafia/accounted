import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { cancelPaymentOrder } from '@/lib/payments/orders/lifecycle'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'

ensureInitialized()

/**
 * POST /api/payments/orders/:id/cancel: cancel a bank payment. Before the
 * bank has it, it is cancelled here; after that only when the bank confirms.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'payment_orders.cancel',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
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
