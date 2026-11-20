/**
 * Months of a budget year, as 'YYYY-MM' strings. String math on the ISO
 * parts: no Date object, no time zone edge.
 *
 * A budget month is a whole calendar month. A räkenskapsår that starts mid
 * month (a first year from the registration day) owns its start month in
 * full, which is what the database checks too (enforce_budget_line_month).
 */

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

export function isBudgetMonth(value: string): boolean {
  return MONTH_RE.test(value)
}

/** '2026-03-15' -> '2026-03'. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7)
}

/** '2026-03' -> '2026-03-01', the form budget_lines.month stores. */
export function firstDayOf(month: string): string {
  return `${month}-01`
}

/** '2026-02' -> '2026-02-28'. */
export function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
  return `${month}-${String(days).padStart(2, '0')}`
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

/** Every month from `from` through `to`, both included ('YYYY-MM'). */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let month = from; month <= to; month = nextMonth(month)) out.push(month)
  return out
}

/** The months a räkenskapsår holds, its start month in full. */
export function fiscalYearMonths(periodStart: string, periodEnd: string): string[] {
  return monthsBetween(monthOf(periodStart), monthOf(periodEnd))
}

/** '2026-03' -> '03', the calendar month two years share. */
export function calendarMonthOf(month: string): string {
  return month.slice(5, 7)
}
