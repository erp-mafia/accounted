/**
 * Application-layer period-lock check used by Phase 3 v1 write routes.
 *
 * The DB has two layers of protection:
 *   - `enforce_period_lock` trigger blocks writes to any journal entry
 *     whose fiscal_period is `is_closed = TRUE` or has `locked_at` set.
 *   - `enforce_company_lock_date` trigger blocks writes on/before the
 *     company-wide `bookkeeping_locked_through` date.
 *
 * Both triggers raise a Postgres exception, which Supabase surfaces as a
 * generic 500 with `BOOKKEEPING_DB_ERROR`. For the public API we want a
 * structured `PERIOD_LOCKED` response with enough context for an agent to
 * decide between (a) post to a later period or (b) ask the user to unlock.
 *
 * This helper performs the same check the trigger would, returning a
 * { locked, reason, fiscal_period_id } verdict. Run it BEFORE the JE insert
 * so callers get the structured error instead of the trigger exception.
 *
 * Note: this is a TOCTOU-window check (a period could be locked between
 * the check and the insert), but the trigger is still authoritative. The
 * helper is for ergonomics, not security.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface PeriodLockVerdict {
  locked: boolean
  reason?:
    | 'company_lock_date_covers'
    | 'period_locked_at_set'
    | 'period_is_closed'
    | 'no_fiscal_period'
  fiscal_period_id?: string
}

export async function checkPeriodLock(
  supabase: SupabaseClient,
  companyId: string,
  date: string,
): Promise<PeriodLockVerdict> {
  // Company-wide lock date covers everything on/before bookkeeping_locked_through.
  const { data: settings } = await supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', companyId)
    .maybeSingle()
  const lockThrough = settings?.bookkeeping_locked_through ?? null
  if (lockThrough && date <= lockThrough) {
    return { locked: true, reason: 'company_lock_date_covers' }
  }

  // Find the fiscal period covering the date.
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('id, is_closed, locked_at')
    .eq('company_id', companyId)
    .lte('period_start', date)
    .gte('period_end', date)
    .maybeSingle()

  if (!period) {
    // No covering period. The engine's own ensure-period helper will create
    // one (open, unlocked) for ad-hoc booking dates, so this is not a hard
    // lock; let the JE insert proceed and surface engine errors normally.
    return { locked: false, reason: 'no_fiscal_period' }
  }
  if (period.is_closed) {
    return { locked: true, reason: 'period_is_closed', fiscal_period_id: period.id }
  }
  if (period.locked_at) {
    return { locked: true, reason: 'period_locked_at_set', fiscal_period_id: period.id }
  }

  return { locked: false, fiscal_period_id: period.id }
}
