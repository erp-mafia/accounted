import { checkPeriodDuration, monthsBetween } from '@/lib/bookkeeping/validate-period-duration'

/**
 * First-fiscal-year end-date options: the month-ends in the chosen end month
 * that the one räkenskapsår rule accepts (checkPeriodDuration, BFL 3 kap.).
 * - A form bound to the calendar year (enskild firma) always ends 31
 *   December; the first year may run up to 18 months (a start after 30 June
 *   may roll into next year's December).
 * - Other forms may end any month, up to 18 months from the start.
 *
 * The rule itself lives in validate-period-duration, which every other door
 * reads: the 18 months and "the end lies after the start" are asked there,
 * not counted again here. It sets NO minimum length for a first
 * räkenskapsår (Bolagsverket: "hur kort som helst"); see DECISIONS.md
 * archive 2026-07-25 / PR #1165, which removed an invented 6-month floor.
 */

export interface FirstYearEndOption {
  /** ISO date, last day of the month. */
  date: string
  months: number
  year: number
  month: number
  day: number
}

function lastDayOf(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** The December options: the only end month a calendar-year form has. */
export function efFirstYearEndOptions(startYear: number, startMonth: number): FirstYearEndOption[] {
  return abFirstYearEndOptions(startYear, startMonth, 12)
}

export function abFirstYearEndOptions(
  startYear: number,
  startMonth: number,
  endMonth: number,
): FirstYearEndOption[] {
  // The start counts from its month: the rule takes a mid-month start's
  // month in full, so the day does not change which ends are allowed.
  const start = iso(startYear, startMonth, 1)
  const out: FirstYearEndOption[] = []
  for (const endYear of [startYear, startYear + 1, startYear + 2]) {
    const day = lastDayOf(endYear, endMonth)
    const date = iso(endYear, endMonth, day)
    if (checkPeriodDuration(start, date, { isFirstPeriod: true }) === null) {
      out.push({ date, months: monthsBetween(start, date), year: endYear, month: endMonth, day })
    }
  }
  return out
}
