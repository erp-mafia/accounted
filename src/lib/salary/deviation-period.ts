import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Avvikelseperiod: the calendar window a salary run reads its deviations
 * (absence days, worked days, shift premiums) from.
 *
 * The fixed salary always belongs to the pay month (period_year /
 * period_month). The deviations may belong to the same month or to the
 * month before it ("innevarande månads lön, föregående månads avvikelser"),
 * which is how most Swedish payroll runs are actually operated: the
 * calendar for the pay month is not complete on pay day.
 *
 * The window is snapshotted on the run (salary_runs.deviation_period_start
 * / _end) when the run is created, from company_settings.salary_deviation_period
 * or from explicit dates the API caller passes. Everything downstream (the
 * calculation engine, the AGI frånvarouppgifter, the payslip) reads the run
 * columns, never the setting, so flipping the setting later cannot move an
 * already-calculated run. NULL columns mean "the pay month itself", which is
 * exactly what every run created before the columns existed meant.
 */

export const SALARY_DEVIATION_PERIOD_SETTINGS = ['same_month', 'previous_month'] as const
export type SalaryDeviationPeriodSetting = (typeof SALARY_DEVIATION_PERIOD_SETTINGS)[number]

export interface DateWindow {
  /** ISO date, inclusive. */
  start: string
  /** ISO date, inclusive. */
  end: string
}

/** Longest explicit window accepted: two months. Anything longer is a typo. */
export const DEVIATION_WINDOW_MAX_DAYS = 62

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ONE_DAY_MS = 24 * 60 * 60 * 1000

export type SalaryDeviationPeriodErrorCode =
  | 'SALARY_RUN_DEVIATION_PERIOD_INVALID'
  | 'SALARY_RUN_DEVIATION_PERIOD_OVERLAP'

/**
 * Thrown by the resolver and the overlap guard. Routes map the code to the
 * structured-error registry (400 for invalid input, 409 for an overlap).
 */
export class SalaryDeviationPeriodError extends Error {
  readonly code: SalaryDeviationPeriodErrorCode
  readonly details: Record<string, unknown>

  constructor(code: SalaryDeviationPeriodErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'SalaryDeviationPeriodError'
    this.code = code
    this.details = details
  }
}

export function isSalaryDeviationPeriodSetting(value: unknown): value is SalaryDeviationPeriodSetting {
  return typeof value === 'string' && (SALARY_DEVIATION_PERIOD_SETTINGS as readonly string[]).includes(value)
}

/** First and last day of a calendar month, ISO dates. */
export function monthWindow(year: number, month: number): DateWindow {
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  return { start, end }
}

export function previousMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 }
}

/** The window a company setting implies for a given pay month. */
export function defaultDeviationWindow(
  periodYear: number,
  periodMonth: number,
  setting: SalaryDeviationPeriodSetting,
): DateWindow {
  if (setting === 'previous_month') {
    const prev = previousMonth(periodYear, periodMonth)
    return monthWindow(prev.year, prev.month)
  }
  return monthWindow(periodYear, periodMonth)
}

export interface RunDeviationSource {
  period_year: number
  period_month: number
  deviation_period_start?: string | null
  deviation_period_end?: string | null
}

/**
 * The effective window of an existing run. Stored bounds win; runs without
 * them (every run created before the columns existed) read the pay month.
 */
export function runDeviationWindow(run: RunDeviationSource): DateWindow {
  if (run.deviation_period_start && run.deviation_period_end) {
    return { start: run.deviation_period_start, end: run.deviation_period_end }
  }
  return monthWindow(run.period_year, run.period_month)
}

/** True when the run's window is not simply its own pay month. */
export function hasCustomDeviationWindow(run: RunDeviationSource): boolean {
  const effective = runDeviationWindow(run)
  const payMonth = monthWindow(run.period_year, run.period_month)
  return effective.start !== payMonth.start || effective.end !== payMonth.end
}

function daysInclusive(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / ONE_DAY_MS) + 1
}

/**
 * Validate an explicit window from an API caller. Both bounds, ISO dates,
 * not inverted, at most two months long.
 */
