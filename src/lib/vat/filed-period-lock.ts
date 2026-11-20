/**
 * How the books stand on the last day of a filed momsperiod, and the offer
 * that follows from it: lock the books through that day.
 *
 * Filing freezes nothing (see filed-period-changes.ts): what protects a filed
 * period is the company lock date, company_settings.bookkeeping_locked_through,
 * which the database enforces on every door. 74 of 3,939 companies had ever
 * set it (2026-11), because it was only ever offered on a settings page. It
 * is now offered where a declaration is filed or reported as filed: in the
 * period's filed line on the Moms page (filedPeriodLock) and in the answer of
 * the MCP tools that record or report a filing (booksLockOffer in
 * lib/operations/vat-filings.ts).
 *
 * Whether a day is shut for writes is the ledger kernel's verdict
 * (periodLockVerdict, the two layers the triggers read), never judged here.
 * The offer is made only while the period's last day is open: a lock date at
 * or past it covers the whole period, and a closed or locked räkenskapsår
 * holds the day by its own flag. The offered date is always that last day, so
 * taking the offer can only move the lock date forward.
 *
 * The lock date holds every earlier day too, so it also stops the bokslut of
 * a räkenskapsår that ends on or before it and is not closed yet (a company
 * that files January before last year's books are closed). The offer says so
 * before it is taken: openYearEnd is that year's last day.
 *
 * One rule for both doors: the Moms page calls filedPeriodLock with the
 * settings and fiscal years it already holds (this module is client-safe),
 * and the MCP tools read the same two facts through readFiledPeriodLock.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { periodLockVerdict, type PeriodLockFacts } from '@/lib/core/bookkeeping/period-status'

export type FiledPeriodLock =
  /** The company lock date covers the period: nothing in it can change. */
  | { state: 'locked'; through: string }
  /** The räkenskapsår holding the period's last day is closed or locked. */
  | { state: 'year_shut' }
  /**
   * The period's last day is open for writes: the lock can be offered.
   * openYearEnd is the last day of the newest räkenskapsår the lock would
   * hold although it is not closed yet, or null when there is none.
   */
  | { state: 'open'; lockThrough: string; openYearEnd: string | null }

/** A fiscal year as the verdict reads it, with the dates that place it. */
export type FiscalYearLockFacts = PeriodLockFacts & { period_start: string; period_end: string }

export function filedPeriodLock(
  periodEnd: string,
  lockedThrough: string | null | undefined,
  fiscalYears: readonly FiscalYearLockFacts[],
): FiledPeriodLock {
  const year = fiscalYears.find((fy) => fy.period_start <= periodEnd && periodEnd <= fy.period_end) ?? null
  const { status, layer } = periodLockVerdict(periodEnd, lockedThrough ?? null, year)
  if (layer === 'company_lock_date' && status.lock_date) return { state: 'locked', through: status.lock_date }
  if (layer === 'fiscal_period') return { state: 'year_shut' }
  // An unclosed year whose last day a lock date of periodEnd would hold.
  const heldOpenYears = fiscalYears
    .filter((fy) => !fy.is_closed && periodLockVerdict(fy.period_end, periodEnd, null).layer === 'company_lock_date')
    .map((fy) => fy.period_end)
    .sort()
  return { state: 'open', lockThrough: periodEnd, openYearEnd: heldOpenYears.at(-1) ?? null }
}

/**
 * filedPeriodLock for a door that holds neither the settings nor the fiscal
 * years (the MCP tools): the same verdict, on two reads. A lock that could not
 * be read is never reported as open: the answer is then null, and the door
 * offers nothing.
 */
export async function readFiledPeriodLock(
  supabase: SupabaseClient,
  companyId: string,
  periodEnd: string,
): Promise<FiledPeriodLock | null> {
  const [settings, years] = await Promise.all([
    supabase.from('company_settings').select('bookkeeping_locked_through').eq('company_id', companyId).maybeSingle(),
    // A company's räkenskapsår: a handful of rows, far under PostgREST's cap.
    supabase.from('fiscal_periods').select('id, period_start, period_end, is_closed, locked_at').eq('company_id', companyId),
  ])
  if (settings.error || years.error) return null
  const lockedThrough = (settings.data as { bookkeeping_locked_through?: string | null } | null)?.bookkeeping_locked_through
  return filedPeriodLock(periodEnd, lockedThrough, (years.data ?? []) as FiscalYearLockFacts[])
}
