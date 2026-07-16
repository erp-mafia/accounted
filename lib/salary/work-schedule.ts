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
