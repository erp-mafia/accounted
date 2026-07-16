/**
 * Vacation year (semesterår) boundary helpers.
 *
 * Two bases exist (company_settings.salary_vacation_year_basis):
 *   'calendar'          : sammanfallande intjänande- och semesterår, Jan 1 to
 *                         Dec 31. The small-company norm and our default.
 *   'statutory_apr_mar' : the Semesterlagen 3 § default, Apr 1 to Mar 31.
 */

export type VacationYearBasis = 'calendar' | 'statutory_apr_mar'

/** The vacation-year start date (YYYY-MM-DD) containing `dateIso`. */
export function getVacationYearStart(dateIso: string, basis: VacationYearBasis): string {
  const year = Number(dateIso.slice(0, 4))
  const month = Number(dateIso.slice(5, 7))
  if (basis === 'calendar') {
    return `${year}-01-01`
  }
  // Statutory Apr-Mar: Jan-Mar belongs to the year that started the PREVIOUS
  // April.
  return month >= 4 ? `${year}-04-01` : `${year - 1}-04-01`
}

/** Inclusive start + exclusive end of the vacation year starting at `yearStartIso`. */
export function getVacationYearBounds(yearStartIso: string): { start: string; end: string } {
  const year = Number(yearStartIso.slice(0, 4))
  const month = yearStartIso.slice(5, 7)
  return {
    start: yearStartIso,
    end: `${year + 1}-${month}-01`,
  }
}

/** The vacation year that has ENDED most recently as of `asOfIso`: the one a
 * year-close would target. Returns null while the first-ever year is still
 * running (nothing closable). */
export function getClosableYearStart(asOfIso: string, basis: VacationYearBasis): string {
  const currentStart = getVacationYearStart(asOfIso, basis)
  const year = Number(currentStart.slice(0, 4))
  const month = currentStart.slice(5, 7)
  return `${year - 1}-${month}-01`
}
