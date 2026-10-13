import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { withInviteToken } from '@/lib/bank-feed/invite-route'
import { returnOriginFor } from '@/lib/bank-feed/request-return'
import { BANK_CONNECT_SIGNATORY_TARGET } from '@/lib/bank-feed/return-url'
import { startBankFeedConsent } from '@/lib/bank-feed/service'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * The same body as POST /api/bank/open-payments/connections, with two
 * differences: the firmatecknare has nothing on file, so the personnummer is
 * required (without it the service would fall back to the sender's own
 * number, and the bank would wait for the wrong person's BankID), and the
 * page to come back to is always this link, never a body value.
 */
const StartSchema = z.object({
  bic: z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/),
  affiliated_aspsp_id: z.string().min(1).max(64).nullish(),
  account_context: z.enum(['corporate', 'private']).nullish(),
  /** BankID in our screen (same_device, qr) or on the bank's own page (redirect). */
  method: z.enum(['same_device', 'qr', 'redirect']),
  personal_number: z.string().min(10).max(20),
})

/**
 * POST /api/koppla/:token/connections: create the consent at the bank for the
 * company the link names and start BankID for the firmatecknare. The
 * connection a switch or a renewal replaces comes from the link, never from
 * the body; the service hands over an Enable Banking row at selection and
 * supersedes an Open Payments row when the new consent is valid. A bank that
 * signs on its own page sends the browser back to /koppla/<token>.
 */
export const POST = withInviteToken<{ token: string }>('bank_feed.start', { stage: 'open' }, async (request, { invite, op, log, requestId, signer }, { token }) => {
  const blocked = await requireCapability(op.supabase, op.companyId, CAPABILITY.bank_sync)
  if (blocked) return blocked
  const validation = await validateBody(request, StartSchema)
  if (!validation.success) return validation.response
  if (invite.bic && validation.data.bic.toUpperCase() !== invite.bic.toUpperCase()) {
    return sessionFailureResponse({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'bic', reason: 'link_names_another_bank' } }, log, requestId)
  }
  const outcome = await startBankFeedConsent(op, {
    bic: validation.data.bic,
    affiliatedAspspId: validation.data.affiliated_aspsp_id ?? null,
    accountContext: validation.data.account_context ?? null,
    method: validation.data.method,
    replaceConnectionId: invite.replace_connection_id,
    returnTo: BANK_CONNECT_SIGNATORY_TARGET,
    returnOrigin: await returnOriginFor(request),
    returnToken: token,
    signer: signer(validation.data.personal_number),
  })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
