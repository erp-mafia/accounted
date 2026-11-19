import {
  getSchablonintaktRate,
  SchablonintaktRateNotConfiguredError,
} from '@/lib/bokslut/reserves/periodiseringsfond-service'
import { sumOre, truncateToWholeKronor } from '@/lib/money'
import type { TrialBalanceRow } from '@/types'
import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from './account-mappings'

/**
 * INK2S 4.6a (SRU 7654): schablonintäkt on the periodiseringsfonder the
 * company held at beskattningsårets ingång (IL 30 kap. 6 a §). A tax-only
 * item: nothing is booked, so it can only come from the opening balances.
 *
 * Base: the opening balance of the accounts INK2R 2.29 reports (7321, BAS
 * 2110-2139), read from the same trial balance as the rest of the form. A
 * fond avsatt in this year's bokslut has no opening balance and yields
 * nothing; a fond återförd during the year still yields it in full.
 *
 * The rule (IL 30 kap. 6 a §, Skatteverket SKV 294 punkt 4.6 a):
 *
 *   - Rate: statslåneräntan at the end of November of the year before the
 *     calendar year in which the beskattningsår ENDS, at least 0,5 %. Only
 *     the end date picks the rate, so a brutet räkenskapsår uses the same
 *     rate as every other year closing in that calendar year.
 *   - A beskattningsår longer or shorter than twelve months is adjusted "i
 *     motsvarande mån". Neither the law nor Skatteverket says how to count;
 *     whole calendar months over twelve is our inference.
 *   - Whole kronor with the öre dropped. No source decides truncation over
 *     rounding for this row; dropping öre is what the rest of the form does.
 *
 * Fail closed. The amount is left at 0 with a warning naming the base when:
 *
 *   - The year does not start on the first day of a month and end on the
 *     last day of one (no source says how a part month counts), or is not 1
 *     to 18 whole months.
 *   - The year started before 2019, when the rule still was 72 % of another
 *     year's rate.
 *   - The rate for the closing year is not in the table yet.
 *   - A fond account opens with a debit balance (a fond is a credit balance;
 *     a debit one is a booking error the form must not net away).
 *
 * A missing figure the declaration says must be entered by hand is better
 * than a wrong one in a tax return.
 */

export interface PeriodiseringsfondSchablonintakt {
  /** Whole kronor for 4.6a; 0 when there is nothing to declare or it was not computed. */
  amount: number
  /** Sum of the fonder at beskattningsårets ingång, whole kronor. */
  openingFonder: number
  /** Swedish, one per reason the amount was left for the user. */
  warnings: string[]
}

const PERIODISERINGSFOND_MAPPING = INK2R_ACCOUNT_MAPPINGS.find((m) => m.sruCode === '7321')

const LEFT_OUT =
  'Räkna ut schablonintäkten och ange den i punkt 4.6a i Skatteverkets e-tjänst: punkt 4.15/4.16 och 1.1/1.2 här är utan den.'

/** The current wording of IL 30 kap. 6 a § applies to years starting from here (SFS 2018:1206). */
const FIRST_START_OF_CURRENT_RULE = '2019-01-01'

/** BFL 3 kap. 3 §: a räkenskapsår is at most eighteen months. */
const MAX_MONTHS = 18

/**
 * Whole calendar months in a beskattningsår that starts on the first day of a
 * month and ends on the last day of one; null for any other year, where the
 * proportional adjustment is not settled.
 */
export function wholeMonthsInTaxYear(periodStart: string, periodEnd: string): number | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/
  const start = iso.exec(periodStart)
  const end = iso.exec(periodEnd)
  if (!start || !end) return null
  const [startYear, startMonth, startDay] = [Number(start[1]), Number(start[2]), Number(start[3])]
  const [endYear, endMonth, endDay] = [Number(end[1]), Number(end[2]), Number(end[3])]
  if (startMonth < 1 || startMonth > 12 || endMonth < 1 || endMonth > 12) return null
  // Day 0 of the next month is the last day of this one.
  const lastDayOfEndMonth = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate()
  if (startDay !== 1 || endDay !== lastDayOfEndMonth) return null
  const months = (endYear - startYear) * 12 + (endMonth - startMonth) + 1
  return months >= 1 && months <= MAX_MONTHS ? months : null
}

