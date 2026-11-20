/**
 * Days off for staff who work fewer than five days a week.
 *
 * Semesterlagen (1977:480) gives every employee 25 paid semesterdagar (4 §)
 * and requires that someone with a lower sysselsättningsgrad or irregular
 * hours gets leave as long as a full-timer's (12 a §, which no agreement may
 * set aside: 2 a § does not list it). Leave is taken in whole days (3 a §).
 * So a 4-day week keeps its 25 paid days and takes them as 20 days off:
 * 25 x 4 / 5, rounded up when the schedule does not divide evenly (3.5 days
 * a week: 17.5, so 18 days off).
 *
 * Pay, saving (18 §: more than 20 paid days) and the year-end payout (26 a §)
 * all count paid days, so the vacation ledger stays in paid days and only the
 * days on a vacation line are converted: each day off uses
 * `paidDaysPerDayOff` paid days, frozen on the payslip that booked it
 * (salary_run_employees.vacation_paid_days_per_day_off). A schedule of five
 * days or more converts one for one: a weekend worker's extra leave is the
 * weekend around the holiday (9 §), not more semesterdagar.
 */

import { roundOre } from '@/lib/money'
import { DEFAULT_WORKDAYS_PER_WEEK } from './work-schedule'

const PAID_DAYS_SCALE = 10_000

/**
 * Paid days carry four decimals. A day off at 3.5 days a week is 25/18 paid
 * days: two decimals (1.39) would leave 18 such days 0.02 over the 25, while
 * four keep a year of payslips within a thousandth of the exact sum, which
 * every reader's two-decimal rounding removes.
 */
export function roundPaidDays(n: number): number {
  if (n === 0 || !Number.isFinite(n)) return n
  return Math.round(n * PAID_DAYS_SCALE) / PAID_DAYS_SCALE
}

function shortWeek(workdaysPerWeek: number | null | undefined): number | null {
  const days = Number(workdaysPerWeek)
  return days > 0 && days < DEFAULT_WORKDAYS_PER_WEEK ? days : null
}

/** The days off a year's paid days give at this schedule (Semesterlagen 12 a §). */
export function daysOffPerYear(paidDays: number, workdaysPerWeek: number | null | undefined): number {
  const days = shortWeek(workdaysPerWeek)
  if (days === null || !(paidDays > 0)) return paidDays
  // The epsilon keeps float noise (25 x 4.2 / 5 = 21.000000000000004) from
  // rounding a whole day up to the next.
  return Math.ceil((paidDays * days) / DEFAULT_WORKDAYS_PER_WEEK - 1e-9)
}

/** Paid days one day off uses: 25 / 20 = 1.25 at four days a week, else 1. */
export function paidDaysPerDayOff(paidDays: number, workdaysPerWeek: number | null | undefined): number {
  const daysOff = daysOffPerYear(paidDays, workdaysPerWeek)
  if (!(daysOff > 0) || daysOff === paidDays) return 1
  return paidDays / daysOff
}

/**
 * The factor a stored payslip row carries, read defensively: NULL (rows
 * calculated before the column existed) and anything not positive count one
 * for one, which is what those rows were booked with.
 */
export function storedPaidDaysPerDayOff(factor: number | null | undefined): number {
  const n = Number(factor)
  return n > 0 ? n : 1
}

/** Days off a number of paid days comes to, for display next to the paid figure. */
export function paidDaysAsDaysOff(paidDays: number, factor: number): number {
  return roundOre(paidDays / storedPaidDaysPerDayOff(factor))
}
