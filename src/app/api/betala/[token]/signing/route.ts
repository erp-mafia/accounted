import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { resolveRequestAppOrigin } from '@/lib/domains/trusted-app-origin'
import { sessionFailureResponse } from '@/lib/operations/session'
import { startPaymentSigning } from '@/lib/payments/orders/signing'
import { typedPersonalNumber, withSigningLinkToken } from '@/lib/payments/orders/signing-link-route'
import { loadSigningLinkBasket, recordSigningLinkBatch } from '@/lib/payments/orders/signing-links'

// One bank call per payment (up to 100), a basket and BankID, as the session
// route: a function cut off mid-signing leaves its orders in payment with an
// unknown outcome, never failed (lib/payments/orders/signing.ts).
export const maxDuration = 300

/**
 * The session route's body without the orders: the link names them. The
 * personnummer is required (the firmatecknare has nothing on file, and the
 * sender's number must never name their BankID).
 */
const StartSchema = z.object({
  /** BankID in our screen (same_device, qr) or on the bank's own page (redirect); a bank that signs only there gets redirect whatever is asked. */
  method: z.enum(['same_device', 'qr', 'redirect']),
  personal_number: z.string().max(20).nullish(),
})

/**
 * POST /api/betala/:token/signing: send the link's payments to the bank and
 * start BankID for the firmatecknare, through the same startPaymentSigning as
 * POST /api/payments/signing, acting as the sender for the company of the
 * link. Refused with PAYMENT_SIGNING_LINK_ORDERS_CHANGED when any order left
 * 'approved' since the link was made: nothing is signed then. A bank that
 * signs on its own page sends the browser back to this link.
 */
export const POST = withSigningLinkToken<{ token: string }>('payment_signing.start', { stage: 'open' }, async (request, { link, service, op, log, requestId, signer, signerRequired, returnPath }) => {
  const validation = await validateBody(request, StartSchema)
  if (!validation.success) return validation.response
  const personalNumber = typedPersonalNumber(validation.data.personal_number)
  if (!personalNumber) return signerRequired()
  const basket = await loadSigningLinkBasket(service, link)
  if (basket.state !== 'ready') {
    return sessionFailureResponse({ ok: false, code: 'PAYMENT_SIGNING_LINK_ORDERS_CHANGED', details: { state: basket.state } }, log, requestId)
  }
  const outcome = await startPaymentSigning(op, {
    orderIds: link.order_ids,
    method: validation.data.method,
    signer: signer(personalNumber),
    returnOrigin: await resolveRequestAppOrigin(request, { onLookupFailure: 'canonical' }),
    returnPath,
  })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  // The signing is the link's from now on: a reopened link resumes it. A
  // failed write costs nothing the poll cannot recover (signingBelongsToLink).
  await recordSigningLinkBatch(service, link.id, outcome.data.batch_id).catch((error) =>
    log.warn('payment signing link batch not recorded', { message: error instanceof Error ? error.message : String(error) }),
  )
  return NextResponse.json({ data: outcome.data })
})
