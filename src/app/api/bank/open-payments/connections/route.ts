import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { returnOriginFor } from '@/lib/bank-feed/request-return'
import { BANK_CONNECT_RETURN_SURFACES } from '@/lib/bank-feed/return-url'
import { getBankFeedOverview, startBankFeedConsent } from '@/lib/bank-feed/service'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { sessionFailureResponse } from '@/lib/operations/session'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'

const StartSchema = z.object({
  bic: z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/),
  affiliated_aspsp_id: z.string().min(1).max(64).nullish(),
  account_context: z.enum(['corporate', 'private']).nullish(),
  /** BankID in our screen (same_device, qr) or on the bank's own page (redirect, which needs return_to). */
  method: z.enum(['same_device', 'qr', 'redirect']),
  /** The signer's personnummer, when they have none on file. Never stored. */
  personal_number: z.string().max(20).nullish(),
  /** Switch mode: the Enable Banking connection this one replaces at account selection. */
  replace_connection_id: z.uuid().nullish(),
  /** The entry point the browser comes back to after signing at the bank; the origin is the one this request came to. */
  return_to: z.enum(BANK_CONNECT_RETURN_SURFACES).nullish(),
})

/** GET /api/bank/open-payments/connections: the company's Open Payments connections and whether it may make one. */
export const GET = withRouteContext('bank_feed.overview', async (_request, { supabase, companyId, user, log, requestId }) => {
  const outcome = await getBankFeedOverview({ supabase, companyId, userId: user.id, log })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})

/**
 * POST /api/bank/open-payments/connections: create the consent at the bank,
 * store the attempt as a pending connection and start BankID. Answers the
 * challenge the person signs with; the browser then polls
 * /api/bank/open-payments/connections/:id/poll every second. For a bank that
 * signs on its own page the challenge carries redirectUrl; the browser goes
 * there and comes back to the return_to page with ?bank_connect=<id>.
 */
export const POST = withRouteContext(
  'bank_feed.start',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const blocked = await requireCapability(supabase, companyId, CAPABILITY.bank_sync)
    if (blocked) return blocked
    const validation = await validateBody(request, StartSchema)
    if (!validation.success) return validation.response
    const returnTo = validation.data.return_to ?? null
    const outcome = await startBankFeedConsent(
      { supabase, companyId, userId: user.id, log },
      {
        bic: validation.data.bic,
        affiliatedAspspId: validation.data.affiliated_aspsp_id ?? null,
        accountContext: validation.data.account_context ?? null,
        method: validation.data.method,
        replaceConnectionId: validation.data.replace_connection_id ?? null,
        returnTo,
        returnOrigin: returnTo ? await returnOriginFor(request) : null,
        signer: signerFromRequest(request, validation.data.personal_number),
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
