import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'

/**
 * Arkiv phase 9e: the meter. What the pipeline did for a company, counted
 * per day and activity as it happens, summed per rolling year when shown.
 * Sizes and packs will be priced on these numbers; today they are shown to
 * the company and to its agent, never enforced. Recording never throws: a
 * meter that could stop the pipeline would be the wrong meter.
 */
const log = createLogger('arkiv/usage')

export const USAGE_ACTIVITIES = ['documents', 'pages_read', 'pages_vision', 'extractions', 'asks'] as const
export type UsageActivity = (typeof USAGE_ACTIVITIES)[number]

export interface ArkivUsage {
  /** First day counted, inclusive. */
  since: string
  days: number
  documents: number
  pages_read: number
  pages_vision: number
  extractions: number
  asks: number
}

export const USAGE_WINDOW_DAYS = 365

export async function recordArkivUsage(supabase: SupabaseClient, companyId: string, activity: UsageActivity, units = 1): Promise<void> {
  if (!Number.isFinite(units) || units <= 0) return
  try {
    // The day key is the Swedish calendar day, the same one the budget read
    // and the rolling window use. The RPC's default, CURRENT_DATE, is the UTC
    // date in the database and lags it between midnight and 01:00/02:00.
    const { error } = await supabase.rpc('arkiv_usage_add', { p_company_id: companyId, p_activity: activity, p_units: Math.round(units), p_day: todayIsoStockholm() })
    if (error) log.warn('usage not recorded', { companyId, activity, units, reason: error.message })
  } catch (err) {
    log.warn('usage not recorded', { companyId, activity, units, reason: err instanceof Error ? err.message : String(err) })
  }
}

/** First day of a rolling window of `days` Swedish calendar days that ends today, inclusive. */
export function usageSince(days: number, now = new Date()): string {
  return addDaysIso(todayIsoStockholm(now), -(days - 1))
}

/** Rows of the daily table folded into one summary; shared with the MCP resource, which reads the rows in its own batch. */
export function sumUsage(rows: Array<{ activity: string; units: number }>, since: string, days: number): ArkivUsage {
  const out: ArkivUsage = { since, days, documents: 0, pages_read: 0, pages_vision: 0, extractions: 0, asks: 0 }
  for (const r of rows) {
    if ((USAGE_ACTIVITIES as readonly string[]).includes(r.activity)) out[r.activity as UsageActivity] += Number(r.units) || 0
  }
  return out
}
