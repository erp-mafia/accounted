import { NextResponse } from 'next/server'
import { z } from 'zod'
import { typedPersonalNumber, withInviteToken } from '@/lib/bank-feed/invite-route'
import { pollBankFeedConsent } from '@/lib/bank-feed/service'
import { isUuid } from '@/lib/invariants/uuid'
import { sessionFailureResponse } from '@/lib/operations/session'

/** The typed personnummer, so the bank sees the PSU on the poll too. On the signatory link it is the only PSU there is. */
const PollSchema = z.object({
  personal_number: z.string().max(20).nullish(),
  /** Nordea Corporate Netbank: the signer's own logon id, when they use it. Sent with a Nordea signing only, never stored. */
  psu_authoriser_id: z.string().max(100).nullish(),
})

async function readOptionalBody(request: Request): Promise<z.infer<typeof PollSchema>> {
  const text = await request.text().catch(() => '')
  if (!text.trim()) return {}
  try {
    const parsed = PollSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/**
 * POST /api/koppla/:token/connections/:id/poll: where the firmatecknare's
 * BankID stands, once a second while it runs. Mirrors the session poll, with
 * one difference: the typed personnummer is required. The context acts as the
 * sender, and the party never looks their number up here, so without a typed
 * one the poll would name nobody: 400 BANK_CONSENT_PERSONAL_NUMBER_REQUIRED
 * instead. The poll has a budget of its own in the token limiter.
 */
export const POST = withInviteToken<{ token: string; id: string }>('bank_feed.poll', { stage: 'follow_up', limiter: 'poll' }, async (request, { op, log, requestId, signer, signerRequired }, { id }) => {
  if (!isUuid(id)) return sessionFailureResponse({ ok: false, code: 'NOT_FOUND' }, log, requestId)
  const body = await readOptionalBody(request)
  const personalNumber = typedPersonalNumber(body.personal_number)
  if (!personalNumber) return signerRequired()
  const outcome = await pollBankFeedConsent(op, { connectionId: id, signer: signer(personalNumber, body.psu_authoriser_id) })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
