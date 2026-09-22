import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

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
    const { error } = await supabase.rpc('arkiv_usage_add', { p_company_id: companyId, p_activity: activity, p_units: Math.round(units) })
    if (error) log.warn('usage not recorded', { companyId, activity, units, reason: error.message })
  } catch (err) {
    log.warn('usage not recorded', { companyId, activity, units, reason: err instanceof Error ? err.message : String(err) })
  }
}

export function usageSince(days: number, today = new Date()): string {
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  from.setUTCDate(from.getUTCDate() - (days - 1))
  return from.toISOString().slice(0, 10)
}

/** Rows of the daily table folded into one summary; shared with the MCP resource, which reads the rows in its own batch. */
export function sumUsage(rows: Array<{ activity: string; units: number }>, since: string, days: number): ArkivUsage {
  const out: ArkivUsage = { since, days, documents: 0, pages_read: 0, pages_vision: 0, extractions: 0, asks: 0 }
  for (const r of rows) {
    if ((USAGE_ACTIVITIES as readonly string[]).includes(r.activity)) out[r.activity as UsageActivity] += Number(r.units) || 0
  }
  return out
}

export async function arkivUsageSummary(supabase: SupabaseClient, companyId: string, opts: { days?: number; today?: Date } = {}): Promise<ArkivUsage> {
  const days = opts.days ?? USAGE_WINDOW_DAYS
  const since = usageSince(days, opts.today)
  const { data, error } = await supabase.from('arkiv_usage_daily').select('activity, units').eq('company_id', companyId).gte('day', since)
  if (error) throw new Error(`usage read failed: ${error.message}`)
  return sumUsage((data ?? []) as Array<{ activity: string; units: number }>, since, days)
}
