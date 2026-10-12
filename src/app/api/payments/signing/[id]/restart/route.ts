import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'
import { restartPaymentSigning } from '@/lib/payments/orders/signing'

// One bank call per payment (up to 100), a basket and BankID: set the limit
// explicitly. A function cut off mid-signing leaves its orders in payment with
// an unknown outcome, never failed (lib/payments/orders/signing.ts).
export const maxDuration = 300

const RestartSchema = z.object({
  method: z.enum(['same_device', 'qr']),
  personal_number: z.string().max(20).nullish(),
})

/** POST /api/payments/signing/:id/restart: start BankID again after an abandoned or timed-out signing. */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'payment_signing.restart',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, RestartSchema)
    if (!validation.success) return validation.response
    const outcome = await restartPaymentSigning(
      { supabase, companyId, userId: user.id, log },
      { batchId: id, method: validation.data.method, signer: signerFromRequest(request, validation.data.personal_number) },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
