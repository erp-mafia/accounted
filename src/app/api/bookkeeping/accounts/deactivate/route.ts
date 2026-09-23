import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

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
 *   confirm. Usage comes from get_account_usage_counts, the same company-
 *   scoped RPC the DELETE guard and the prune dialog read.
 * - Already-inactive numbers are counted in skipped_inactive; numbers not in
 *   the chart at all are reported in `unknown` rather than rejected.
 */
const DeactivateSchema = z.object({
  account_numbers: z.array(z.string().min(1).max(10)).min(1).max(2000),
  include_used: z.boolean().optional().default(false),
})

interface ChartRow {
  account_number: string
  is_active: boolean
  is_system_account: boolean
}

export const POST = withRouteContext(
  'bookkeeping.accounts.deactivate',
  async (request, ctx) => {
    const { supabase, companyId } = ctx

    const raw = await request.json().catch(() => null)
    const parsed = DeactivateSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ error: 'account_numbers array required' }, { status: 400 })
    }

    const uniqueNumbers = [...new Set(parsed.data.account_numbers)]
    const includeUsed = parsed.data.include_used

    const { data: existing, error: fetchError } = await supabase
      .from('chart_of_accounts')
      .select('account_number, is_active, is_system_account')
      .eq('company_id', companyId)
      .in('account_number', uniqueNumbers)

    if (fetchError) {
      return NextResponse.json({ error: getUserErrorMessage(fetchError) }, { status: 500 })
    }

    const { data: usage, error: usageError } = await supabase.rpc('get_account_usage_counts', {
      p_company_id: companyId,
    })
    if (usageError) {
      return NextResponse.json({ error: getUserErrorMessage(usageError) }, { status: 500 })
    }
    // Accounts never posted to are simply absent from the RPC result.
    const usedNumbers = new Set<string>(
      ((usage ?? []) as { account_number: string }[]).map((u) => u.account_number),
    )

    const byNumber = new Map<string, ChartRow>(
      ((existing || []) as ChartRow[]).map((a) => [a.account_number, a]),
    )

    const toDeactivate: string[] = []
    const skippedSystem: string[] = []
    const skippedUsed: string[] = []
    const unknown: string[] = []
    let skippedInactive = 0

    for (const num of uniqueNumbers) {
      const row = byNumber.get(num)
      if (!row) {
        unknown.push(num)
        continue
      }
      if (!row.is_active) {
        skippedInactive += 1
        continue
      }
      if (row.is_system_account) {
        skippedSystem.push(num)
        continue
      }
      if (usedNumbers.has(num) && !includeUsed) {
        skippedUsed.push(num)
        continue
      }
      toDeactivate.push(num)
    }

    let deactivatedRows: { account_number: string }[] = []
    if (toDeactivate.length > 0) {
      const { data, error } = await supabase
        .from('chart_of_accounts')
        .update({ is_active: false })
        .eq('company_id', companyId)
        .in('account_number', toDeactivate)
        .select('account_number')
      if (error) {
        return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
      }
      deactivatedRows = data || []
    }

    return NextResponse.json({
      data: deactivatedRows,
      deactivated: deactivatedRows.length,
      skipped_system: skippedSystem,
      skipped_used: skippedUsed,
      skipped_inactive: skippedInactive,
      unknown,
    })
  },
  { requireWrite: true },
)
