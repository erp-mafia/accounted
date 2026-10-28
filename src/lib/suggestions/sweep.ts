/**
 * The scheduled side of suggestions: the daily pending-operations cron runs
 * the scheduled detectors (today only "Dölj <paket>?", behind
 * SUGGESTIONS_HIDE_UNUSED) over a slice of the companies.
 *
 * With every scheduled detector switched off (the default) it reads nothing.
 * Switched on, each run takes the companies whose id falls in today's
 * weekday bucket (every company once a week), skips archived companies,
 * companies that already show three open suggestions and companies without
 * an owner, and stages at most one suggestion per company per run, at most
 * `limit` companies per run, and stops when the run has used its time
 * budget (the cron's expiry and recovery passes come first; a company not
 * reached waits for next week). A company's run reads its capabilities and
 * one package_usage call. A sandbox company is never old enough for the
 * hide-unused window (the sandbox is cleaned up daily).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { SCHEDULED_DETECTORS } from './detectors'
import { MAX_OPEN_SUGGESTIONS } from './list'
import { createDetectorContext, runDetector } from './run'
import type { Detector } from './types'
import { toError } from '@/lib/errors/to-error'

/** Companies looked at per run at most. */
export const SWEEP_COMPANY_LIMIT = 300

/** Time a run may take before it stops, well inside the cron's own limit. */
export const SWEEP_TIME_BUDGET_MS = 45_000

export interface SweepSummary {
  ran: boolean
  companies: number
  staged: number
  skipped_full: number
  /** True when the time budget ended the run before every company of the day was looked at. */
  stopped_early: boolean
}

/** A stable weekday bucket (0 to 6) for a company id: every company is swept once a week. */
export function weekdayBucket(companyId: string): number {
  let hash = 0
  for (let i = 0; i < companyId.length; i++) hash = (hash * 31 + companyId.charCodeAt(i)) >>> 0
  return hash % 7
}

async function openSuggestionCount(supabase: SupabaseClient, companyId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from('company_suggestions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('state', 'open')
  return error ? null : (count ?? 0)
}

async function ownerOf(supabase: SupabaseClient, companyId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('company_members')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) return null
  return ((data ?? [])[0] as { user_id: string } | undefined)?.user_id ?? null
}

export async function runScheduledSuggestions(
  supabase: SupabaseClient,
  log: Logger,
  opts: {
    now?: Date
    limit?: number
    detectors?: readonly Detector<unknown>[]
    timeBudgetMs?: number
    /** Test seam for the time budget. */
    clock?: () => number
  } = {},
): Promise<SweepSummary> {
  const detectors = (opts.detectors ?? SCHEDULED_DETECTORS).filter((d) => !d.enabled || d.enabled())
  const summary: SweepSummary = { ran: false, companies: 0, staged: 0, skipped_full: 0, stopped_early: false }
  if (detectors.length === 0) return summary
  summary.ran = true

  const now = opts.now ?? new Date()
  const bucket = now.getUTCDay()
  const companies = await fetchAllRows<{ id: string }>(({ from, to }) =>
    supabase
      .from('companies')
      .select('id')
      .is('archived_at', null)
      .order('id', { ascending: true })
      .range(from, to),
  )
  const todays = companies.filter((c) => weekdayBucket(c.id) === bucket).slice(0, opts.limit ?? SWEEP_COMPANY_LIMIT)

  const clock = opts.clock ?? Date.now
  const started = clock()
  const budget = opts.timeBudgetMs ?? SWEEP_TIME_BUDGET_MS
  for (const company of todays) {
    if (clock() - started > budget) {
      summary.stopped_early = true
      log.warn('scheduled suggestions stopped at the time budget', { looked_at: summary.companies, of: todays.length })
      break
    }
    summary.companies++
    try {
      const open = await openSuggestionCount(supabase, company.id)
      if (open === null || open >= MAX_OPEN_SUGGESTIONS) {
        summary.skipped_full++
        continue
      }
      const userId = await ownerOf(supabase, company.id)
      if (!userId) continue
      const ctx = createDetectorContext({ supabase, companyId: company.id, userId, log, now })
      for (const detector of detectors) {
        const results = await runDetector(detector, ctx, null, { maxStaged: 1 })
        const staged = results.filter((r) => r.outcome.staged).length
        summary.staged += staged
        if (staged > 0) break
      }
    } catch (err) {
      log.error('scheduled suggestions failed for a company', toError(err), {
        companyId: company.id,
      })
    }
  }
  return summary
}
