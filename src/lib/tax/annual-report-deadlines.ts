/**
 * The two statutory limits after a räkenskapsår ends: the årsstämma (or
 * ordinarie föreningsstämma) within six months (ABL 7 kap. 10 §, EFL 6 kap.
 * 9 §) and the årsredovisning at Bolagsverket within seven months (ÅRL 8 kap.
 * 3 §). A leaf module, so a client component can show the dates; the deadline
 * calendar (deadline-config) generates its rows from the same counts.
 */

export const ANNUAL_MEETING_MONTHS = 6
export const BOLAGSVERKET_FILING_MONTHS = 7

/**
 * The last day of the month `months` after a räkenskapsår that ends in
 * `endMonth` (1-12) of `endYear`. Swedish räkenskapsår end on the last day of
 * a calendar month (BFL 3 kap.), so this is the statutory limit. month0 is
 * 0-11.
 */
export function lastDayMonthsAfterYearEnd(
  endYear: number,
  endMonth: number,
  months: number,
): { year: number; month0: number; day: number } {
  const month0 = (endMonth - 1 + months) % 12
  const year = endYear + Math.floor((endMonth - 1 + months) / 12)
  return { year, month0, day: new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate() }
}

/** The same limit as an ISO date, for a räkenskapsår ending on `periodEnd` (YYYY-MM-DD). */
export function deadlineAfterYearEnd(periodEnd: string, months: number): string {
  const { year, month0, day } = lastDayMonthsAfterYearEnd(
    Number(periodEnd.slice(0, 4)),
    Number(periodEnd.slice(5, 7)),
    months,
  )
  return `${year}-${String(month0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