export function validateExplicitWindow(start: unknown, end: unknown): DateWindow {
  const invalid = (reason: string) =>
    new SalaryDeviationPeriodError(
      'SALARY_RUN_DEVIATION_PERIOD_INVALID',
      `Invalid deviation period: ${reason}`,
      { reason, deviation_period_start: start, deviation_period_end: end },
    )
  if (typeof start !== 'string' || typeof end !== 'string') {
    throw invalid('deviation_period_start and deviation_period_end must both be set')
  }
  if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end)) {
    throw invalid('dates must be YYYY-MM-DD')
  }
  const startMs = Date.parse(`${start}T00:00:00Z`)
  const endMs = Date.parse(`${end}T00:00:00Z`)
  // Date.parse normalises an overflowed day (2026-02-30 becomes March 2), so
  // the parsed value has to round-trip to the same string to count as real.
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    new Date(startMs).toISOString().slice(0, 10) !== start ||
    new Date(endMs).toISOString().slice(0, 10) !== end
  ) {
    throw invalid('dates must be real calendar dates')
  }
  if (startMs > endMs) {
    throw invalid('deviation_period_start must not be after deviation_period_end')
  }
  if (daysInclusive(start, end) > DEVIATION_WINDOW_MAX_DAYS) {
    throw invalid(`the window must not exceed ${DEVIATION_WINDOW_MAX_DAYS} days`)
  }
  return { start, end }
}

export interface ResolvedDeviationWindow {
  window: DateWindow
  /** Where the window came from: caller-supplied dates or the company setting. */
  source: 'explicit' | 'setting'
  setting: SalaryDeviationPeriodSetting
}

/**
 * Decide the window for a run that is about to be created. Explicit dates
 * win; otherwise company_settings.salary_deviation_period decides. A missing
 * settings row behaves as 'same_month'.
 */
export async function resolveDeviationWindowForNewRun(
  supabase: SupabaseClient,
  companyId: string,
  params: {
    periodYear: number
    periodMonth: number
    explicitStart?: string | null
    explicitEnd?: string | null
  },
): Promise<ResolvedDeviationWindow> {
  const { data: settings, error } = await supabase
    .from('company_settings')
    .select('salary_deviation_period')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to load salary settings: ${error.message}`)
  }
  const raw = (settings as { salary_deviation_period?: unknown } | null)?.salary_deviation_period
  const setting: SalaryDeviationPeriodSetting = isSalaryDeviationPeriodSetting(raw) ? raw : 'same_month'

  const hasStart = params.explicitStart != null && params.explicitStart !== ''
  const hasEnd = params.explicitEnd != null && params.explicitEnd !== ''
  if (hasStart || hasEnd) {
    return {
      window: validateExplicitWindow(params.explicitStart, params.explicitEnd),
      source: 'explicit',
      setting,
    }
  }
  return {
    window: defaultDeviationWindow(params.periodYear, params.periodMonth, setting),
    source: 'setting',
    setting,
  }
}

function windowsOverlap(a: DateWindow, b: DateWindow): boolean {
  return a.start <= b.end && b.start <= a.end
}

/**
 * Refuse a window that overlaps another live run of the same company. Two
 * runs reading the same calendar day would deduct the same sick day twice
 * (or pay the same worked hours twice). A corrected original is skipped, its
 * correction run is not: the correction is the live reader of that window
 * and must keep blocking a third, unrelated run. (Correction runs are created
 * by the correct route, which inherits the window and never calls this.)
 *
 * The typical trigger is a mid-stream switch of the company setting: the
 * August run already read August, so a September run under 'previous_month'
 * would read August again. The error names the conflicting run so the
 * caller can pass an explicit non-overlapping window instead.
 */
export async function assertNoDeviationOverlap(
  supabase: SupabaseClient,
  companyId: string,
  window: DateWindow,
): Promise<void> {
  const { data, error } = await supabase
    .from('salary_runs')
    .select('id, period_year, period_month, deviation_period_start, deviation_period_end')
    .eq('company_id', companyId)
    .neq('status', 'corrected')
  if (error) {
    throw new Error(`Failed to check deviation period overlap: ${error.message}`)
  }
  const rows = (Array.isArray(data) ? data : []) as Array<RunDeviationSource & { id: string }>
  for (const row of rows) {
    const other = runDeviationWindow(row)
    if (windowsOverlap(window, other)) {
      throw new SalaryDeviationPeriodError(
        'SALARY_RUN_DEVIATION_PERIOD_OVERLAP',
        `Deviation period ${window.start}..${window.end} overlaps salary run ${row.id} (${other.start}..${other.end})`,
        {
          conflicting_run_id: row.id,
          conflicting_period_year: row.period_year,
          conflicting_period_month: row.period_month,
          conflicting_window_start: other.start,
          conflicting_window_end: other.end,
          deviation_period_start: window.start,
          deviation_period_end: window.end,
        },
      )
    }
  }
}
