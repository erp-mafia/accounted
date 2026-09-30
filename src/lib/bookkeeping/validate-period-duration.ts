/**
 * Validates fiscal period duration per BFL 3 kap.
 * Maximum 18 months for any fiscal period (first year may be extended).
 * Normal ongoing periods are 12 months. There is NO minimum length: BFL
 * 3 kap 3 § expressly allows a räkenskapsår shorter than 12 months when
 * bokföringsskyldigheten begins or the year is re-laid, with no floor
 * (Bolagsverket: the first year may be "hur kort som helst").
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

export interface ValidatePeriodOptions {
  /** Allow any start day (not just 1st of month) for the first fiscal period per BFL 3 kap. */
  isFirstPeriod?: boolean
}

/** Which BFL 3 kap. shape rule a period's dates break. */
export type PeriodDurationRule =
  | 'end_not_after_start'
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
  const months = monthsBetween(start, end)
  if (months > 18) {
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
