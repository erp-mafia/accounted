import type { SupabaseClient } from '@supabase/supabase-js'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'

/**
 * Classify a per-article revenue-account override against the company's chart:
 *
 * - 'ok'          : active class-3 account in the chart; accept as-is.
 * - 'activatable' : a class-3 account that is merely missing/inactive: either
 *                   an inactive chart row or a known BAS class-3 number not yet
 *                   in the chart. Routes translate this to ACCOUNTS_NOT_IN_CHART
 *                   so the standard activate-and-retry dialog flow applies
 *                   (same UX as the journal entry form).
 * - 'invalid'     : anything else: a non-revenue account or a number unknown to
 *                   both the chart and the BAS catalogue. Never bookable.
 *
 * Throws on an unexpected DB error so the route wrapper maps it to the canonical
 * envelope.
 */
export type RevenueAccountStatus = 'ok' | 'activatable' | 'invalid'

export async function checkRevenueAccount(
  supabase: SupabaseClient,
  companyId: string,
  account: string,
): Promise<RevenueAccountStatus> {
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('account_class, is_active')
    .eq('company_id', companyId)
    .eq('account_number', account)
    .maybeSingle()

  if (error) throw error

  if (data) {
    if (data.account_class !== 3) return 'invalid'
    return data.is_active ? 'ok' : 'activatable'
  }

  const ref = getBASReference(account)
  return ref?.account_class === 3 ? 'activatable' : 'invalid'
}

/**
 * True when `account` exists in the company's chart of accounts as an ACTIVE
 * class-3 (revenue/intäkt) account. Used to guard the optional per-article
 * revenue-account override so a typo or a non-revenue account can never be
 * pinned to an article (and later booked). Never trust the client.
 *
 * Throws on an unexpected DB error so the route wrapper maps it to the canonical
 * envelope; a simple "account not found" resolves to `false`, not an error.
 */
export async function isValidRevenueAccount(
  supabase: SupabaseClient,
  companyId: string,
  account: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .eq('account_class', 3)
    .eq('is_active', true)
    .eq('account_number', account)
    .maybeSingle()

  if (error) throw error
  return !!data
}
