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
 * The verdict is resolvePeriodStatusForDate's (lib/core/bookkeeping/
 * period-service.ts), the one definition MCP staging, storno and the
 * pending-operation commit read, put in v1's shape. It used to repeat the
 * queries and drop their errors, so a failed lookup answered "open"; it now
 * answers locked with reason `lookup_failed`, which is retryable.
 *
 * Note: this is a TOCTOU-window check (a period could be locked between
 * the check and the insert), but the trigger is still authoritative. The
 * helper is for ergonomics, not security.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolvePeriodLockForDate } from '@/lib/core/bookkeeping/period-service'

export interface PeriodLockVerdict {
  locked: boolean
  reason?:
    | 'company_lock_date_covers'
    | 'period_locked_at_set'
    | 'period_is_closed'
    | 'no_fiscal_period'
    | 'lookup_failed'
  fiscal_period_id?: string
}

export async function checkPeriodLock(
  supabase: SupabaseClient,
  companyId: string,
  date: string,
): Promise<PeriodLockVerdict> {
  const { status, layer } = await resolvePeriodLockForDate(supabase, companyId, date)
  if (status.lookup_failed) return { locked: true, reason: 'lookup_failed' }

  const period = status.period_id ? { fiscal_period_id: status.period_id } : {}
  if (layer === 'company_lock_date') return { locked: true, reason: 'company_lock_date_covers', ...period }
  if (status.status === 'closed') return { locked: true, reason: 'period_is_closed', ...period }
  if (status.status === 'locked') return { locked: true, reason: 'period_locked_at_set', ...period }
  // No covering period. The engine's own ensure-period helper creates one
  // (open, unlocked) for ad-hoc booking dates, so this is not a hard lock;
  // let the JE insert proceed and surface engine errors normally.
  if (!status.period_id) return { locked: false, reason: 'no_fiscal_period' }
  return { locked: false, ...period }
}
