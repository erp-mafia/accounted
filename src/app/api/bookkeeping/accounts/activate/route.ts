import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { activateAccounts } from '@/lib/bookkeeping/chart-of-accounts-service'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/bookkeeping/accounts/activate
 *
 * Batch-activate BAS accounts. Accepts { account_numbers: string[] }.
 * - Inserts rows from BAS reference for accounts not yet in the chart.
 * - Reactivates (is_active=true) accounts that already exist but are inactive.
 * - Skips anything already active.
 * - Returns { data, activated, reactivated, skipped, unknown } so callers can react.
 *
 * Strings that aren't known BAS numbers are reported in `unknown` (not
 * rejected) so activate-and-retry flows can surface them; the schema only
 * bounds type and size. The rules live in
 * lib/bookkeeping/chart-of-accounts-service.ts, shared with the v1 operation
 * accounts.activate and gnubok_activate_accounts.
 */
const ActivateSchema = z.object({
  account_numbers: z.array(z.string().min(1).max(10)).min(1).max(2000),
})

export const POST = withRouteContext(
  'bookkeeping.accounts.activate',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx

    const raw = await request.json().catch(() => null)
    const parsed = ActivateSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ error: 'account_numbers array required' }, { status: 400 })
    }

    const outcome = await activateAccounts(
      { supabase, companyId, userId: user.id, log },
      parsed.data.account_numbers,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    const { accounts, ...counts } = outcome.data
    return NextResponse.json({ data: accounts, ...counts })
  },
  { requireWrite: true },
)
