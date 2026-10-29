import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { isUuid } from '@/lib/invariants/uuid'
import { sessionFailureResponse } from '@/lib/operations/session'
import { pollPaymentSigning } from '@/lib/payments/orders/signing'
import { typedPersonalNumber, withSigningLinkToken } from '@/lib/payments/orders/signing-link-route'
import { consumePaymentSigningLink, signingBelongsToLink, signingLinkDone } from '@/lib/payments/orders/signing-links'

// One status read per payment once the signing finalised (up to 100).
export const maxDuration = 300

/** The typed personnummer, so the bank sees the PSU on the poll too. On the link it is the only PSU there is. */
const PollSchema = z.object({
  personal_number: z.string().max(20).nullish(),
  /** Nordea Corporate Netbank: the signer's own logon id, when they use it. Sent with a Nordea signing only, never stored. */
  psu_authoriser_id: z.string().max(100).nullish(),
})

/**
 * POST /api/betala/:token/signing/:id/poll: where the firmatecknare's BankID
 * stands, once a second while it runs (fresh QR data while pending; each
 * payment's status once finalised). The same pollPaymentSigning as the
 * session poll; a POST, as there, so the personnummer never rides in a URL.
 * Only the link's own signing answers. A finalised signing consumes the link
 * (signingLinkDone: a failed second signature leaves it open for another
 * try); the poll keeps answering for the grace window after that. The poll has a
 * budget of its own in the token limiter.
 */
export const POST = withSigningLinkToken<{ token: string; id: string }>('payment_signing.poll', { stage: 'follow_up', limiter: 'poll' }, async (request, { link, service, op, log, requestId, signer, signerRequired }, { id }) => {
  if (!isUuid(id) || !(await signingBelongsToLink(service, link, id))) return sessionFailureResponse({ ok: false, code: 'NOT_FOUND' }, log, requestId)
  const validation = await validateBody(request, PollSchema)
  if (!validation.success) return validation.response
  const personalNumber = typedPersonalNumber(validation.data.personal_number)
  if (!personalNumber) return signerRequired()
  const outcome = await pollPaymentSigning(op, { batchId: id, signer: signer(personalNumber, validation.data.psu_authoriser_id) })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  if (!link.consumed_at && signingLinkDone(outcome.data)) {
    await consumePaymentSigningLink(service, link.id).catch((error) =>
      log.error('payment signing link not consumed after its signing finalised', error instanceof Error ? error : new Error(String(error))),
    )
  }
  return NextResponse.json({ data: outcome.data })
})