/**
 * base x rate x months / 12 in whole kronor, öre dropped. Integer math in öre
 * and basis points, so no float product can land just under a whole krona.
 */
function schablonintaktWholeKronor(base: number, rate: number, months: number): number {
  const baseOre = Math.round(base * 100)
  const rateBasisPoints = Math.round(rate * 10_000)
  // öre x (basis points / 10 000) x (months / 12) / 100 öre per krona.
  return Math.floor((baseOre * rateBasisPoints * months) / 12_000_000)
}

export function computePeriodiseringsfondSchablonintakt(
  rows: readonly TrialBalanceRow[],
  periodStart: string,
  periodEnd: string,
): PeriodiseringsfondSchablonintakt {
  if (!PERIODISERINGSFOND_MAPPING) {
    throw new Error('INK2R mapping for 7321 (periodiseringsfonder) is missing')
  }

  // Credit-positive opening balance per fond account.
  const openings = rows
    .filter((row) => isAccountInMapping(row.account_number, PERIODISERINGSFOND_MAPPING))
    .map((row) => ({
      accountNumber: row.account_number,
      opening: (Number(row.opening_credit) || 0) - (Number(row.opening_debit) || 0),
    }))
    .filter((fond) => Math.abs(fond.opening) >= 0.005)

  if (openings.length === 0) return { amount: 0, openingFonder: 0, warnings: [] }

  const debitOpened = openings.filter((fond) => fond.opening < 0)
  if (debitOpened.length > 0) {
    return {
      amount: 0,
      openingFonder: 0,
      warnings: [
        `Konto ${debitOpened.map((f) => f.accountNumber).join(', ')} (periodiseringsfond) har ett ingående debetsaldo, så schablonintäkten på periodiseringsfonder kan inte räknas ut automatiskt. Kontrollera bokföringen på kontot. ${LEFT_OUT}`,
      ],
    }
  }

  const base = sumOre(openings.map((fond) => fond.opening))
  const openingFonder = truncateToWholeKronor(base)

  const notComputed = (reason: string): PeriodiseringsfondSchablonintakt => ({
    amount: 0,
    openingFonder,
    warnings: [`Periodiseringsfonderna var ${openingFonder} kr vid beskattningsårets ingång${reason} ${LEFT_OUT}`],
  })

  const months = wholeMonthsInTaxYear(periodStart, periodEnd)
  if (months === null) {
    return notComputed(
      '. Schablonintäkten räknas bara ut automatiskt när räkenskapsåret börjar den första dagen i en månad, slutar den sista dagen i en månad och är högst 18 månader.',
    )
  }
  if (periodStart < FIRST_START_OF_CURRENT_RULE) {
    return notComputed('. Schablonintäkten räknas inte ut automatiskt för räkenskapsår som börjat före 2019.')
  }

  // The rate table is keyed by the calendar year the beskattningsår ends in
  // and holds statslåneräntan of 30 November the year before, already floored.
  const closingYear = parseInt(periodEnd.slice(0, 4), 10)
  let rate: number
  try {
    rate = getSchablonintaktRate(closingYear)
  } catch (err) {
    if (!(err instanceof SchablonintaktRateNotConfiguredError)) throw err
    return notComputed(
      `, men statslåneräntan den 30 november ${closingYear - 1}, som styr schablonintäkten för räkenskapsår som slutar ${closingYear}, är inte inlagd.`,
    )
  }

  return {
    amount: schablonintaktWholeKronor(base, rate, months),
    openingFonder,
    // The months/12 adjustment is an inference, so a year it touched says so.
    warnings: months === 12
      ? []
      : [`Schablonintäkten i punkt 4.6a är justerad för ett räkenskapsår på ${months} månader (${months}/12 av helårsbeloppet). Kontrollera beloppet.`],
  }
}
