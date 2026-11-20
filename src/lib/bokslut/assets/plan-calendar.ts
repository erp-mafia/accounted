/**
 * Calendar arithmetic for depreciation plans, on ISO dates (yyyy-MM-dd) as
 * whole UTC day numbers, so no local-time or DST shift can move a day. Pure.
 *
 * Month steps clamp to the last day of the target month (31 Jan + 1 month is
 * 28 or 29 Feb), the convention the asset engine has always used.
 */

const MS_PER_DAY = 86_400_000

/** Days since 1970-01-01 for an ISO date. */
export function dayNumber(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY)
}

/** The ISO date of a day number. */
export function isoOfDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

export function addDaysIso(iso: string, days: number): string {
  return isoOfDay(dayNumber(iso) + days)
}

/** `months` calendar months after `iso`, the day clamped to the month's end. */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  const target = m - 1 + months
  const daysInTarget = new Date(Date.UTC(y, target + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, target, Math.min(d, daysInTarget))).toISOString().slice(0, 10)
}

/** Inclusive day count of [from, to]; 0 when `to` is before `from`. */
export function daysInclusive(fromIso: string, toIso: string): number {
  return Math.max(0, dayNumber(toIso) - dayNumber(fromIso) + 1)
}

/**
 * Months from `startIso` (inclusive) to `endExclusiveIso`, fractional: whole
 * clamped calendar months, then the remaining days as a share of the month
 * that follows. 0 when the end is not after the start.
 */
export function monthsBetween(startIso: string, endExclusiveIso: string): number {
  const end = dayNumber(endExclusiveIso)
  if (end <= dayNumber(startIso)) return 0
  let whole = 0
  while (dayNumber(addMonthsIso(startIso, whole + 1)) <= end) whole += 1
  const stepFrom = dayNumber(addMonthsIso(startIso, whole))
  const stepTo = dayNumber(addMonthsIso(startIso, whole + 1))
  return whole + (stepTo > stepFrom ? (end - stepFrom) / (stepTo - stepFrom) : 0)
}

export function laterIso(a: string, b: string): string {
  return a > b ? a : b
}

export function earlierIso(a: string, b: string): string {
  return a < b ? a : b
}
