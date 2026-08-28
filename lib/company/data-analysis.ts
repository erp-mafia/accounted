import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Data analysis consent gate (#1346).
 *
 * Returns true only when the company has explicitly opted in to having its
 * bookkeeping data read across companies for Accounted's own analysis. The
 * consent copy (messages/*.json data_analysis.*) states two scopes and this
 * flag covers both: (1) booking outcomes (proposed vs booked account,
 * confidence, amount) for the auto-booking calibration corpus and the
 * calibration-fit script; (2) evaluation runs (scripts/backtest-categorize.ts)
 * that re-run the company's transaction descriptions, counterparty names and
 * matched underlag through the same AI model as regular booking. Anything
 * wider than that needs new consent copy first, not just a new caller.
 * `company_settings.data_analysis_opt_in` is the single source of truth;
 * every analysis path checks it so a company that never opted in (or opted
 * out again) contributes nothing.
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
