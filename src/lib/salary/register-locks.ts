/**
 * Register locks: the calendar dates a salary run has already read.
 *
 * A run in review, approved, paid or booked has consumed the absence and
 * worked-days registers for its avvikelseperiod (the deviation window,
 * salary_runs.deviation_period_start..deviation_period_end, NULL = the pay
 * month). Writing to those dates afterwards would make the register disagree
 * with what was calculated, paid or booked, silently: the payslip says one
 * thing, the register another, and AGI frånvarouppgifter are derived from the
 * register. So the registers refuse. Before any write, lib/salary/absence.ts
 * and lib/salary/worked-days.ts ask this module whether a locking run reads
 * any of the target dates and return SALARY_REGISTER_DATES_LOCKED_BY_RUN when
 * one does.
 *
 * Draft runs never lock: they recalculate on demand, so the register is still
 * the input. A corrected original (status 'corrected') never locks either:
 * its correction run reads the same window and is the live reader, so that
 * run locks in its place. The way out of a lock is to revert the run to
 * draft (dashboard) or, for a booked run, to make a correction run and
 * register the days against it.
 *
 * Dry runs go through the same check: a preview that hides the lock is not a
 * preview of what the write would do.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { runDeviationWindow, type DateWindow, type RunDeviationSource } from './deviation-period'

/** Run statuses whose deviation window locks the registers. */
export const REGISTER_LOCKING_RUN_STATUSES = ['review', 'approved', 'paid', 'booked'] as const

export type RegisterLockingRunStatus = (typeof REGISTER_LOCKING_RUN_STATUSES)[number]

/**
 * The run that locks a write and the dates it locks. The field names are the
 * `details` of SALARY_REGISTER_DATES_LOCKED_BY_RUN as consumers surface them.
 */
export type RegisterRunLock = {
  salary_run_id: string
  status: RegisterLockingRunStatus
  period_year: number
  period_month: number
  /** The effective window, ISO dates inclusive (the pay month for a legacy NULL window). */
  deviation_period_start: string
  deviation_period_end: string
  /** The target dates inside that window, ISO, sorted, unique. */
  locked_dates: string[]
}

export type RegisterLockResult =
  | { ok: true; lock: RegisterRunLock | null }
  | { ok: false; code: 'INTERNAL_ERROR'; details: { message: string } }

/**
 * The failure a register module returns when a write may not proceed:
 * either the lock itself or a failed lookup. Shaped to slot straight into
 * AbsenceResult / WorkedDaysResult.
 */
export type RegisterLockFailure =
  | { ok: false; code: 'INTERNAL_ERROR'; details: { message: string } }
  | { ok: false; code: 'SALARY_REGISTER_DATES_LOCKED_BY_RUN'; details: RegisterRunLock }

export const SALARY_REGISTER_DATES_LOCKED_BY_RUN = 'SALARY_REGISTER_DATES_LOCKED_BY_RUN'

type LockingRunRow = RunDeviationSource & { id: string; status: RegisterLockingRunStatus }

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/** Every ISO date in [start, end], inclusive. Bounded by the window (at most two months). */
function datesBetween(start: string, end: string): string[] {
  const startMs = Date.parse(`${start}T00:00:00Z`)
  const endMs = Date.parse(`${end}T00:00:00Z`)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return []
  const dates: string[] = []
  for (let t = startMs; t <= endMs; t += ONE_DAY_MS) {
    dates.push(new Date(t).toISOString().slice(0, 10))
  }
  return dates
}

function byPeriod(a: LockingRunRow, b: LockingRunRow): number {
  return a.period_year - b.period_year || a.period_month - b.period_month
}

/**
 * Load the company's locking runs (one query, literal select) and report the
 * earliest one whose window contains any target date. `pick` decides which
 * dates of a window count as hit: the explicit dates for an upsert, the
 * intersection with the range for a delete.
 */
async function findLock(
  supabase: SupabaseClient,
  companyId: string,
  pick: (window: DateWindow) => string[],
): Promise<RegisterLockResult> {
  const { data, error } = await supabase
    .from('salary_runs')
    .select('id, status, period_year, period_month, deviation_period_start, deviation_period_end')
    .eq('company_id', companyId)
    .in('status', [...REGISTER_LOCKING_RUN_STATUSES])

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }

  const lockingStatuses: readonly string[] = REGISTER_LOCKING_RUN_STATUSES
  const runs = ((Array.isArray(data) ? data : []) as LockingRunRow[])
    // The query already filters by status; re-checked here so the rule does
    // not depend on the query shape: a draft or corrected row can never lock.
    .filter((run) => lockingStatuses.includes(run.status))
    .sort(byPeriod)
  for (const run of runs) {
    const window = runDeviationWindow(run)
    const locked = Array.from(new Set(pick(window))).sort()
    if (locked.length === 0) continue
    return {
      ok: true,
      lock: {
        salary_run_id: run.id,
        status: run.status,
        period_year: run.period_year,
        period_month: run.period_month,
        deviation_period_start: window.start,
        deviation_period_end: window.end,
        locked_dates: locked,
      },
    }
  }
  return { ok: true, lock: null }
}

/**
 * The run (if any) whose deviation window contains one or more of `dates`.
 * An empty list never queries: nothing to lock.
 */
export async function findRunLockingDates(
  supabase: SupabaseClient,
  companyId: string,
  dates: readonly string[],
): Promise<RegisterLockResult> {
  if (dates.length === 0) return { ok: true, lock: null }
  return findLock(supabase, companyId, (window) =>
    dates.filter((d) => d >= window.start && d <= window.end),
  )
}

/**
 * The run (if any) whose deviation window overlaps [from, to]. Used by range
 * deletes: computed from the range, not from the rows it would delete, so the
 * check stays one query. locked_dates is the overlap, expanded per day.
 */
export async function findRunLockingRange(
  supabase: SupabaseClient,
  companyId: string,
  from: string,
  to: string,
): Promise<RegisterLockResult> {
  return findLock(supabase, companyId, (window) =>
    datesBetween(from > window.start ? from : window.start, to < window.end ? to : window.end),
  )
}

function toFailure(result: RegisterLockResult): RegisterLockFailure | null {
  if (!result.ok) return result
  if (!result.lock) return null
  return { ok: false, code: SALARY_REGISTER_DATES_LOCKED_BY_RUN, details: result.lock }
}

/**
 * Guard for a write that targets explicit dates. Returns the failure to hand
 * back, or null when the write may proceed.
 */
export async function assertRegisterDatesUnlocked(
  supabase: SupabaseClient,
  companyId: string,
  dates: readonly string[],
): Promise<RegisterLockFailure | null> {
  return toFailure(await findRunLockingDates(supabase, companyId, dates))
}

/**
 * Guard for a write that targets a date range (range deletes). Returns the
 * failure to hand back, or null when the write may proceed.
 */
export async function assertRegisterRangeUnlocked(
  supabase: SupabaseClient,
  companyId: string,
  from: string,
  to: string,
): Promise<RegisterLockFailure | null> {
  return toFailure(await findRunLockingRange(supabase, companyId, from, to))
}
