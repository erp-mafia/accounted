/**
 * The period verdict for one date: "can a verifikation with this entry_date
 * be posted right now?", read the way the DB triggers enforce it.
 *
 * Its own module, apart from period-service, so a caller that only needs the
 * verdict does not import the event bus: period-service imports
 * '@/lib/events', whose bus lazily imports the whole composition root
 * (lib/init and every extension), and a v1 route that reached it through the
 * staging code compiled about 1,550 files instead of about 120. period-service
 * re-exports everything here, so existing imports keep working.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('period-service')

export type PeriodStatusValue = 'open' | 'locked' | 'closed'

export interface PeriodStatusForDate {
  period_id: string | null
  status: PeriodStatusValue
  /**
   * For `locked` status: either the period's `locked_at` timestamp (ISO) or the
   * company-wide `bookkeeping_locked_through` date (ISO), whichever applies.
   * `null` for open/closed, and `null` when `lookup_failed` is true.
   */
  lock_date: string | null
  /**
   * True when the lock lookup itself failed (PostgREST error, an overlapping
   * fiscal_periods pair breaking `.maybeSingle()`, a network blip). `status`
   * is then reported as `'locked'`, because a period whose state we could not
   * read must never be presented as writable.
   *
   * Keep the three cases distinguishable, callers treat them differently:
   *   { status: 'open',   period_id: <id>  }              -> verified open
   *   { status: 'open',   period_id: null  }              -> verified: no
   *       covering period exists at all. Not an error: the engine's
   *       ensure-period helper creates one on write.
   *   { status: 'locked', period_id: null, lookup_failed } -> unverified.
   *       Nothing is known about the date. Retryable; a genuinely locked
   *       period always carries a real period_id or lock_date.
   *
   * Deliberately an additive optional field rather than a fourth
   * `PeriodStatusValue`: the union is consumed as an exhaustive
   * `Record<PeriodStatusValue, string>` in lib/agent/intents/bokslut-step.ts,
   * so widening it would break unrelated callers at compile time.
   */
  lookup_failed?: boolean
}

/**
 * Fail-closed verdict for a lock lookup that could not be completed.
 *
 * Reported as `locked` on purpose. The alternative (`open`) is the bug this
 * exists to prevent: every caller of resolvePeriodStatusForDate uses the
 * result to decide whether a write into a period is allowed, so a swallowed
 * query error used to read as "go ahead" on the storno, MCP staging, agent
 * draft and pending-operation commit paths.
 */
function periodLookupFailed(
  companyId: string,
  date: string,
  stage: 'company_settings' | 'fiscal_periods',
  error: { message?: string } | null,
): PeriodStatusForDate {
  log.error('period status lookup failed, failing closed', {
    companyId,
    date,
    stage,
    reason: error?.message,
  })
  return { period_id: null, status: 'locked', lock_date: null, lookup_failed: true }
}

/**
 * Resolve the period status for a given affärshändelse date: answers
 * "can a verifikation with this entry_date be posted right now?" using the
 * same two-layer logic the DB triggers enforce:
 *
 *   1. company-wide bookkeeping_locked_through (covers everything on/before)
 *   2. the fiscal_period covering the date (is_closed or locked_at)
 *
 * Returned shape is the canonical `period_status` envelope threaded into MCP
 * tool responses so agents and widgets can disable writes without round-trips.
 *
 * Fails CLOSED: if either lookup errors we report `locked` with
 * `lookup_failed: true` rather than `open`. Never reintroduce a bare
 * `const { data } = await ...` here; dropping the `error` is what turned this
 * shared helper into a fail-open on every write path that consults it.
 *
 * The v1 REST surface reads the same verdict through
 * lib/api/v1/check-period-lock.ts (resolvePeriodLockForDate below).
 */
export async function resolvePeriodStatusForDate(
  supabase: SupabaseClient,
  companyId: string,
  date: string,
): Promise<PeriodStatusForDate> {
  return (await resolvePeriodLockForDate(supabase, companyId, date)).status
}

/** The layer that decided a `locked` verdict. */
export type PeriodLockLayer = 'company_lock_date' | 'fiscal_period'

/**
 * resolvePeriodStatusForDate's verdict plus the layer that locked it, for a
 * caller that reports the reason (v1 PERIOD_LOCKED details). Kept off the
 * period_status envelope so MCP responses do not grow. `layer` is null when
 * the date is open or the lookup failed.
 */
export async function resolvePeriodLockForDate(
  supabase: SupabaseClient,
  companyId: string,
  date: string,
): Promise<{ status: PeriodStatusForDate; layer: PeriodLockLayer | null }> {
  // Layer 1: company-wide lock date.
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) {
    // Unknown company lock date: the date could be behind it. Fail closed.
    return { status: periodLookupFailed(companyId, date, 'company_settings', settingsError), layer: null }
  }
  const lockThrough = settings?.bookkeeping_locked_through ?? null
  if (lockThrough && date <= lockThrough) {
    // Find the covering period if any: useful for widget greying. An error
    // here is deliberately non-fatal: the verdict is already `locked` on the
    // company lock date alone, so a failed refinement can only cost the
    // period_id, never flip the answer to open.
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('company_id', companyId)
      .lte('period_start', date)
      .gte('period_end', date)
      .maybeSingle()
    return {
      status: { period_id: period?.id ?? null, status: 'locked', lock_date: lockThrough },
      layer: 'company_lock_date',
    }
  }

  // Layer 2: fiscal period status.
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, is_closed, locked_at')
    .eq('company_id', companyId)
    .lte('period_start', date)
    .gte('period_end', date)
    .maybeSingle()

  if (periodError) {
    // Distinct from `!period` below: that is "verified, no covering period
    // exists"; this is "we do not know what period covers this date".
    return { status: periodLookupFailed(companyId, date, 'fiscal_periods', periodError), layer: null }
  }

  if (!period) {
    // No covering period: treated as open at this layer; the engine's own
    // ensure-period helper will create one. Agents should still warn the user.
    return { status: { period_id: null, status: 'open', lock_date: null }, layer: null }
  }
  if (period.is_closed) {
    return { status: { period_id: period.id, status: 'closed', lock_date: null }, layer: 'fiscal_period' }
  }
  if (period.locked_at) {
    return { status: { period_id: period.id, status: 'locked', lock_date: period.locked_at }, layer: 'fiscal_period' }
  }
  return { status: { period_id: period.id, status: 'open', lock_date: null }, layer: null }
}
