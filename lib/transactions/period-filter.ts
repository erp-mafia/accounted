import type { FiscalPeriod } from '@/types'

/** Inclusive ISO date bounds (yyyy-MM-dd) for a period filter. */
export interface PeriodBounds {
  start: string
  end: string
}

export type Quarter = 1 | 2 | 3 | 4

export const QUARTERS: Quarter[] = [1, 2, 3, 4]

type PeriodDates = Pick<FiscalPeriod, 'period_start' | 'period_end'>

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Month arithmetic on ISO date strings. Day-of-month overflow clamps to the
// last day of the target month (2026-01-31 + 1 month = 2026-02-28), matching
// how fiscal quarters are counted from the period start.
function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const total = y * 12 + (m - 1) + months
  const year = Math.floor(total / 12)
  const monthIndex = total - year * 12
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
  return toIso(year, monthIndex + 1, Math.min(d, lastDay))
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * Date bounds for one quarter of a fiscal period. Quarters follow the fiscal
 * year, not the calendar: Q1 starts at period_start, so a brutet rakenskapsar
 * (e.g. July to June) gets Q1 = Jul-Sep. Rules for irregular period lengths:
 * - A quarter whose start falls after period_end does not exist (returns
 *   null); the caller disables that choice.
 * - Q4 always runs to period_end, so an extended first year (up to 18 months)
 *   keeps every transaction reachable through some quarter.
 * - A quarter end never extends past period_end.
 */
export function quarterBounds(period: PeriodDates, quarter: Quarter): PeriodBounds | null {
  const start = addMonths(period.period_start, (quarter - 1) * 3)
  if (start > period.period_end) return null
  if (quarter === 4) return { start, end: period.period_end }
  const end = addDays(addMonths(period.period_start, quarter * 3), -1)
  return { start, end: end > period.period_end ? period.period_end : end }
}

/**
 * Bounds for the active period filter: the whole fiscal period, one of its
 * quarters, or null when no filter is applied (or the quarter does not exist
 * within the period).
 */
export function resolvePeriodBounds(
  period: PeriodDates | null,
  quarter: Quarter | null,
): PeriodBounds | null {
  if (!period) return null
  if (quarter === null) return { start: period.period_start, end: period.period_end }
  return quarterBounds(period, quarter)
}

/** True when an ISO date falls inside the bounds. No bounds = everything. */
export function isWithinBounds(date: string, bounds: PeriodBounds | null): boolean {
  if (!bounds) return true
  return date >= bounds.start && date <= bounds.end
}
