/**
 * Which vacation days the semesterlöneskuld covers on a date, and at which
 * avgifter rate. Pure: the semesterårsavslut (semesterberedning.ts), the
 * Semesterskuld report and the remeasurement (vacation-liability-valuation.ts)
 * all value the same days, so a remeasured company's year close finds next
 * to nothing to adjust.
 *
 * The liability is the semesterlön still owed for days earned and not taken
 * (K2 punkt 17.10, per employee). Semesterlagen (1977:480), checked against
 * the text in the research folder of this change:
 *
 *   - 3 §: the intjänandeår is the twelve months before the semesterår; by
 *     law April to March, by agreement often the calendar year, then usually
 *     sammanfallande (earned and taken in the same year).
 *   - 7 §: the paid days of a semesterår are earned in proportion to the
 *     days employed in the intjänandeår, rounded up to whole days.
 *   - 18 §: sparade dagar stay owed until taken.
 *
 * Statutory basis (April to March): on a date inside semesterår Y the
 * employee holds the paid days of Y not yet taken (earned during the year
 * before), the sparade dagar, and the days being earned in the running
 * intjänandeår (also Y), which are paid during the next semesterår. Those
 * accrue in proportion to the days employed so far (7 §), and on the year's
 * last day they are the next year's entitlement, rounded up like 7 § rounds.
 *
 * Calendar basis (sammanfallande semesterår): the year's paid days are
 * earned through that same year. On a date the employee has earned the
 * share of the year's entitlement that their employed days so far bear to
 * their employed days in the year; days taken beyond that are förskott. The
 * owed days are earned minus taken, never below zero per employee: a
 * förskott is reclaimable only in the cases Semesterlagen 29 a § lists, so it
 * is not recognised as an asset against the other employees' liability. On
 * the year's last day earned is the whole entitlement, which is the figure
 * the semesterårsavslut has always valued.
 *
 * Paid days of an earlier vacation year that was not closed yet still count:
 * only the close turns them into sparade dagar or lets them lapse. Days the
 * close moved to forced payout (saved days past five years) are not counted,
 * the same as the close always did: they are settled through a salary run.
 */

import { roundPaidDays } from './vacation-net-days'
import { computeEntitledDays } from './vacation-ledger'
import { getVacationYearBounds, type VacationYearBasis } from './vacation-year'
import { decryptPersonnummer } from './personnummer'
import { avgiftAgeTier } from './avgift-tier'

const STANDARD_AVGIFTER_RATE = 0.3142
/** Ålderspensionsavgift only, for the reduced age tier (SAL 2 kap). */
const REDUCED_AVGIFTER_RATE = 0.1021

export interface VacationLiabilityDaysInput {
  basis: VacationYearBasis
  /** First day of the vacation year containing `asOfDate`. */
  yearStart: string
  asOfDate: string
  /** That year's ledger figures, in paid days (deriveVacationLedgerRow). */
  entitledDays: number
  takenDays: number
  /** Sparade dagar still held, summed over origin years. */
  savedDays: number
  vacationDaysPerYear: number
  employmentStart: string
  employmentEnd: string | null
  /** Paid days left of earlier vacation years that are not closed yet. */
  unclosedYearDays?: number
}

