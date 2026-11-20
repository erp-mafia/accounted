import { NextResponse } from 'next/server'
import { z } from 'zod'
import { typedPersonalNumber, withInviteToken } from '@/lib/bank-feed/invite-route'
import { returnOriginFor } from '@/lib/bank-feed/request-return'
import { BANK_CONNECT_SIGNATORY_TARGET } from '@/lib/bank-feed/return-url'
import { restartBankFeedConsent } from '@/lib/bank-feed/service'
import { isUuid } from '@/lib/invariants/uuid'
import { sessionFailureResponse } from '@/lib/operations/session'

/** The method may come along (the row carries one); the typed personnummer must. The return page is always this link. */
const RestartSchema = z.object({
  method: z.enum(['same_device', 'qr', 'redirect']).nullish(),
  personal_number: z.string().max(20).nullish(),
  /** Nordea Corporate Netbank: the signer's own logon id, when they use it. Sent with a Nordea signing only, never stored. */
  psu_authoriser_id: z.string().max(100).nullish(),
})

async function readOptionalBody(request: Request): Promise<z.infer<typeof RestartSchema>> {
  const text = await request.text().catch(() => '')
  if (!text.trim()) return {}
  try {
    const parsed = RestartSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/**
 * POST /api/koppla/:token/connections/:id/restart: a new BankID for the
 * pending consent (the second signatory's own, or a try again). Mirrors the
 * session restart; the typed personnummer is required, since the party never
 * looks the sender's up here (400 BANK_CONSENT_PERSONAL_NUMBER_REQUIRED
 * without one). A bank that signs on its own page comes back to this link.
 */
export const POST = withInviteToken<{ token: string; id: string }>('bank_feed.restart', { stage: 'follow_up' }, async (request, { op, log, requestId, signer, signerRequired }, { token, id }) => {
  if (!isUuid(id)) return sessionFailureResponse({ ok: false, code: 'NOT_FOUND' }, log, requestId)
  const body = await readOptionalBody(request)
  const personalNumber = typedPersonalNumber(body.personal_number)
  if (!personalNumber) return signerRequired()
  const outcome = await restartBankFeedConsent(op, {
    connectionId: id,
    method: body.method ?? null,
    returnTo: BANK_CONNECT_SIGNATORY_TARGET,
    returnOrigin: await returnOriginFor(request),
    returnToken: token,
    signer: signer(personalNumber, body.psu_authoriser_id),
  })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
