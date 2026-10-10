import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'
import { startPaymentSigning } from '@/lib/payments/orders/signing'

ensureInitialized()

// One bank call per payment (up to 100), a basket and BankID: set the limit
// explicitly. A function cut off mid-signing leaves its orders in payment with
// an unknown outcome, never failed (lib/payments/orders/signing.ts).
export const maxDuration = 300

const StartSchema = z.object({
  order_ids: z.array(z.uuid()).min(1).max(100),
  method: z.enum(['same_device', 'qr']),
  /** The signer's personnummer, when they have no BankID login on file. Never stored. */
  personal_number: z.string().max(20).nullish(),
})

/**
 * POST /api/payments/signing: send approved payments to the bank and start
 * BankID. Answers the challenge (QR data or an autostart token) the person
 * signs with; the browser then polls /api/payments/signing/:id/poll.
 * Browser-only by design: signing money out is the account holder's own act.
 */
export const POST = withRouteContext(
  'payment_signing.start',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, StartSchema)
    if (!validation.success) return validation.response
    const outcome = await startPaymentSigning(
      { supabase, companyId, userId: user.id, log },
      {
        orderIds: validation.data.order_ids,
        method: validation.data.method,
        signer: signerFromRequest(request, validation.data.personal_number),
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
