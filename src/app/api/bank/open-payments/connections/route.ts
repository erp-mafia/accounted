import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { getBankFeedOverview, startBankFeedConsent } from '@/lib/bank-feed/service'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { sessionFailureResponse } from '@/lib/operations/session'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'

const StartSchema = z.object({
  bic: z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/),
  affiliated_aspsp_id: z.string().min(1).max(64).nullish(),
  account_context: z.enum(['corporate', 'private']).nullish(),
  method: z.enum(['same_device', 'qr']),
  /** The signer's personnummer, when they have none on file. Never stored. */
  personal_number: z.string().max(20).nullish(),
  /** Switch mode: the Enable Banking connection this one replaces at account selection. */
  replace_connection_id: z.uuid().nullish(),
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
 * /api/bank/open-payments/connections/:id/poll every second.
 */
export const POST = withRouteContext(
  'bank_feed.start',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const blocked = await requireCapability(supabase, companyId, CAPABILITY.bank_sync)
    if (blocked) return blocked
    const validation = await validateBody(request, StartSchema)
    if (!validation.success) return validation.response
    const outcome = await startBankFeedConsent(
      { supabase, companyId, userId: user.id, log },
      {
        bic: validation.data.bic,
        affiliatedAspspId: validation.data.affiliated_aspsp_id ?? null,
        accountContext: validation.data.account_context ?? null,
        method: validation.data.method,
        replaceConnectionId: validation.data.replace_connection_id ?? null,
        signer: signerFromRequest(request, validation.data.personal_number),
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
