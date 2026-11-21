import type { SupabaseClient } from '@supabase/supabase-js'
import { cohortYearFromAccount } from './periodiseringsfond-cohort'
import { roundOre, truncateToWholeKronor } from '@/lib/money'
import type { TrialBalanceRow } from '@/types'
import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from './account-mappings'

/**
 * INK2S 4.6d (SRU 7673): the uppräkning on periodiseringsfonder återförda in
 * a beskattningsår that began after 2020-12-31. A fond set aside while
 * bolagsskatten was higher is taken back to tax at more than its booked
 * amount (övergångsbestämmelser to SFS 2018:1206; Skatteverket,
 * "Periodiseringsfond" for aktiebolag):
 *
 *   avsättning for a beskattningsår that began   återförs med
 *   before 2019-01-01                             106 %
 *   2019-01-01 to 2020-12-31                      104 %
 *   after 2020-12-31                              100 %
 *
 * The booked återföring is already in the result (INK2R 3.21); 4.6d takes
 * only the uppräknade part (Skatteverket's example: 60 000 kr at 104 % gives
 * 2 400 kr on 4.6d). The oldest fond is always the one återförd first, for
 * tax, whichever fond account the återföring was booked on.
 *
 * Fail closed, like the schablonintäkt (./schablonintakt): the amount is 0
 * with a warning that names the base when the rule cannot be settled from
 * the books:
 *
 *   - This beskattningsår began before 2021-01-01 (the uppräkning was then
 *     103 % for the oldest fonder).
 *   - A fond held at the year's start has no avsättningsår in its account
 *     number (211x), so the oldest-first order is unknown.
 *   - The beskattningsår a fond was set aside for cannot be told apart
 *     between two readings that give different rates (see taxYearStartFor).
 *
 * A missing figure the declaration says must be entered by hand is better
 * than a wrong one in a tax return.
 */

/** One fond account, credit-positive: opening at the year's start, closing at its end. */
export interface FondMovement {
  accountNumber: string
  opening: number
  closing: number
}

/** A räkenskapsår of the company, as fiscal_periods holds it. */
export interface TaxYearSpan {
  start: string
  end: string
}

export interface FondUppraekningRow {
  accountNumber: string
  cohortYear: number
  /** First day of the beskattningsår the fond was set aside for. */
  taxYearStart: string
  /** The part of this year's återföring that, oldest first, falls on this fond. */
  reversed: number
  /** 6, 4 or 0. */
  upliftPercent: number
}

export interface PeriodiseringsfondUppraekning {
  /** Whole kronor for 4.6d; 0 when there is none or it was not computed. */
  amount: number
  /** This year's återföring in total, whole kronor. */
  reversed: number
  rows: FondUppraekningRow[]
  /** Swedish, one per reason the amount was left for the user or needs a look. */
  warnings: string[]
}

/** The uppräkning rule as Skatteverket states it applies to återföring in years from here. */
const FIRST_START_OF_CURRENT_RULE = '2021-01-01'

const LEFT_OUT =
  'Räkna ut det uppräknade beloppet och ange det i punkt 4.6d i Skatteverkets e-tjänst: punkt 4.15/4.16 och 1.1/1.2 här är utan det.'

/** The uppräkning in percent for a fond set aside for a beskattningsår that began on `taxYearStart`. */
export function upliftPercentForTaxYearStart(taxYearStart: string): number {
  if (taxYearStart < '2019-01-01') return 6
  if (taxYearStart < FIRST_START_OF_CURRENT_RULE) return 4
  return 0
}

/**
 * The first day of the beskattningsår a fond on a cohort account was set
 * aside for. The product names a fond after the year its räkenskapsår ENDS
 * in (getPeriodiseringsfondCohortAccount is called with the period_end
 * year), so the räkenskapsår in the books that ends in the cohort year is
 * the answer. A fond older than the books has no such year: the company's
 * current layout is assumed (a calendar year starts on 1 January of the
 * cohort year, a brutet år the year before), and the answer is refused when
 * the other reading would give a different rate.
 */
export function taxYearStartFor(
  cohortYear: number,
  fiscalYears: readonly TaxYearSpan[],
  currentStart: string,
): { start: string } | { ambiguous: string[] } {
  const ending = fiscalYears.filter((year) => year.end.slice(0, 4) === String(cohortYear))
  if (ending.length > 0) {
    const starts = [...new Set(ending.map((year) => year.start))].sort()
    const rates = new Set(starts.map(upliftPercentForTaxYearStart))
    return rates.size === 1 ? { start: starts[0] } : { ambiguous: starts }
  }
  const monthDay = currentStart.slice(5)
  const calendarReading = `${cohortYear}-01-01`
  const assumed = monthDay === '01-01' ? calendarReading : `${cohortYear - 1}-${monthDay}`
  if (upliftPercentForTaxYearStart(assumed) !== upliftPercentForTaxYearStart(calendarReading)) {
    return { ambiguous: [...new Set([assumed, calendarReading])].sort() }
  }
  return { start: assumed }
}

const PERIODISERINGSFOND_MAPPING = INK2R_ACCOUNT_MAPPINGS.find((m) => m.sruCode === '7321')

/**
 * The fond accounts INK2R 2.29 reports (BAS 2110-2139) as movements over the
 * year, credit-positive, read from the closed books' trial balance.
 */
