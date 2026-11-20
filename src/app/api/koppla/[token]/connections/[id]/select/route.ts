import { NextResponse, after } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { withInviteToken } from '@/lib/bank-feed/invite-route'
import { consumeInvite } from '@/lib/bank-feed/invites'
import { returnOriginFor } from '@/lib/bank-feed/request-return'
import { BANK_CONNECT_SIGNATORY_TARGET } from '@/lib/bank-feed/return-url'
import { selectBankFeedAccounts } from '@/lib/bank-feed/service'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { isUuid } from '@/lib/invariants/uuid'
import { sessionFailureResponse } from '@/lib/operations/session'

// The first import starts inside this request and finishes in the
// background, as on the session route.
export const maxDuration = 800

const SelectSchema = z.object({
  accounts: z
    .array(
      z.object({
        uid: z.string().min(1),
        enabled: z.boolean(),
        ledger_account: z.string().regex(/^19\d{2}$/).nullish(),
      }),
    )
    .min(1)
    .max(100),
  method: z.enum(['same_device', 'qr', 'redirect']).nullish(),
  personal_number: z.string().max(20).nullish(),
})

/**
 * POST /api/koppla/:token/connections/:id/select: which accounts to sync,
 * onto which ledgers; the first import runs. Mirrors the session select
 * (Svea's second consent may sign on the bank's page and comes back to this
 * link), and consumes the link: it has done its work and names the connection
 * it made. The poll, the sync and the verification keep answering through the
 * grace window.
 */
export const POST = withInviteToken<{ token: string; id: string }>('bank_feed.select', { stage: 'open' }, async (request, { invite, service, op, log, requestId, signer }, { token, id }) => {
  if (!isUuid(id)) return sessionFailureResponse({ ok: false, code: 'NOT_FOUND' }, log, requestId)
  const blocked = await requireCapability(op.supabase, op.companyId, CAPABILITY.bank_sync)
  if (blocked) return blocked
  const validation = await validateBody(request, SelectSchema)
  if (!validation.success) return validation.response
  const outcome = await selectBankFeedAccounts(op, {
    connectionId: id,
    accounts: validation.data.accounts.map((a) => ({ uid: a.uid, enabled: a.enabled, ledgerAccount: a.ledger_account ?? null })),
    method: validation.data.method ?? null,
    returnTo: BANK_CONNECT_SIGNATORY_TARGET,
    returnOrigin: await returnOriginFor(request),
    returnToken: token,
    signer: signer(validation.data.personal_number),
    keepAlive: (work) => after(() => work.catch(() => {})),
  })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  try {
    await consumeInvite(service, invite.id, id)
  } catch (error) {
    // The selection stands; a link that stays open a little longer is the lesser harm.
    log.warn('signatory link not marked consumed', { message: error instanceof Error ? error.message : String(error) })
  }
  return NextResponse.json({ data: outcome.data })
})
