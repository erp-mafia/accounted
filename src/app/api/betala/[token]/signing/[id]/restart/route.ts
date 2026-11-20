import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { resolveRequestAppOrigin } from '@/lib/domains/trusted-app-origin'
import { isUuid } from '@/lib/invariants/uuid'
import { sessionFailureResponse } from '@/lib/operations/session'
import { restartPaymentSigning } from '@/lib/payments/orders/signing'
import { typedPersonalNumber, withSigningLinkToken } from '@/lib/payments/orders/signing-link-route'
import { recordSigningLinkBatch, signingBelongsToLink } from '@/lib/payments/orders/signing-links'

// One bank call per payment (up to 100), a basket and BankID, as the session route.
export const maxDuration = 300

const RestartSchema = z.object({
  method: z.enum(['same_device', 'qr', 'redirect']),
  personal_number: z.string().max(20).nullish(),
  /** Nordea Corporate Netbank: the signer's own logon id, when they use it. Sent with a Nordea signing only, never stored. */
  psu_authoriser_id: z.string().max(100).nullish(),
})

/**
 * POST /api/betala/:token/signing/:id/restart: BankID again on a signing of
 * the link whose payments wait unsigned at the bank, through the same
 * restartPaymentSigning as the session restart (which re-reads each payment
 * at the bank and re-checks every invoice under lock). Only the link's own
 * signing; the typed personnummer is required. The signing may move to a new
 * batch over the same payments: the link follows it.
 */
export const POST = withSigningLinkToken<{ token: string; id: string }>('payment_signing.restart', { stage: 'open' }, async (request, { link, service, op, log, requestId, signer, signerRequired, returnPath }, { id }) => {
  if (!isUuid(id) || !(await signingBelongsToLink(service, link, id))) return sessionFailureResponse({ ok: false, code: 'NOT_FOUND' }, log, requestId)
  const validation = await validateBody(request, RestartSchema)
  if (!validation.success) return validation.response
  const personalNumber = typedPersonalNumber(validation.data.personal_number)
  if (!personalNumber) return signerRequired()
  const outcome = await restartPaymentSigning(op, {
    batchId: id,
    method: validation.data.method,
    signer: signer(personalNumber, validation.data.psu_authoriser_id),
    returnOrigin: await resolveRequestAppOrigin(request, { onLookupFailure: 'canonical' }),
    returnPath,
  })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  if (outcome.data.batch_id !== link.batch_id) {
    await recordSigningLinkBatch(service, link.id, outcome.data.batch_id).catch((error) =>
      log.warn('payment signing link batch not recorded', { message: error instanceof Error ? error.message : String(error) }),
    )
  }
  return NextResponse.json({ data: outcome.data })
})
