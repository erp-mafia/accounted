/**
 * Vacation year (semesterår) boundary helpers.
 *
 * Two bases exist (company_settings.salary_vacation_year_basis):
 *   'calendar'          : sammanfallande intjänande- och semesterår, Jan 1 to
 *                         Dec 31. Our default; it rests on a kollektivavtal
 *                         (vacationYearBasisNeedsAgreement).
 *   'statutory_apr_mar' : the Semesterlagen 3 § default, Apr 1 to Mar 31.
 */
import type { OperationWarning } from '@/lib/operations/types'

export type VacationYearBasis = 'calendar' | 'statutory_apr_mar'

/**
 * Whether a basis needs a kollektivavtal behind it. Semesterlagen 3 § sets
 * the semesterår to 1 April through 31 March, and only a kollektivavtal
 * concluded or approved by a central employee organisation may move it
 * (2 a § andra stycket), so every basis but the statutory one does.
 */
export function vacationYearBasisNeedsAgreement(basis: VacationYearBasis): boolean {
  return basis !== 'statutory_apr_mar'
}

/**
 * What the semesterår row on the salary settings page says about that
 * agreement: nothing for the statutory year, a quiet note for another year
 * already saved, and the note with a confirmation the save waits for while
 * another year is being chosen.
 */
export type VacationBasisAgreementPrompt = 'none' | 'note' | 'confirm'

export function vacationBasisAgreementPrompt(
  saved: VacationYearBasis,
  shown: VacationYearBasis,
): VacationBasisAgreementPrompt {
  if (!vacationYearBasisNeedsAgreement(shown)) return 'none'
  return shown === saved ? 'note' : 'confirm'
}

/**
 * The warning a settings save over the API or MCP carries when it sets a
 * basis that needs a kollektivavtal: those doors have no confirmation to
 * ask, so the answer says it instead.
 */
export function vacationYearAgreementWarnings(requested: VacationYearBasis | undefined): OperationWarning[] {
  if (requested === undefined || !vacationYearBasisNeedsAgreement(requested)) return []
  return [
    {
      code: 'VACATION_YEAR_NEEDS_COLLECTIVE_AGREEMENT',
      message_sv:
        'Ett annat semesterår än 1 april till 31 mars kräver ett kollektivavtal som tillåter det (semesterlagen 2 a §). Utan kollektivavtal gäller semesterlagens semesterår, 1 april till 31 mars (3 §).',
      message_en:
        'A vacation year other than 1 April to 31 March needs a collective agreement that allows it (semesterlagen 2 a §). Without one, the Annual Leave Act\'s vacation year applies: 1 April to 31 March (3 §).',
    },
  ]
}

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

/** The vacation year containing `asOfIso`, as inclusive first and last day
 * (YYYY-MM-DD): the dates a user reads, not the half-open bounds the ledger
 * queries with. */
export function getCurrentVacationYear(
  asOfIso: string,
  basis: VacationYearBasis,
): { start: string; end: string } {
  const { start, end } = getVacationYearBounds(getVacationYearStart(asOfIso, basis))
  // Day 0 of the exclusive end month is the last day of the month before it.
  const lastDay = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 1, 0))
  return { start, end: lastDay.toISOString().slice(0, 10) }
}

/** GET /api/settings/vacation-year-basis: the settings service's verdict. */
export interface VacationBasisChangeAnswer {
  changeable: boolean
  /** The service's refusal code when not changeable. */
  reason: string | null
}

/**
 * How the semesterår control renders: a choice while the settings service
 * accepts a change, otherwise locked with the reason the service gave. It
 * fails closed: an unanswered or failed check never offers the choice.
 */
export type VacationBasisControl =
  | { state: 'checking' }
  | { state: 'choice' }
  | { state: 'locked'; reason: 'open_balances' | 'check_failed' }

export function vacationBasisControl(answer: VacationBasisChangeAnswer | undefined, failed: boolean): VacationBasisControl {
  if (failed) return { state: 'locked', reason: 'check_failed' }
  if (!answer) return { state: 'checking' }
  if (answer.changeable) return { state: 'choice' }
  return {
    state: 'locked',
    reason: answer.reason === 'SETTINGS_VACATION_BASIS_OPEN_BALANCES' ? 'open_balances' : 'check_failed',
  }
}
