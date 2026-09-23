import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { computeSRUCode } from '@/lib/bookkeeping/bas-data/sru-mapping'

const log = createLogger('account-backfill')

/**
 * Seed missing standard BAS accounts into a company's chart on demand.
 *
 * A company chart starts minimal, and legitimate engine flows routinely reach
 * accounts that exist in BAS 2026 but were never added: öresavrundning on
 * 3740 the first time a Bankgiro payment lands a sub-krona off, a first legal
 * invoice on 6580. Failing the whole entry for that (AccountsNotInChartError)
 * turns a standard account into a dead end, so the engine backfills instead.
 *
 * Deliberately conservative:
 *  - Only accounts present in BAS_REFERENCE are seeded: unknown numbers stay
 *    missing and surface as AccountsNotInChartError in the caller.
 *  - An account that exists but is INACTIVE is never touched: deactivation is
 *    a deliberate user choice, and silently reactivating would override it.
 *  - A concurrent insert (unique violation) counts as success.
 *
 * Returns the account numbers that are now present and active.
 */
export async function backfillStandardBASAccounts(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountNumbers: string[],
): Promise<string[]> {
  if (accountNumbers.length === 0) return []

  // Only standard BAS accounts qualify.
  const candidates = accountNumbers
    .map((num) => ({ num, basRef: getBASReference(num) }))
    .filter((c): c is { num: string; basRef: NonNullable<ReturnType<typeof getBASReference>> } =>
      Boolean(c.basRef),
    )
  if (candidates.length === 0) return []

  // Never resurrect rows that already exist (active or inactive): the caller
  // saw them as missing because they are inactive, and that stays their state.
  const { data: existing, error: existingError } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .in('account_number', candidates.map((c) => c.num))
  if (existingError) {
    log.error('failed to check existing accounts before backfill', existingError, { companyId })
    return []
  }
  const existingNumbers = new Set((existing ?? []).map((r) => r.account_number))
  const toInsert = candidates.filter((c) => !existingNumbers.has(c.num))
  if (toInsert.length === 0) return []

  const rows = toInsert.map(({ num, basRef }) => ({
    user_id: userId,
    company_id: companyId,
    account_number: num,
    account_name: basRef.account_name,
    account_class: basRef.account_class,
    account_group: basRef.account_group,
    account_type: basRef.account_type,
    normal_balance: basRef.normal_balance,
    sru_code: basRef.sru_code ?? computeSRUCode(num),
    k2_excluded: basRef.k2_excluded,
    plan_type: 'full_bas' as const,
    is_active: true,
    is_system_account: false,
    description: basRef.description,
    sort_order: /^\d+$/.test(num) ? parseInt(num, 10) : null,
  }))

  const { error: insertError } = await supabase.from('chart_of_accounts').insert(rows)
  if (insertError) {
    // Unique violation = another request seeded it concurrently: that's fine,
    // the account exists now. Anything else: log and let the caller's
    // re-resolution decide what is still missing.
    if (insertError.code !== '23505' && !insertError.message?.includes('duplicate')) {
      log.error('failed to backfill standard BAS accounts', insertError, {
        companyId,
        accountNumbers: toInsert.map((c) => c.num),
      })
      return []
    }
  } else {
    log.info('seeded standard BAS accounts on demand', {
      companyId,
      accountNumbers: toInsert.map((c) => c.num),
    })
  }

  return toInsert.map((c) => c.num)
}
