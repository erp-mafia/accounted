import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/** Skill loads are telemetry: event_log keeps them for 180 days, so the count is "the last half year". */
export const USAGE_WINDOW_DAYS = 180

export type SkillUsage = Record<string, { count: number; last_at: string }>

/**
 * How often agents loaded each skill for the company (mcp.skill_loaded), keyed
 * by the slug the Skills page knows: the per-client Kvittojakten bodies count
 * as one skill. A load is the closest server-side sign that a skill was run.
 */
export async function loadSkillUsage(supabase: SupabaseClient, companyId: string, now = new Date()): Promise<SkillUsage> {
  const since = new Date(now.getTime() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const rows = await fetchAllRows<{ sequence: number; slug: string | null; created_at: string }>((range) =>
    supabase.from('event_log').select('sequence, slug:data->>slug, created_at')
      .eq('company_id', companyId).eq('event_type', 'mcp.skill_loaded').gte('created_at', since)
      .order('sequence').range(range.from, range.to))
  const usage: SkillUsage = {}
  for (const row of rows) {
    if (!row.slug) continue
    const slug = row.slug.startsWith('kvittojakten-') ? 'kvittojakten' : row.slug
    const seen = usage[slug]
    if (!seen) usage[slug] = { count: 1, last_at: row.created_at }
    else {
      seen.count += 1
      if (row.created_at > seen.last_at) seen.last_at = row.created_at
    }
  }
  return usage
}
