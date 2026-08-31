import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

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

/**
 * Upper bound on how many company ids a single PostgREST `in.(...)` filter may
 * carry. supabase-js encodes the list into the GET query string, so an
 * unbounded list of 36-char UUIDs blows past common URL limits (~16 KB, a few
 * hundred ids) with a 414/400. Read-side consumers of the consent flag
 * (the calibration-fit and backtest scripts) must query per chunk.
 */
export const OPTED_IN_COMPANY_ID_CHUNK = 100

/**
 * Every company_id with data_analysis_opt_in = true, paginated so the list is
 * not silently capped at PostgREST's 1000-row default. Throws on query error:
 * the callers are founder-run scripts that should fail loudly, not fit on a
 * partial corpus. Ordered by company_id for stable paging.
 */
export async function listDataAnalysisOptedInCompanyIds(
  supabase: SupabaseClient,
): Promise<string[]> {
  const rows = await fetchAllRows<{ company_id: string }>(({ from, to }) =>
    supabase
      .from('company_settings')
      .select('company_id')
      .eq('data_analysis_opt_in', true)
      .order('company_id', { ascending: true })
      .range(from, to),
  )
  return rows.map((r) => r.company_id)
}

/** Split ids into `.in('company_id', chunk)`-sized batches. */
export function chunkCompanyIds(
  ids: readonly string[],
  size: number = OPTED_IN_COMPANY_ID_CHUNK,
): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}
