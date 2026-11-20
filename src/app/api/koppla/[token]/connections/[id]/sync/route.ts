import { NextResponse } from 'next/server'
import { z } from 'zod'
import { typedPersonalNumber, withInviteToken } from '@/lib/bank-feed/invite-route'
import { syncBankFeedConnection } from '@/lib/bank-feed/service'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { isUuid } from '@/lib/invariants/uuid'
import { sessionFailureResponse } from '@/lib/operations/session'

// The first read after selection pages through the bank's extended history.
export const maxDuration = 300

/** The typed personnummer: the read is made with the firmatecknare present, and they are the only PSU this link knows. */
const SyncSchema = z.object({
  personal_number: z.string().max(20).nullish(),
})

async function readOptionalBody(request: Request): Promise<z.infer<typeof SyncSchema>> {
  const text = await request.text().catch(() => '')
  if (!text.trim()) return {}
  try {
    const parsed = SyncSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/**
 * POST /api/koppla/:token/connections/:id/sync: the first read after Svea's
 * second consent, with the firmatecknare present. Mirrors the session sync;
 * the typed personnummer is required, since the party never looks the
 * sender's up here (400 BANK_CONSENT_PERSONAL_NUMBER_REQUIRED without one).
 */
export const POST = withInviteToken<{ token: string; id: string }>('bank_feed.sync', { stage: 'follow_up' }, async (request, { op, log, requestId, signer, signerRequired }, { id }) => {
  if (!isUuid(id)) return sessionFailureResponse({ ok: false, code: 'NOT_FOUND' }, log, requestId)
  const blocked = await requireCapability(op.supabase, op.companyId, CAPABILITY.bank_sync)
  if (blocked) return blocked
  const body = await readOptionalBody(request)
  const personalNumber = typedPersonalNumber(body.personal_number)
  if (!personalNumber) return signerRequired()
  const outcome = await syncBankFeedConnection(op, { connectionId: id, signer: signer(personalNumber) })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
