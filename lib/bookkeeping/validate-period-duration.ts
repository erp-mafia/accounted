/**
 * Validates fiscal period duration per BFL 3 kap.
 * Maximum 18 months for any fiscal period (first year may be extended).
 * Normal ongoing periods are 12 months.
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

/**
 * Validate a fiscal period's duration and date constraints.
 * Returns null if valid, or an error message string if invalid.
 */
export function validatePeriodDuration(start: string, end: string, options?: ValidatePeriodOptions): string | null {
  const startParts = parseDateParts(start)
  const endParts = parseDateParts(end)

  // end must be after start (YYYY-MM-DD strings are lexicographically orderable)
  if (end <= start) {
    return 'Period end must be after period start'
  }

  // start must be 1st of month: unless this is the first fiscal period (BFL 3 kap.)
  if (startParts.day !== 1 && !options?.isFirstPeriod) {
    return 'Period start must be the 1st of a month'
  }

  // end must be last day of month
  // new Date(year, 1-indexed-month, 0) gives the last day of that month
  const lastDayOfEndMonth = new Date(endParts.year, endParts.month, 0).getDate()
  if (endParts.day !== lastDayOfEndMonth) {
    return 'Period end must be the last day of a month'
  }

  // Max 18 months per BFL 3 kap.
  const months = monthsBetween(start, end)
  if (months > 18) {
    return `Period duration ${months} months exceeds maximum 18 months (BFL 3 kap.)`
  }

  // First fiscal period must be at least 6 months per BFL 3 kap.
  if (options?.isFirstPeriod && months < 6) {
    return `First fiscal period must be at least 6 months (BFL 3 kap.)`
  }

  return null
}
