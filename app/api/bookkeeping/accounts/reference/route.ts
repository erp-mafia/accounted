import { NextResponse } from 'next/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-reference'

/**
 * GET /api/bookkeeping/accounts/reference
 *
 * Returns the full BAS reference catalog merged with the user's activation status.
 * Each reference account includes: is_activated (exists in user's chart), is_active, is_system_account, is_custom.
 */
export const GET = withRouteContext('bookkeeping.accounts.reference', async (_request, ctx) => {
  const { supabase, companyId } = ctx

  // Paginated with a stable unique order — a full-BAS chart exceeds the
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

    // Build lookup map
    const userAccountMap = new Map(
      userAccounts.map((a) => [a.account_number, a])
    )

    // Merge reference with user status
    const merged = BAS_REFERENCE.map((ref) => {
      const userAccount = userAccountMap.get(ref.account_number)
      return {
        ...ref,
        is_activated: !!userAccount,
        is_active: userAccount?.is_active ?? false,
        is_system_account: userAccount?.is_system_account ?? false,
      }
    })

    // Also identify custom accounts (in user's chart but not in BAS reference)
    const basNumbers = new Set(BAS_REFERENCE.map((r) => r.account_number))
    const customAccounts = userAccounts
      .filter((a) => !basNumbers.has(a.account_number))
      .map((a) => ({
        account_number: a.account_number,
        is_custom: true,
        is_activated: true,
        is_active: a.is_active,
        is_system_account: a.is_system_account,
      }))

    return NextResponse.json({ data: merged, customAccounts })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to fetch accounts' }, { status: 500 })
  }
})
