import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { resolveRequestAppOrigin } from '@/lib/domains/trusted-app-origin'
import { sessionFailureResponse } from '@/lib/operations/session'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'
import { startPaymentSigning } from '@/lib/payments/orders/signing'

// One bank call per payment (up to 100), a basket and BankID: set the limit
// explicitly. A function cut off mid-signing leaves its orders in payment with
// an unknown outcome, never failed (lib/payments/orders/signing.ts).
export const maxDuration = 300

const StartSchema = z.object({
  order_ids: z.array(z.uuid()).min(1).max(100),
  /** BankID in our screen (same_device, qr) or on the bank's own page (redirect); a bank that signs only there gets redirect whatever is asked. */
  method: z.enum(['same_device', 'qr', 'redirect']),
  /** The signer's personnummer, when they have no BankID login on file. Never stored. */
  personal_number: z.string().max(20).nullish(),
  /** Nordea Corporate Netbank: the signer's own logon id, when they use it. Sent with a Nordea signing only, never stored. */
  psu_authoriser_id: z.string().max(100).nullish(),
})

/**
 * POST /api/payments/signing: send approved payments to the bank and start
 * BankID. Answers the challenge (QR data or an autostart token) the person
 * signs with; the browser then polls /api/payments/signing/:id/poll. For a
 * bank that signs on its own page the challenge carries redirectUrl; the
 * browser goes there and comes back to /payments?signing=<batch>.
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
        signer: signerFromRequest(request, validation.data.personal_number, validation.data.psu_authoriser_id),
        // Where a signing on the bank's own page comes back: the trusted app origin this request came to.
        returnOrigin: await resolveRequestAppOrigin(request, { onLookupFailure: 'canonical' }),
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
