/**
 * May this posted line's dimension tags change? Asked without writing.
 *
 * The retag_line_dimensions RPC refuses a line whose verifikat sits in a
 * closed or locked fiscal period, or on or before the company lock date:
 * past a lock the tags change with a rättelseverifikat, like everything
 * else on the line. That refusal used to be learned only by trying the
 * write, so a preview counted the lines a filter matched and an approval
 * tagged fewer, without a word (crm#1908).
 *
 * This is the one place a retag door asks the question before the write. The
 * verdict itself is periodLockVerdict (lib/core/bookkeeping/period-status.ts),
 * the one every other door reads; here it is asked for many lines on two
 * reads. The preview and the commit both call retagBlockOf, so they give the
 * same answer for the same state. The RPC stays the gate: it checks again at
 * the write, and a period locked in between is refused there.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { periodLockVerdict, type PeriodLockFacts } from '@/lib/core/bookkeeping/period-status'
import { dbError } from '@/lib/errors/db-error'

export const RETAG_BLOCK_REASONS = ['period_closed', 'period_locked', 'company_lock_date'] as const
export type RetagBlockReason = (typeof RETAG_BLOCK_REASONS)[number]

/** What the lock check reads of the verifikat a line belongs to. */
export interface RetagLockSubject {
  entry_date: string
  fiscal_period_id: string | null
}

export interface RetagLockFacts {
  /** company_settings.bookkeeping_locked_through: everything on or before it is locked. */
  lockThrough: string | null
  /** The fiscal periods the verifikat belong to, by id. */
  periods: ReadonlyMap<string, PeriodLockFacts>
}

export interface RetagBlock {
  reason: RetagBlockReason
  /** The Swedish refusal: the sentence the RPC raises for the same state. */
  message: string
}

/** Period ids per `.in()` query: keeps the request URL short. */
const PERIOD_ID_CHUNK = 100

/**
 * The lock state of the company and of the given fiscal periods. Throws when
 * either read fails: a period whose state could not be read is never shown
 * as open.
 */
export async function fetchRetagLockFacts(
  supabase: SupabaseClient,
  companyId: string,
  periodIds: Iterable<string | null | undefined>,
): Promise<RetagLockFacts> {
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) throw dbError(settingsError)
  const lockThrough = ((settings as { bookkeeping_locked_through?: string | null } | null)?.bookkeeping_locked_through) ?? null

  const ids = [...new Set([...periodIds].filter((id): id is string => typeof id === 'string' && id !== ''))]
  const periods = new Map<string, PeriodLockFacts>()
  for (let i = 0; i < ids.length; i += PERIOD_ID_CHUNK) {
    // At most PERIOD_ID_CHUNK rows by primary key: under PostgREST's 1000-row cap.
    const { data, error } = await supabase
      .from('fiscal_periods')
      .select('id, is_closed, locked_at')
      .eq('company_id', companyId)
      .in('id', ids.slice(i, i + PERIOD_ID_CHUNK))
    if (error) throw dbError(error)
    for (const period of (data ?? []) as PeriodLockFacts[]) periods.set(period.id, period)
  }
  return { lockThrough, periods }
}

const STORNO_HINT = 'använd rättelseverifikat (storno)'

/**
 * Why a line of this verifikat cannot be retagged, else null. The period's
 * own state is asked before the company lock date, as the RPC does: a closed
 * period stays closed wherever the lock date is moved, so it is the reason to
 * give. A verifikat whose period is not among the facts is judged on the lock
 * date alone, which is also what the RPC does with a period it cannot find.
 */
export function retagBlockOf(facts: RetagLockFacts, subject: RetagLockSubject): RetagBlock | null {
  const period = subject.fiscal_period_id ? facts.periods.get(subject.fiscal_period_id) ?? null : null
  const ownPeriod = periodLockVerdict(subject.entry_date, null, period).status.status
  if (ownPeriod === 'closed') {
    return { reason: 'period_closed', message: `Perioden är stängd: ${STORNO_HINT} för att ändra dimensioner.` }
  }
  if (ownPeriod === 'locked') {
    return { reason: 'period_locked', message: `Perioden är låst: ${STORNO_HINT} för att ändra dimensioner.` }
  }
  if (periodLockVerdict(subject.entry_date, facts.lockThrough, period).layer === 'company_lock_date') {
    return {
      reason: 'company_lock_date',
      message: `Bokföringen är låst t.o.m. ${facts.lockThrough}: ${STORNO_HINT}.`,
    }
  }
  return null
}