export interface VacationLiabilityDays {
  /** Owed days of the vacation year containing the date (see the header). */
  current_year_days: number
  /**
   * That year's paid days earned by the date, before the days taken
   * (current_year_days is this less the days taken, never below 0): the whole
   * entitlement on the statutory basis, the earned share under the calendar
   * basis. Absent on rows frozen before it was recorded.
   */
  current_year_earned_days?: number
  saved_days: number
  /** Statutory basis only: days earned so far toward the next semesterår. */
  earning_days: number
  unclosed_year_days: number
  total_days: number
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * Employed days of [start, endExclusive) that have passed by `asOfDate`, and
 * the employed days of the whole span. Day counts, half-open like the ledger.
 */
function employedDays(
  start: string,
  endExclusive: string,
  employmentStart: string,
  employmentEnd: string | null,
  asOfDate: string,
): { elapsed: number; total: number } {
  const from = employmentStart > start ? employmentStart : start
  const employedEnd = employmentEnd ? addDays(employmentEnd, 1) : endExclusive
  const until = employedEnd < endExclusive ? employedEnd : endExclusive
  const total = Math.max(0, daysBetween(from, until))
  const asOfEnd = addDays(asOfDate, 1)
  const elapsedEnd = asOfEnd < until ? asOfEnd : until
  return { elapsed: Math.max(0, daysBetween(from, elapsedEnd)), total }
}

export function vacationLiabilityDays(input: VacationLiabilityDaysInput): VacationLiabilityDays {
  const bounds = getVacationYearBounds(input.yearStart)
  const lastDay = addDays(bounds.end, -1)
  let currentYearEarned: number
  let earningDays = 0

  if (input.basis === 'statutory_apr_mar') {
    currentYearEarned = input.entitledDays
    if (input.asOfDate >= lastDay) {
      // The intjänandeår is over: next year's entitlement, rounded up (7 §).
      earningDays = computeEntitledDays('statutory_apr_mar', bounds.end, input.vacationDaysPerYear, input.employmentStart)
    } else {
      const yearDays = daysBetween(bounds.start, bounds.end)
      const { elapsed } = employedDays(bounds.start, bounds.end, input.employmentStart, input.employmentEnd, input.asOfDate)
      earningDays = yearDays > 0 ? Math.min(input.vacationDaysPerYear, (elapsed / yearDays) * input.vacationDaysPerYear) : 0
    }
  } else {
    const { elapsed, total } = employedDays(bounds.start, bounds.end, input.employmentStart, input.employmentEnd, input.asOfDate)
    const share = input.asOfDate >= lastDay ? 1 : total > 0 ? Math.min(1, elapsed / total) : 0
    currentYearEarned = input.entitledDays * share
  }

  const current = roundPaidDays(Math.max(0, currentYearEarned - input.takenDays))
  const earning = roundPaidDays(earningDays)
  const saved = roundPaidDays(Math.max(0, input.savedDays))
  const unclosed = roundPaidDays(Math.max(0, input.unclosedYearDays ?? 0))
  return {
    current_year_days: current,
    current_year_earned_days: roundPaidDays(Math.max(0, currentYearEarned)),
    saved_days: saved,
    earning_days: earning,
    unclosed_year_days: unclosed,
    total_days: roundPaidDays(current + saved + earning + unclosed),
  }
}

/**
 * The year whose avgifter rates the liability on `asOfDate` is provisioned
 * at: the calendar year of the day after. The liability is paid out from the
 * next day on, and K2 punkt 17.10 (BFNAR 2025:2) asks for the payout year's
 * rates when known, else the balance-sheet date's. At a vacation year's end
 * this is the year the closing balance settles in, the year the
 * semesterårsavslut has always used.
 */
export function liabilitySettlementYear(asOfDate: string): number {
  return Number(addDays(asOfDate, 1).slice(0, 4))
}

/**
 * Age-tier avgifter rate for one employee's semesterlöneskuld: born 1937 or
 * earlier none, fyllt 67 vid årets ingång (66 before payment year 2026) the
 * ålderspensionsavgift only, otherwise the full rate. The per-run accruals
 * credit 2940 at the same tiers (calculation-engine.ts step 10), so a flat
 * 31,42 % target would "correct" a right balance for 67+ staff. The
 * temporary youth discount is not provisioned: it depends on the payment
 * month and a cap and ends September 2027, so the full rate is the prudent
 * target (ÅRL försiktighetsprincipen). An absent or undecryptable
 * personnummer reads the full rate, as the run engine does.
 */
export function liabilityAvgifterRate(encryptedPersonnummer: string | null | undefined, settlementYear: number): number {
  if (!encryptedPersonnummer) return STANDARD_AVGIFTER_RATE
  let pnr: string
  try {
    pnr = decryptPersonnummer(encryptedPersonnummer)
  } catch {
    // Safe to ignore: an undecryptable personnummer reads the full rate, the
    // run engine's own fallback, so the provision never comes out low.
    return STANDARD_AVGIFTER_RATE
  }
  const tier = avgiftAgeTier(pnr, settlementYear, settlementYear >= 2026 ? 67 : 66)
  if (tier === 'exempt') return 0
  if (tier === 'reduced') return REDUCED_AVGIFTER_RATE
  return STANDARD_AVGIFTER_RATE
}