export function fondMovementsFromTrialBalance(rows: readonly TrialBalanceRow[]): FondMovement[] {
  if (!PERIODISERINGSFOND_MAPPING) {
    throw new Error('INK2R mapping for 7321 (periodiseringsfonder) is missing')
  }
  return rows
    .filter((row) => isAccountInMapping(row.account_number, PERIODISERINGSFOND_MAPPING))
    .map((row) => ({
      accountNumber: row.account_number,
      opening: (Number(row.opening_credit) || 0) - (Number(row.opening_debit) || 0),
      closing: (Number(row.closing_credit) || 0) - (Number(row.closing_debit) || 0),
    }))
}

/** The company's räkenskapsår as fiscal_periods holds them (taxYearStartFor reads them). */
export async function loadTaxYearSpans(supabase: SupabaseClient, companyId: string): Promise<TaxYearSpan[]> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('company_id', companyId)
  if (error) throw new Error(`Failed to load fiscal periods: ${error.message}`)
  return ((data ?? []) as Array<{ period_start: string; period_end: string }>).map((year) => ({
    start: year.period_start,
    end: year.period_end,
  }))
}

export const NO_UPPRAEKNING: PeriodiseringsfondUppraekning = { amount: 0, reversed: 0, rows: [], warnings: [] }

/** True when a fond held at the year's start fell over the year: there is an återföring to look at. */
export function hasFondReversal(funds: readonly FondMovement[]): boolean {
  return funds.some((fund) => fund.opening >= 0.005 && fund.opening - Math.max(0, fund.closing) >= 0.005)
}

/** Whole kronor, öre dropped; integer öre math so no float product lands under a krona. */
function upliftWholeKronor(rows: readonly FondUppraekningRow[]): number {
  let ore = 0
  for (const row of rows) {
    ore += Math.round(row.reversed * 100) * row.upliftPercent
  }
  return Math.floor(ore / 10_000)
}

export function computePeriodiseringsfondUppraekning(input: {
  funds: readonly FondMovement[]
  periodStart: string
  fiscalYears: readonly TaxYearSpan[]
}): PeriodiseringsfondUppraekning {
  const held = input.funds.filter((fund) => fund.opening >= 0.005)
  // A fond is a credit balance; what fell over the year is what was återförd.
  // A fond set aside this year opens at 0 and adds nothing here.
  const reversedTotal = held.reduce((sum, fund) => sum + Math.max(0, fund.opening - Math.max(0, fund.closing)), 0)
  const reversed = truncateToWholeKronor(reversedTotal)
  if (reversedTotal < 0.005) return { amount: 0, reversed: 0, rows: [], warnings: [] }

  const notComputed = (reason: string): PeriodiseringsfondUppraekning => ({
    amount: 0,
    reversed,
    rows: [],
    warnings: [`Periodiseringsfonder på ${reversed} kr har återförts i år${reason} ${LEFT_OUT}`],
  })

  if (input.periodStart < FIRST_START_OF_CURRENT_RULE) {
    return notComputed('. Uppräkningen räknas inte ut automatiskt för räkenskapsår som börjat före 2021.')
  }

  const undated = held.filter((fund) => cohortYearFromAccount(fund.accountNumber) === null)
  if (undated.length > 0) {
    return notComputed(
      `, och konto ${undated.map((fund) => fund.accountNumber).join(', ')} saknar avsättningsår i kontonumret, så det går inte att avgöra vilken fond som är äldst och återförs först.`,
    )
  }

  const dated: Array<FondMovement & { cohortYear: number; taxYearStart: string }> = []
  for (const fund of held) {
    const cohortYear = cohortYearFromAccount(fund.accountNumber) as number
    const start = taxYearStartFor(cohortYear, input.fiscalYears, input.periodStart)
    if ('ambiguous' in start) {
      return notComputed(
        `, och fonden på konto ${fund.accountNumber} (${cohortYear}) kan vara avsatt för ett beskattningsår som började ${start.ambiguous.join(' eller ')}, vilket ger olika uppräkning.`,
      )
    }
    dated.push({ ...fund, cohortYear, taxYearStart: start.start })
  }

  // Oldest first, for tax, whatever account the booking used.
  dated.sort((a, b) => a.taxYearStart.localeCompare(b.taxYearStart) || a.accountNumber.localeCompare(b.accountNumber))
  let remaining = reversedTotal
  const rows: FondUppraekningRow[] = []
  for (const fund of dated) {
    if (remaining < 0.005) break
    const share = Math.min(remaining, fund.opening)
    remaining -= share
    rows.push({
      accountNumber: fund.accountNumber,
      cohortYear: fund.cohortYear,
      taxYearStart: fund.taxYearStart,
      reversed: roundOre(share),
      upliftPercent: upliftPercentForTaxYearStart(fund.taxYearStart),
    })
  }

  const warnings: string[] = []
  // The books took a younger fond before an older one: the form follows the
  // oldest-first rule, and the fond left in the books is then younger for
  // tax than its account says, which moves its sexårsgräns.
  const bookedOutOfOrder = rows.some((row) => {
    const fund = dated.find((f) => f.accountNumber === row.accountNumber)
    const bookedReversal = fund ? Math.max(0, fund.opening - Math.max(0, fund.closing)) : 0
    return Math.abs(bookedReversal - row.reversed) >= 0.005
  })
  if (bookedOutOfOrder) {
    warnings.push(
      `Återföringen är bokförd på en yngre periodiseringsfond än den äldsta. Skattemässigt återförs alltid den äldsta fonden först, så punkt 4.6d räknas så: ${rows.map((row) => `${row.reversed} kr från fonden ${row.cohortYear}`).join(', ')}. Kontrollera vilka fonder som finns kvar och när de ska återföras.`,
    )
  }

  return { amount: upliftWholeKronor(rows), reversed, rows, warnings }
}
