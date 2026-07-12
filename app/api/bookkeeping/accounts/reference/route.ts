import { NextResponse } from 'next/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'

/**
 * GET /api/bookkeeping/accounts/reference
 *
 * Returns the company's chart-of-accounts activation status: one lightweight
 * row per account it holds (active or not), shaped
 * `{ account_number, is_active, is_system_account }`.
 *
 * The BAS catalog itself is static and already bundled into the client
 * (lib/bookkeeping/bas-reference); the kontoplan UI merges this activation
 * list against that bundled catalog to render the "BAS-katalog" tab. We
 * deliberately do NOT re-send the full ~1,300-account catalog over the wire on
 * every page load; the browser already has that payload.
 */
export const GET = withRouteContext('bookkeeping.accounts.reference', async (_request, ctx) => {
  const { supabase, companyId } = ctx

  // Paginated with a stable unique order: a full-BAS chart exceeds the
  // 1000-row page size, and unordered .range() paging can duplicate or skip
  // rows on page boundaries (see fetch-all.ts ordering invariant).
  try {
    const userAccounts = await fetchAllRows<{ account_number: string; is_active: boolean; is_system_account: boolean }>(({ from, to }) =>
      supabase
        .from('chart_of_accounts')
        .select('account_number, is_active, is_system_account')
        .eq('company_id', companyId)
        .order('account_number', { ascending: true })
        .range(from, to)
    )

    return NextResponse.json({ data: userAccounts })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to fetch accounts' }, { status: 500 })
  }
})
