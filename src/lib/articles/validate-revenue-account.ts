import type { SupabaseClient } from '@supabase/supabase-js'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'

/**
 * Classify a per-article invoice posting-account override against the company's chart.
 *
 * - 'ok'          : active class 1-3 account in the chart; accept as-is.
 * - 'activatable' : a class 1-3 account that is merely missing/inactive: either
 *                   an inactive chart row or a known BAS class 1-3 number not yet
 *                   in the chart. Routes translate this to ACCOUNTS_NOT_IN_CHART
 *                   so the standard activate-and-retry dialog flow applies
 *                   (same UX as the journal entry form).
 * - 'invalid'     : anything else: an account outside classes 1-3 or a number unknown to
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
    if (data.account_class < 1 || data.account_class > 3) return 'invalid'
    return data.is_active ? 'ok' : 'activatable'
  }

  const ref = getBASReference(account)
  return ref && ref.account_class >= 1 && ref.account_class <= 3 ? 'activatable' : 'invalid'
}
