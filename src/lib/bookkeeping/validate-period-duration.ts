/**
 * The BFL 3 kap. shape of a räkenskapsår: the one definition every door reads,
 * with the fiscal_periods triggers as the legal floor.
 * Maximum 18 months for any fiscal period (first year may be extended).
 * Normal ongoing periods are 12 months. There is NO minimum length: BFL
 * 3 kap 3 § expressly allows a räkenskapsår shorter than 12 months when
 * bokföringsskyldigheten begins or the year is re-laid, with no floor
 * (Bolagsverket: the first year may be "hur kort som helst"). A form bound to
 * the calendar year (fiscalYearLockedToCalendar, an enskild firma) ends on 31
 * December, and only its first year may start after 1 January.
 */

/**
 * Parse a YYYY-MM-DD string into numeric parts without timezone issues.
 * Using new Date(dateStr) is unsafe because it creates UTC midnight,
 * but getDate()/getMonth()/getFullYear() return local-timezone values:
 * shifting the date by -1 day in Western timezones.
 */
export function parseDateParts(dateStr: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateStr.split('-').map(Number)
  return { year, month, day }
}

/**
 * Calculate the number of months between two dates (inclusive of partial months).
 * Uses year/month arithmetic only: a mid-month start counts the start month fully,
 * which is conservative for the 18-month cap check.
 */
export function monthsBetween(start: string, end: string): number {
  const s = parseDateParts(start)
  const e = parseDateParts(end)
  return (e.year - s.year) * 12 + (e.month - s.month) + 1
}

/**
 * Whether a räkenskapsår runs past the 18 months of BFL 3 kap., counted as
 * monthsBetween counts: a mid-month start takes its month in full, which also
 * puts a year starting on the last of a month over the line by that one day.
 */
export function exceedsFiscalYearCap(start: string, end: string): boolean {
  return monthsBetween(start, end) > 18
}

/**
 * A company's first räkenskapsår is the one no recorded year starts before.
 * The year behind a gap has an earlier year, so it is not the first; a lone
 * year starting on the 1st stays first, because the app cannot know of years
 * kept elsewhere. `otherStarts` may hold `start` itself.
 */
export function isFirstFiscalPeriod(start: string, otherStarts: readonly string[]): boolean {
  return !otherStarts.some((other) => other < start)
}

export interface ValidatePeriodOptions {
  /** Allow any start day (not just 1st of month) for the first fiscal period per BFL 3 kap. */
  isFirstPeriod?: boolean
  /** The form is bound to the calendar year (fiscalYearLockedToCalendar). */
  calendarYearOnly?: boolean
}

/** Which BFL 3 kap. shape rule a period's dates break. */
export type PeriodDurationRule =
  | 'end_not_after_start'
  | 'not_calendar_year_end'
  | 'not_calendar_year_start'
  | 'start_not_first_of_month'
  | 'end_not_month_end'
  | 'exceeds_18_months'

export interface PeriodDurationIssue {
  rule: PeriodDurationRule
  /** The English sentence validatePeriodDuration has always returned. */
  message: string
  /** Calendar months counted, set for exceeds_18_months. */
  months?: number
}

/**
 * Validate a fiscal period's duration and date constraints, naming the rule
 * that failed so a caller can answer a stable error code. Returns null if
 * valid.
 */
export function checkPeriodDuration(
  start: string,
  end: string,
  options?: ValidatePeriodOptions,
): PeriodDurationIssue | null {
  const startParts = parseDateParts(start)
  const endParts = parseDateParts(end)

  // end must be after start (YYYY-MM-DD strings are lexicographically orderable)
  if (end <= start) {
    return { rule: 'end_not_after_start', message: 'Period end must be after period start' }
  }

  if (options?.calendarYearOnly) {
    if (endParts.month !== 12 || endParts.day !== 31) {
      return { rule: 'not_calendar_year_end', message: 'Period end must be 31 December for a calendar-year form (BFL 3 kap.)' }
    }
    if (!options.isFirstPeriod && (startParts.month !== 1 || startParts.day !== 1)) {
      return { rule: 'not_calendar_year_start', message: 'Period start must be 1 January for a calendar-year form (BFL 3 kap.)' }
    }
  }

  // start must be 1st of month: unless this is the first fiscal period (BFL 3
  // kap. 1 § for subsequent years, 3 kap. 3 § for the first). Say why and what
  // is allowed, not only "no" (issue #2237).
  if (startParts.day !== 1 && !options?.isFirstPeriod) {
    return {
      rule: 'start_not_first_of_month',
      message:
        "Period start must be the 1st of a month: only the company's first fiscal year may start mid-month (BFL 3 kap. 1 and 3 §§)",
    }
  }

  // end must be last day of month
  // new Date(year, 1-indexed-month, 0) gives the last day of that month
  const lastDayOfEndMonth = new Date(endParts.year, endParts.month, 0).getDate()
  if (endParts.day !== lastDayOfEndMonth) {
    return { rule: 'end_not_month_end', message: 'Period end must be the last day of a month' }
  }

  // Max 18 months per BFL 3 kap. No minimum: a first (or re-laid) year may
  // be arbitrarily short, e.g. an autumn-registered AB shortening its first
  // year to end at Dec 31 for an early årsredovisning.
  if (exceedsFiscalYearCap(start, end)) {
    const months = monthsBetween(start, end)
    return {
      rule: 'exceeds_18_months',
      message: `Period duration ${months} months exceeds maximum 18 months (BFL 3 kap.)`,
      months,
    }
  }

  return null
}

/**
 * Validate a fiscal period's duration and date constraints.
 * Returns null if valid, or an error message string if invalid.
 */
export function validatePeriodDuration(start: string, end: string, options?: ValidatePeriodOptions): string | null {
  return checkPeriodDuration(start, end, options)?.message ?? null
}
