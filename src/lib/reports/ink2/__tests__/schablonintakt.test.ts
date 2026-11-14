import { describe, expect, it } from 'vitest'
import { computePeriodiseringsfondSchablonintakt, wholeMonthsInTaxYear } from '../schablonintakt'
import type { TrialBalanceRow } from '@/types'

/** A trial balance row from credit-positive opening and closing balances. */
function fond(accountNumber: string, opening: number, closing = opening): TrialBalanceRow {
  const side = (n: number) => ({ debit: n < 0 ? -n : 0, credit: n > 0 ? n : 0 })
  const change = closing - opening
  return {
    account_number: accountNumber,
    account_name: `Konto ${accountNumber}`,
    account_class: Number(accountNumber[0]),
    opening_debit: side(opening).debit,
    opening_credit: side(opening).credit,
    period_debit: side(change).debit,
    period_credit: side(change).credit,
    closing_debit: side(closing).debit,
    closing_credit: side(closing).credit,
  }
}

const calendar = (year: number) => [`${year}-01-01`, `${year}-12-31`] as const

describe('computePeriodiseringsfondSchablonintakt (INK2S 4.6a)', () => {
  it('is statslåneräntan 30 November the year before, on the fonder at the start of the year', () => {
    for (const [year, expected] of [[2024, 2_620], [2025, 1_960], [2026, 2_550]] as const) {
      const result = computePeriodiseringsfondSchablonintakt([fond('2120', 100_000)], ...calendar(year))
      expect(result).toEqual({ amount: expected, openingFonder: 100_000, warnings: [] })
    }
  })

  // The six check values of the rule: 400 000 kr of fonder at the start of the
  // year (IL 30 kap. 6 a §; the first is Skatteverket's own example).
  it.each([
    ['a calendar year closing 2025: 1,96 %', '2025-01-01', '2025-12-31', 7_840],
    ['a brutet year closing 2025: the same 1,96 %', '2024-07-01', '2025-06-30', 7_840],
    ['a brutet year closing 2026: 2,55 %, whatever year it started in', '2025-03-01', '2026-02-28', 10_200],
    ['an 18-month year closing 2026: 2,55 % x 18/12', '2025-07-01', '2026-12-31', 15_300],
    ['a 6-month year closing 2026: 2,55 % x 6/12', '2026-01-01', '2026-06-30', 5_100],
    ['a calendar year closing 2022: the 0,50 % floor', '2022-01-01', '2022-12-31', 2_000],
  ])('400 000 kr of fonder over %s', (_name, start, end, expected) => {
    const result = computePeriodiseringsfondSchablonintakt([fond('2120', 400_000)], start, end)
    expect(result.amount).toBe(expected)
    expect(result.openingFonder).toBe(400_000)
  })

  it('says so when the amount was adjusted for a year that is not twelve months, and only then', () => {
    const fonder = [fond('2120', 400_000)]
    expect(computePeriodiseringsfondSchablonintakt(fonder, '2025-03-01', '2026-02-28').warnings).toEqual([])
    const long = computePeriodiseringsfondSchablonintakt(fonder, '2025-07-01', '2026-12-31')
    expect(long.warnings).toHaveLength(1)
    expect(long.warnings[0]).toMatch(/punkt 4\.6a är justerad för ett räkenskapsår på 18 månader \(18\/12/)
    const short = computePeriodiseringsfondSchablonintakt(fonder, '2026-01-01', '2026-06-30')
    expect(short.warnings[0]).toMatch(/6 månader \(6\/12/)
  })

  it('floors the rate at 0.5 %', () => {
    const result = computePeriodiseringsfondSchablonintakt([fond('2120', 100_000)], ...calendar(2021))
    expect(result.amount).toBe(500)
  })

  it('drops the öre instead of rounding', () => {
    // 17 399 x 2,55 % = 443,67
    expect(computePeriodiseringsfondSchablonintakt([fond('2126', 17_399)], ...calendar(2026)).amount).toBe(443)
    // Half a year of it: 221,83
    expect(computePeriodiseringsfondSchablonintakt([fond('2126', 17_399)], '2026-01-01', '2026-06-30').amount).toBe(221)
    // An exact result stays exact: 2 000 x 0,5 % x 6/12 = 5, never 4.
    expect(computePeriodiseringsfondSchablonintakt([fond('2126', 2_000)], '2022-01-01', '2022-06-30').amount).toBe(5)
  })

  it('sums every fond account INK2R 2.29 reports (2110-2139) and nothing else', () => {
    const result = computePeriodiseringsfondSchablonintakt(
      [
        fond('2110', 10_000),
        fond('2123', 40_000),
        fond('2135', 50_000),
        fond('2150', 300_000), // ackumulerade överavskrivningar: not a fond
        fond('2099', 900_000),
      ],
      ...calendar(2025),
    )
    expect(result.openingFonder).toBe(100_000)
    expect(result.amount).toBe(1_960)
  })

  it('uses the opening balance: a fond återförd during the year counts in full, one avsatt this year not at all', () => {
    const result = computePeriodiseringsfondSchablonintakt(
      [fond('2120', 100_000, 0), fond('2125', 0, 250_000)],
      ...calendar(2025),
    )
    expect(result.openingFonder).toBe(100_000)
    expect(result.amount).toBe(1_960)
  })

  it('is silent when no fond was open at the start of the year, whatever the year looks like', () => {
    const none = { amount: 0, openingFonder: 0, warnings: [] }
    expect(computePeriodiseringsfondSchablonintakt([fond('2125', 0, 250_000)], ...calendar(2025))).toEqual(none)
    expect(computePeriodiseringsfondSchablonintakt([], '2025-03-01', '2026-02-28')).toEqual(none)
    // A year with no rate in the table must not warn a company without fonder.
    expect(computePeriodiseringsfondSchablonintakt([], ...calendar(2019))).toEqual(none)
  })

  it.each([
    ['a year that starts mid-month', '2025-03-15', '2026-03-14'],
    ['a year that ends mid-month', '2025-01-01', '2025-12-15'],
    ['a year that ends the day before a leap day', '2023-03-01', '2024-02-28'],
    ['a year longer than 18 months', '2024-06-01', '2025-12-31'],
  ])('computes nothing for %s and names the base', (_name, start, end) => {
    const result = computePeriodiseringsfondSchablonintakt([fond('2126', 17_000)], start, end)
    expect(result.amount).toBe(0)
    expect(result.openingFonder).toBe(17_000)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/17000 kr vid beskattningsårets ingång/)
    expect(result.warnings[0]).toMatch(/börjar den första dagen i en månad, slutar den sista dagen i en månad/)
    expect(result.warnings[0]).toMatch(/punkt 4\.6a i Skatteverkets e-tjänst/)
  })

  it('computes nothing when statslåneräntan for the closing year is not in the table, and names it', () => {
    // A brutet year closing 2027 needs the rate of 30 November 2026.
    const result = computePeriodiseringsfondSchablonintakt([fond('2120', 100_000)], '2026-05-01', '2027-04-30')
    expect(result.amount).toBe(0)
    expect(result.openingFonder).toBe(100_000)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/100000 kr vid beskattningsårets ingång, men statslåneräntan den 30 november 2026/)
    expect(result.warnings[0]).toMatch(/slutar 2027, är inte inlagd/)
    expect(result.warnings[0]).toMatch(/punkt 4\.6a i Skatteverkets e-tjänst/)
  })

  it('computes nothing for a year that started before 2019, when the rule was another', () => {
    const result = computePeriodiseringsfondSchablonintakt([fond('2120', 100_000)], '2018-09-01', '2020-01-31')
    expect(result.amount).toBe(0)
    expect(result.warnings[0]).toMatch(/100000 kr vid beskattningsårets ingång.*börjat före 2019/)
  })

  it('computes nothing when a fond account opens with a debit balance', () => {
    const result = computePeriodiseringsfondSchablonintakt(
      [fond('2120', 100_000), fond('2121', -30_000)],
      ...calendar(2025),
    )
    expect(result.amount).toBe(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/Konto 2121 .*ingående debetsaldo/)
  })
})

describe('wholeMonthsInTaxYear', () => {
  it.each([
    ['2025-01-01', '2025-12-31', 12],
    ['2025-03-01', '2026-02-28', 12],
    ['2023-03-01', '2024-02-29', 12],
    ['2025-07-01', '2026-12-31', 18],
    ['2026-01-01', '2026-06-30', 6],
    ['2026-04-01', '2026-04-30', 1],
  ])('%s to %s is %i whole months', (start, end, months) => {
    expect(wholeMonthsInTaxYear(start, end)).toBe(months)
  })

  it.each([
    ['2025-01-02', '2025-12-31'],
    ['2025-01-01', '2025-12-30'],
    ['2023-03-01', '2024-02-28'],
    ['2024-06-01', '2025-12-31'], // 19 months
    ['2025-12-01', '2025-11-30'], // ends before it starts
    ['2025-1-1', '2025-12-31'],
  ])('%s to %s is not a year of whole months', (start, end) => {
    expect(wholeMonthsInTaxYear(start, end)).toBeNull()
  })
})
