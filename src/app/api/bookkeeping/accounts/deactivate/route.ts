import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { deactivateAccounts } from '@/lib/bookkeeping/chart-of-accounts-service'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/bookkeeping/accounts/deactivate
 *
 * Batch-deactivate accounts in the company's chart. Accepts
 * { account_numbers: string[], include_used?: boolean }. The mirror of
 * /activate, built for the post-migration sweep (#2186): a chart imported from
 * a previous system carries hundreds of accounts that were never posted to,
 * and a short chart is what keeps manual bookings from landing on the wrong
 * one.
 *
 * - System accounts are never deactivated here (skipped_system).
 * - Accounts with postings are skipped unless include_used is true
 *   (skipped_used): deactivating a used account is legal and reversible, but
 *   it hides balances from the kontoplan, so the bulk path defaults to the
 *   never-used set and leaves used accounts to the per-row toggle with its
 *   confirm.
 * - Already-inactive numbers are counted in skipped_inactive; numbers not in
 *   the chart at all are reported in `unknown` rather than rejected.
 *
 * The rules live in lib/bookkeeping/chart-of-accounts-service.ts, shared with
 * the v1 operation accounts.deactivate and gnubok_deactivate_accounts.
 */
const DeactivateSchema = z.object({
  account_numbers: z.array(z.string().min(1).max(10)).min(1).max(2000),
  include_used: z.boolean().optional().default(false),
})

export const POST = withRouteContext(
  'bookkeeping.accounts.deactivate',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx

    const raw = await request.json().catch(() => null)
    const parsed = DeactivateSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ error: 'account_numbers array required' }, { status: 400 })
    }

    const outcome = await deactivateAccounts(
      { supabase, companyId, userId: user.id, log },
      parsed.data.account_numbers,
      parsed.data.include_used,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    const { accounts, ...counts } = outcome.data
    return NextResponse.json({ data: accounts, ...counts })
  },
  { requireWrite: true },
)
