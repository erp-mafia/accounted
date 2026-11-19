import type { SupabaseClient } from '@supabase/supabase-js'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'
import { isStandardBASAccount } from '@/lib/bookkeeping/bas-reference'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import type { AssetCategory } from '@/types'

/**
 * Asset register accounts against the company's own chart of accounts
 * (crm#1452).
 *
 * The register stores its BAS triple as plain text and creating an asset
 * posts no voucher, so nothing on that path ever looked at chart_of_accounts.
 * Depreciation only posts on the accumulated and expense accounts, which the
 * engine backfills; the asset account itself is first posted at disposal.
 * A row could therefore sit on an account the chart does not have, for good.
 *
 * Two rules, applied on every create:
 *  - The category default follows the company's chart: when the BAS 2026
 *    default is not active there, an earlier asset of the same category whose
 *    three accounts are all active wins (a company still on the pre-2026
 *    datorkonton keeps using them). Otherwise the BAS 2026 default stands.
 *  - Every account the row will carry must exist and be active in the chart.
 *    A missing standard BAS account is added the way the bookkeeping engine
 *    adds one (backfillStandardBASAccounts); an inactive account or a number
 *    outside BAS is refused with ACCOUNTS_NOT_IN_CHART.
 */

interface AccountTriple {
  asset: string
  accumulated: string
  expense: string
}

type ChartState = Map<string, boolean>

function tripleNumbers(triple: AccountTriple): string[] {
  return [triple.asset, triple.accumulated, triple.expense]
}

/** account_number -> is_active, for the numbers present in the chart. */
async function loadChartState(
  supabase: SupabaseClient,
  companyId: string,
  numbers: string[],
): Promise<ChartState> {
  const unique = [...new Set(numbers)]
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number, is_active')
    .eq('company_id', companyId)
    .in('account_number', unique)
  if (error) {
    throw new Error(`Failed to load chart of accounts for company ${companyId}: ${error.message}`)
  }
  const state: ChartState = new Map()
  for (const row of (data ?? []) as Array<{ account_number: string; is_active: boolean | null }>) {
    state.set(row.account_number, row.is_active !== false)
  }
  return state
}

function allActive(state: ChartState, triple: AccountTriple): boolean {
  return tripleNumbers(triple).every((number) => state.get(number) === true)
}

/**
 * The category default for this company. The intangible category is left
 * alone: its default is framework-driven and the K2 gate is judged on it.
 */
export async function chartAwareDefaultAccounts(
  supabase: SupabaseClient,
  companyId: string,
  category: AssetCategory,
  defaults: AccountTriple,
): Promise<AccountTriple> {
  if (category === 'immaterial') return defaults

  const { data, error } = await supabase
    .from('assets')
    .select('bas_asset_account, bas_accumulated_account, bas_expense_account')
    .eq('company_id', companyId)
    .eq('category', category)
    .is('disposed_at', null)
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) {
    throw new Error(`Failed to load earlier assets for company ${companyId}: ${error.message}`)
  }
  const earlier = ((data ?? []) as Array<{
    bas_asset_account: string
    bas_accumulated_account: string
    bas_expense_account: string
  }>).map((row) => ({
    asset: row.bas_asset_account,
    accumulated: row.bas_accumulated_account,
    expense: row.bas_expense_account,
  }))

  const state = await loadChartState(supabase, companyId, [
    ...tripleNumbers(defaults),
    ...earlier.flatMap(tripleNumbers),
  ])
  if (allActive(state, defaults)) return defaults
  return earlier.find((triple) => allActive(state, triple)) ?? defaults
}

/**
 * Accounts that cannot be used as they stand: inactive in the chart, or
 * missing and not a standard BAS account the backfill could add. Read only,
 * for the staging and dry-run gates.
 */
export async function unusableAssetAccounts(
  supabase: SupabaseClient,
  companyId: string,
  numbers: string[],
): Promise<string[]> {
  const state = await loadChartState(supabase, companyId, numbers)
  return [...new Set(numbers)].filter((number) => {
    const active = state.get(number)
    if (active === undefined) return !isStandardBASAccount(number)
    return !active
  })
}

/**
 * Make every account active in the chart before the register row is written:
 * add missing standard BAS accounts, refuse the rest with
 * AccountsNotInChartError. An inactive account is never reactivated here:
 * deactivating it was the user's choice.
 */
export async function ensureAssetAccountsInChart(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  numbers: string[],
): Promise<void> {
  const unique = [...new Set(numbers)]
  const state = await loadChartState(supabase, companyId, unique)
  const refused = unique.filter((number) => {
    const active = state.get(number)
    return active === false || (active === undefined && !isStandardBASAccount(number))
  })
  if (refused.length > 0) throw new AccountsNotInChartError(refused)

  const missing = unique.filter((number) => !state.has(number))
  if (missing.length === 0) return
  const seeded = new Set(await backfillStandardBASAccounts(supabase, companyId, userId, missing))
  const notSeeded = missing.filter((number) => !seeded.has(number))
  if (notSeeded.length > 0) throw new AccountsNotInChartError(notSeeded)
}
