/**
 * The first räkenskapsår of a newly registered aktiebolag: it starts the
 * day Bolagsverket registers the company and ends at the first year-end
 * the bolagsordning gives, or, when the founders chose to, at the one after
 * it while the year stays within the 18-month cap (exceedsFiscalYearCap,
 * the one definition of that cap).
 */

import { exceedsFiscalYearCap } from '@/lib/bookkeeping/validate-period-duration'

function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** The month a fiscal year starting in `startMonth` ends in. */
export function yearEndMonth(startMonth: number): number {
  return startMonth === 1 ? 12 : startMonth - 1
}

export function firstFiscalYear(
  registrationDate: string,
  startMonth: number,
  extend: boolean,
): { start: string; end: string; extended: boolean } {
  const [year, month] = registrationDate.split('-').map(Number)
  const endMonth = yearEndMonth(startMonth)
  const endYear = month <= endMonth ? year : year + 1
  const nominal = lastDayOfMonth(endYear, endMonth)
  if (extend) {
    const longer = lastDayOfMonth(endYear + 1, endMonth)
    if (!exceedsFiscalYearCap(registrationDate, longer)) return { start: registrationDate, end: longer, extended: true }
  }
  return { start: registrationDate, end: nominal, extended: false }
}
