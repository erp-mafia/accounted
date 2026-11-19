import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SetSkattekontoAccountSchema } from '@/lib/api/schemas'
import { sessionFailureResponse } from '@/lib/operations/session'
import {
  getSkattekontoAccountState,
  setSkattekontoAccount,
} from '@/lib/skatteverket/skattekonto-account-service'
import { resolveSkattekontoAccount } from '@/lib/skatteverket/skattekonto-account'

/**
 * GET /api/settings/skattekonto-account
 *
 * The skattekonto's ledger account (PH 175): what every skattekonto reader
 * uses now, the stored choice, the accounts the legal form may choose, what
 * the books suggest, and the balance on each choosable account (so a change
 * shows what stays on the old one).
 */
export const GET = withRouteContext(
  'settings.skattekonto_account.get',
  async (request, { supabase, companyId, user, log, requestId }) => {
    // ?view=account: the account alone, for pages that only label or preview
    // with it (one read, no balances).
    if (new URL(request.url).searchParams.get('view') === 'account') {
      return NextResponse.json({ data: { account: await resolveSkattekontoAccount(supabase, companyId) } })
    }
    const outcome = await getSkattekontoAccountState({ supabase, companyId, userId: user.id, log })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
)

/**
 * PUT /api/settings/skattekonto-account { account: '1630' | '2012' }
 *
 * Store the choice (owners and admins: a company setting). 2012 only for an
 * enskild firma; the account is added to the chart when missing. Nothing in
 * the ledger moves: the answer says what is left on the previous account,
 * and POST .../transfer-draft drafts the transfer for the user to post.
 */
export const PUT = withRouteContext(
  'settings.skattekonto_account.update',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, SetSkattekontoAccountSchema)
    if (!validation.success) return validation.response
    const outcome = await setSkattekontoAccount(
      { supabase, companyId, userId: user.id, log },
      validation.data.account,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireAdmin: true },
)
