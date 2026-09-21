/**
 * Work-schedule divisors (arbetsschema-lite).
 *
 * Converts an employee's weekly schedule into the two divisors the salary
 * engine uses:
 *
 *   hourly divisor : monthly salary -> effective hourly rate
 *   daily divisor  : monthly salary -> daily rate (sick/VAB/parental
 *                    deductions, sammalöneregeln day valuation)
 *
 * BACKWARD-COMPAT CONTRACT (deliberate discontinuity): at the DEFAULT
 * schedule (40h / 5d) these return the legacy constants 173 and 21, not the
 * exact formulas (which give 173.33 and 21.67). Switching the defaults to
 * exact formulas would change every running company's monthly-to-hourly
 * derivation by ~0.2% and every sick/VAB daily deduction by ~3% mid-year
 * with zero schedule change, which is indefensible in a payroll product.
 * Non-default schedules use the exact formula: they have no legacy results
 * to preserve. Migrating the defaults to exact formulas is deferred to a
 * fiscal-year boundary with release notes.
 */

import { roundOre } from '@/lib/money'

/** Legacy CBA convention: 52 weeks x 40 hours / 12 months, truncated. */
export const LEGACY_HOURLY_DIVISOR = 173
/** Legacy convention: 52 weeks x 5 workdays / 12 months, rounded down. */
export const LEGACY_DAILY_DIVISOR = 21

export const DEFAULT_HOURS_PER_WEEK = 40
export const DEFAULT_WORKDAYS_PER_WEEK = 5

/** Monthly-salary -> hourly-rate divisor for a weekly hours schedule. */
export function hourlyDivisor(hoursPerWeek: number | null | undefined): number {
  const hours = hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK
  if (hours === DEFAULT_HOURS_PER_WEEK) return LEGACY_HOURLY_DIVISOR
  return roundOre((hours * 52) / 12)
}

/** Monthly-salary -> daily-rate divisor for a weekly workdays schedule. */
export function dailyDivisor(workdaysPerWeek: number | null | undefined): number {
  const days = workdaysPerWeek ?? DEFAULT_WORKDAYS_PER_WEEK
  if (days === DEFAULT_WORKDAYS_PER_WEEK) return LEGACY_DAILY_DIVISOR
  return roundOre((days * 52) / 12)
}

/**
 * Scheduled hours on one working day: hours_per_week / workdays_per_week,
 * each falling back to its default (40 / 5) when missing or not positive.
 *
 * This is THE length of "a day" for per-day registrations. The engine weights
 * an absence row by `hours / scheduledHoursPerDay` (capped at one day, see
 * deriveAbsenceLineItems) and the calendar dialogs default to it, from this
 * one function, so "one day" in the dialog is one day in the calculation.
 * hours_per_week already reflects the employment degree.
 */
export function scheduledHoursPerDay(
  hoursPerWeek: number | null | undefined,
  workdaysPerWeek: number | null | undefined,
): number {
  const hours = Number(hoursPerWeek) > 0 ? Number(hoursPerWeek) : DEFAULT_HOURS_PER_WEEK
  const days = Number(workdaysPerWeek) > 0 ? Number(workdaysPerWeek) : DEFAULT_WORKDAYS_PER_WEEK
  return hours / days
}

/** Upper bound of salary_absence_days.hours / salary_worked_days.hours. */
const MAX_HOURS_PER_DATE = 24

/**
 * Default for an "hours per day" input: one scheduled day in the two decimals
 * the hours columns store (NUMERIC(5,2)).
 *
 * Rounded UP on purpose, and not money: 40 h over 3 days is 13.333 h, and a
 * stored 13.33 would weigh 0.99975 of a day in the engine (a few öre short of
 * a full day's deduction), while 13.34 is capped to exactly one day. The
 * epsilon keeps float noise (7.6 * 100 = 760.0000000000001) from ceiling a
 * clean value up a step.
 */
export function defaultDayHours(
  hoursPerWeek: number | null | undefined,
  workdaysPerWeek: number | null | undefined,
): number {
  const perDay = scheduledHoursPerDay(hoursPerWeek, workdaysPerWeek)
  return Math.min(MAX_HOURS_PER_DATE, Math.ceil(perDay * 100 - 1e-6) / 100)
}
