import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Data analysis consent gate (#1346).
 *
 * Returns true only when the company has explicitly opted in to having its
 * bookkeeping outcomes (proposed vs booked account, confidence, amount) read
 * across companies for Accounted's own analysis: the auto-booking calibration
 * corpus and the founder-run backtests. `company_settings.data_analysis_opt_in`
 * is the single source of truth; every analysis path checks it here so a
 * company that never opted in (or opted out again) contributes nothing.
 *
 * Fails closed: a missing row or a query error counts as "not opted in".
 */
export async function isDataAnalysisOptedIn(
  supabase: SupabaseClient,
  companyId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('data_analysis_opt_in')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return false
  return data?.data_analysis_opt_in === true
}
