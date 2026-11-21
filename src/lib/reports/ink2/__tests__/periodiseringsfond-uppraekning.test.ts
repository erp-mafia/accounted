import { describe, expect, it } from 'vitest'
import {
  computePeriodiseringsfondUppraekning,
  fondMovementsFromTrialBalance,
  hasFondReversal,
  taxYearStartFor,
  upliftPercentForTaxYearStart,
} from '../periodiseringsfond-uppraekning'
import type { TrialBalanceRow } from '@/types'

const CALENDAR_2025 = '2025-01-01'

describe('upliftPercentForTaxYearStart (Skatteverket, Periodiseringsfond for aktiebolag)', () => {
  it('is 6 % before 2019, 4 % for 2019 and 2020, nothing after', () => {
    expect(upliftPercentForTaxYearStart('2018-12-31')).toBe(6)
    expect(upliftPercentForTaxYearStart('2018-07-01')).toBe(6)
    expect(upliftPercentForTaxYearStart('2019-01-01')).toBe(4)
    expect(upliftPercentForTaxYearStart('2020-12-31')).toBe(4)
    expect(upliftPercentForTaxYearStart('2021-01-01')).toBe(0)
  })
})

describe('taxYearStartFor', () => {
  it('reads the räkenskapsår in the books that ends in the cohort year', () => {
    const years = [{ start: '2018-07-01', end: '2019-06-30' }, { start: '2019-07-01', end: '2020-06-30' }]
    expect(taxYearStartFor(2019, years, '2025-07-01')).toEqual({ start: '2018-07-01' })
  })

  it('assumes a calendar year for a calendar-year company with no older years in the books', () => {
    expect(taxYearStartFor(2019, [], CALENDAR_2025)).toEqual({ start: '2019-01-01' })
  })

  it('assumes the current layout for a brutet år when both readings give the same rate', () => {
    // 2019-07-01 and 2020-01-01 are both in the 104 % band.
    expect(taxYearStartFor(2020, [], '2025-07-01')).toEqual({ start: '2019-07-01' })
  })

  it('refuses a brutet år whose two readings give different rates', () => {
    // 2020-07-01 is 104 %, 2021-01-01 is 100 %.
    expect(taxYearStartFor(2021, [], '2025-07-01')).toEqual({ ambiguous: ['2020-07-01', '2021-01-01'] })
  })
})

describe('computePeriodiseringsfondUppraekning (INK2S 4.6d)', () => {
  it("files only the uppräknade part: Skatteverket's example gives 2 400 kr", () => {
    // (10 000 + 50 000) x 104 % + 40 000 = 102 400; 2 400 on 4.6d.
    const result = computePeriodiseringsfondUppraekning({
      funds: [
        { accountNumber: '2129', opening: 10_000, closing: 0 },
        { accountNumber: '2120', opening: 50_000, closing: 0 },
        { accountNumber: '2121', opening: 40_000, closing: 0 },
      ],
      periodStart: CALENDAR_2025,
      fiscalYears: [],
    })
    expect(result.amount).toBe(2_400)
    expect(result.reversed).toBe(100_000)
    expect(result.warnings).toEqual([])
  })

  it('takes 6 % on a fond set aside for a beskattningsår that began in 2018', () => {
    const result = computePeriodiseringsfondUppraekning({
      funds: [{ accountNumber: '2129', opening: 80_000, closing: 0 }],
      periodStart: '2024-07-01',
      fiscalYears: [{ start: '2018-07-01', end: '2019-06-30' }, { start: '2024-07-01', end: '2025-06-30' }],
    })
    expect(result.amount).toBe(4_800)
    expect(result.rows).toEqual([
      { accountNumber: '2129', cohortYear: 2019, taxYearStart: '2018-07-01', reversed: 80_000, upliftPercent: 6 },
    ])
  })

  it('drops the öre of the uppräkning', () => {
    const result = computePeriodiseringsfondUppraekning({
      funds: [{ accountNumber: '2120', opening: 12_345.67, closing: 0 }],
      periodStart: CALENDAR_2025,
      fiscalYears: [],
    })
    // 12 345,67 x 4 % = 493,8268
    expect(result.amount).toBe(493)
  })

  it('takes the oldest fond first, whatever fond the booking used, and says so', () => {
    const result = computePeriodiseringsfondUppraekning({
      funds: [
        { accountNumber: '2120', opening: 30_000, closing: 30_000 },
        { accountNumber: '2122', opening: 50_000, closing: 0 },
      ],
      periodStart: CALENDAR_2025,
      fiscalYears: [],
    })
    // 30 000 from the 2020 fond at 4 %, 20 000 from the 2022 fond at 0 %.
    expect(result.amount).toBe(1_200)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('äldsta fonden först')
  })

  it('declares nothing when no fond was återförd, and ignores a fond set aside this year', () => {
    const result = computePeriodiseringsfondUppraekning({
      funds: [
        { accountNumber: '2120', opening: 30_000, closing: 30_000 },
        { accountNumber: '2125', opening: 0, closing: 40_000 },
      ],
      periodStart: CALENDAR_2025,
      fiscalYears: [],
    })
    expect(result).toEqual({ amount: 0, reversed: 0, rows: [], warnings: [] })
  })

  it('leaves 4.6d to the user when a held fond names no year', () => {
    const result = computePeriodiseringsfondUppraekning({
      funds: [
        { accountNumber: '2110', opening: 25_000, closing: 25_000 },
        { accountNumber: '2121', opening: 40_000, closing: 0 },
      ],
      periodStart: CALENDAR_2025,
      fiscalYears: [],
    })
    expect(result.amount).toBe(0)
    expect(result.warnings[0]).toContain('konto 2110 saknar avsättningsår')
    expect(result.warnings[0]).toContain('punkt 4.6d')
  })

  it('leaves 4.6d to the user for a year that began before 2021', () => {
    const result = computePeriodiseringsfondUppraekning({
      funds: [{ accountNumber: '2129', opening: 10_000, closing: 0 }],
      periodStart: '2020-07-01',
      fiscalYears: [],
    })
    expect(result.amount).toBe(0)
    expect(result.warnings[0]).toContain('före 2021')
  })

  it('leaves 4.6d to the user when the fond year cannot be told', () => {
    const result = computePeriodiseringsfondUppraekning({
      funds: [{ accountNumber: '2121', opening: 40_000, closing: 0 }],
      periodStart: '2025-07-01',
      fiscalYears: [],
    })
    expect(result.amount).toBe(0)
    expect(result.warnings[0]).toContain('2020-07-01 eller 2021-01-01')
  })
})

describe('fondMovementsFromTrialBalance', () => {
  function row(accountNumber: string, opening: number, closing: number): TrialBalanceRow {
    return {
      account_number: accountNumber,
      account_name: `Konto ${accountNumber}`,
      account_class: Number(accountNumber[0]),
      opening_debit: 0,
      opening_credit: opening,
      period_debit: Math.max(0, opening - closing),
      period_credit: Math.max(0, closing - opening),
      closing_debit: 0,
      closing_credit: closing,
    }
  }

  it('reads the fond accounts credit-positive and skips every other account', () => {
    const movements = fondMovementsFromTrialBalance([row('2129', 60_000, 0), row('2081', 25_000, 25_000)])
    expect(movements).toEqual([{ accountNumber: '2129', opening: 60_000, closing: 0 }])
    expect(hasFondReversal(movements)).toBe(true)
    expect(hasFondReversal([{ accountNumber: '2125', opening: 0, closing: 10_000 }])).toBe(false)
  })
})
