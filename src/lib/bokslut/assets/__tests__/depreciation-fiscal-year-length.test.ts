/**
 * Planenlig avskrivning in a fiscal year that is not 12 months.
 *
 * K2 (BFNAR 2016:10) punkt 10.23, BFN's kommentar: "Omfattar räkenskapsåret
 * annan tid än 12 månader behöver avskrivningen justeras utifrån
 * räkenskapsårets längd." A förlängt first year of 15 months carries 15
 * months of depreciation for an asset held all of it; a förkortat year of 6
 * months carries 6.
 *
 * The engine scales every path (plain linear, opening balance, K3
 * components) by the year's length in months over 12. That factor is
 * exactly 1 for a 12-month year, so the first block pins the amounts a
 * 12-month year produced before the change.
 */
import { describe, it, expect } from 'vitest'
import {
  computeAnnualDepreciation,
  computeComponentDepreciation,
} from '../depreciation-engine'
import type { Asset, K3Component } from '@/types'

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    user_id: 'user-1',
    company_id: 'co-1',
    name: 'Inventarie',
    category: 'equipment',
    acquisition_date: '2025-01-01',
    // 12 000 kr over 60 months: 2 400 kr per 12 months, 200 kr per month.
    acquisition_cost: 12_000,
    salvage_value: 0,
    useful_life_months: 60,
    depreciation_method: 'linear',
    bas_asset_account: '1220',
    bas_accumulated_account: '1229',
    bas_expense_account: '7832',
    restvarde_target: null,
    disposed_at: null,
    disposed_proceeds: null,
    disposed_proceeds_vat: 0,
    disposed_vat_treatment: null,
    jamkning_amount: 0,
    jamkning_remaining_months: null,
    jamkning_total_months: null,
    jamkning_original_input_vat: null,
    k3_components: null,
    opening_accumulated_depreciation: 0,
    opening_depreciation_date: null,
    notes: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

/** Two K3 components, each 1 200 kr per 12 months. */
const COMPONENTS: K3Component[] = [
  { name: 'Stomme', cost: 120_000, useful_life_months: 1_200 },
  { name: 'Tak', cost: 36_000, useful_life_months: 360 },
]

function makeComponentAsset(overrides: Partial<Asset> = {}): Asset {
  return makeAsset({
    name: 'Byggnad',
    category: 'building',
    acquisition_cost: 156_000,
    useful_life_months: 1_200,
    bas_asset_account: '1110',
    bas_accumulated_account: '1119',
    bas_expense_account: '7821',
    k3_components: COMPONENTS,
    ...overrides,
  })
}

const CALENDAR_2025 = { period_start: '2025-01-01', period_end: '2025-12-31' }
/** Förlängt first year: 15 months, 457 days. */
const LONG_15_MONTHS = { period_start: '2025-06-01', period_end: '2026-08-31' }
/** Förkortat year: 6 months, 184 days. */
const SHORT_6_MONTHS = { period_start: '2025-07-01', period_end: '2025-12-31' }

describe('12-month years: amounts are unchanged', () => {
  // Each expected amount is what the engine produced before the year-length
  // factor existed (annual x days held / days in the year, whole kronor).
  it.each([
    {
      label: 'calendar year, held all year',
      period: CALENDAR_2025,
      asset: {},
      amount: 2_400,
      proRated: false,
    },
    {
      label: 'calendar year, acquired 1 July (184/365 days)',
      period: CALENDAR_2025,
      asset: { acquisition_date: '2025-07-01' },
      amount: 1_210,
      proRated: true,
    },
    {
      label: 'brutet year Sep-Aug, acquired 1 March (184/365 days)',
      period: { period_start: '2025-09-01', period_end: '2026-08-31' },
      asset: { acquisition_date: '2026-03-01' },
      amount: 1_210,
      proRated: true,
    },
    {
      label: 'leap calendar year, acquired 1 October (92/366 days)',
      period: { period_start: '2024-01-01', period_end: '2024-12-31' },
      asset: { acquisition_date: '2024-10-01' },
      amount: 603,
      proRated: true,
    },
    {
      label: 'brutet year across a leap day, held all year',
      period: { period_start: '2023-05-01', period_end: '2024-04-30' },
      asset: { acquisition_date: '2023-05-01' },
      amount: 2_400,
      proRated: false,
    },
    {
      label: 'life ends 30 June (181/365 days)',
      period: CALENDAR_2025,
      asset: { acquisition_date: '2020-07-01' },
      amount: 1_190,
      proRated: true,
    },
    {
      label: 'disposed 31 March (90/365 days)',
      period: CALENDAR_2025,
      asset: { acquisition_date: '2024-01-01', disposed_at: '2025-03-31' },
      amount: 592,
      proRated: true,
    },
  ])('linear: $label', ({ period, asset, amount, proRated }) => {
    expect(computeAnnualDepreciation(makeAsset(asset), period)).toEqual({ amount, proRated })
  })

  it('opening balance: 7 200 kr left over 36 months gives 2 400 kr', () => {
    const asset = makeAsset({
      acquisition_date: '2023-01-01',
      opening_accumulated_depreciation: 4_800,
      opening_depreciation_date: '2024-12-31',
    })
    expect(computeAnnualDepreciation(asset, CALENDAR_2025)).toEqual({
      amount: 2_400,
      proRated: false,
    })
  })

  it('K3 components: acquired 1 April (275/365 days), each component rounded', () => {
    const result = computeComponentDepreciation(
      makeComponentAsset({ acquisition_date: '2025-04-01' }),
      CALENDAR_2025,
    )
    expect(result.perComponent).toEqual([
      { name: 'Stomme', amount: 904 },
      { name: 'Tak', amount: 904 },
    ])
    expect(result.amount).toBe(1_808)
    expect(result.proRated).toBe(true)
  })
})

describe('förlängt first year (15 months)', () => {
  it('an asset held all year gets 15 months of depreciation, not 12', () => {
    // Before: 2 400 (the full year counted as 12 months).
    const result = computeAnnualDepreciation(
      makeAsset({ acquisition_date: '2025-06-01' }),
      LONG_15_MONTHS,
    )
    expect(result).toEqual({ amount: 3_000, proRated: false })
  })

  it('a mid-year acquisition gets its months of use, not a share of 12', () => {
    // Held 2025-09-01..2026-08-31: 12 months of use. The day share of the
    // long year (365/457) scaled by 15/12 gives 2 396, about 12 x 200.
    // Before: 1 917 (365/457 of a 12-month charge).
    const result = computeAnnualDepreciation(
      makeAsset({ acquisition_date: '2025-09-01' }),
      LONG_15_MONTHS,
    )
    expect(result).toEqual({ amount: 2_396, proRated: true })
  })

  it('an acquisition three months before year end gets about three months', () => {
    // 92/457 days x 15/12 x 2 400 = 604 (3 x 200 = 600). Before: 483.
    const result = computeAnnualDepreciation(
      makeAsset({ acquisition_date: '2026-06-01' }),
      LONG_15_MONTHS,
    )
    expect(result).toEqual({ amount: 604, proRated: true })
  })

  it('a first year that starts on the registration date counts its part month', () => {
    // 2025-03-17..2026-06-30 is 15 months and 14 of 30 days: 15.4667 months.
    // 2 400 x 15.4667 / 12 = 3 093.
    const result = computeAnnualDepreciation(
      makeAsset({ acquisition_date: '2025-03-17' }),
      { period_start: '2025-03-17', period_end: '2026-06-30' },
    )
    expect(result).toEqual({ amount: 3_093, proRated: false })
  })

  it('opening balance: the remaining plan runs 15 months in the long year', () => {
    // 24 of 60 months (4 800) written off in the previous system per
    // 2025-05-31; 7 200 left over 36 months is 200 per month. Before: 2 400.
    const asset = makeAsset({
      acquisition_date: '2023-06-01',
      opening_accumulated_depreciation: 4_800,
      opening_depreciation_date: '2025-05-31',
    })
    expect(computeAnnualDepreciation(asset, LONG_15_MONTHS)).toEqual({
      amount: 3_000,
      proRated: false,
    })
  })

  it('K3 components: each component gets 15 months', () => {
    // Before: 1 200 + 1 200.
    const result = computeComponentDepreciation(
      makeComponentAsset({ acquisition_date: '2025-06-01' }),
      LONG_15_MONTHS,
    )
    expect(result.perComponent).toEqual([
      { name: 'Stomme', amount: 1_500 },
      { name: 'Tak', amount: 1_500 },
    ])
    expect(result.amount).toBe(3_000)
    expect(result.proRated).toBe(false)
  })

  it('a disposal inside the long year gets its months of use', () => {
    // Held 2025-06-01..2026-02-28: 9 months, 273/457 days.
    // 2 400 x 273/457 x 15/12 = 1 792 (9 x 200 = 1 800). Before: 1 434.
    // buildAssetDisposalPlan compares posted schedules with this amount.
    const result = computeAnnualDepreciation(
      makeAsset({ acquisition_date: '2025-06-01', disposed_at: '2026-02-28' }),
      LONG_15_MONTHS,
    )
    expect(result).toEqual({ amount: 1_792, proRated: true })
  })
})

/**
 * Known residual at life end, pinned so it is visible rather than hidden.
 *
 * The year-length factor turns the day share of a long or short year into
 * months at that year's average month length, while a 12-month year keeps
 * converting at 365 or 366 days. The plain linear path computes every year
 * from cost with no cap at the remaining value and no catch-up at life end,
 * so a life that ends in or after a year that is not 12 months can land a
 * few kronor under cost, or up to about 0.3 percent over it. Scale only is
 * the scoped fix; the cap and the life-end catch-up are a separate issue.
 * When that lands, these expectations change to land exactly on cost.
 */
describe('life end with a year that is not 12 months: residual (scale only)', () => {
  /** Förlängt first year of 18 months, the longest a first year may run. */
  const LONG_18_MONTHS = { period_start: '2025-01-01', period_end: '2026-06-30' }

  it('a life that ends inside an 18-month year books more than cost', () => {
    // 100 000 kr over 12 months, held 2025-01-01..2025-12-31: 365/546 days
    // x 18/12 x 100 000 = 100 275, 275 kr over cost. Before: 66 850, and
    // the other 33 150 was never booked.
    const result = computeAnnualDepreciation(
      makeAsset({ acquisition_cost: 100_000, useful_life_months: 12 }),
      LONG_18_MONTHS,
    )
    expect(result).toEqual({ amount: 100_275, proRated: true })
  })

  it('a life that ends in the 12-month year after an 18-month year books more than cost', () => {
    // 100 000 kr over 24 months: 18 months in the long year (75 000), then
    // 2026-07-01..2026-12-31 as 184/365 of a 12-month charge (25 205).
    const asset = makeAsset({ acquisition_cost: 100_000, useful_life_months: 24 })
    const long = computeAnnualDepreciation(asset, LONG_18_MONTHS)
    const next = computeAnnualDepreciation(asset, {
      period_start: '2026-07-01',
      period_end: '2027-06-30',
    })
    expect(long).toEqual({ amount: 75_000, proRated: false })
    expect(next).toEqual({ amount: 25_205, proRated: true })
    expect(long.amount + next.amount).toBe(100_205)
  })

  it('a mid-year acquisition in a 15-month year strands a few kronor over the life', () => {
    // 12 000 kr over 60 months, acquired 2025-09-01: 2 396 in the long year,
    // then four full 12-month years to the end of the life on 2030-08-31.
    // Total 11 996: 4 kr are never booked.
    const asset = makeAsset({ acquisition_date: '2025-09-01' })
    const years = [
      LONG_15_MONTHS,
      { period_start: '2026-09-01', period_end: '2027-08-31' },
      { period_start: '2027-09-01', period_end: '2028-08-31' },
      { period_start: '2028-09-01', period_end: '2029-08-31' },
      { period_start: '2029-09-01', period_end: '2030-08-31' },
    ]
    const amounts = years.map((year) => computeAnnualDepreciation(asset, year).amount)
    expect(amounts).toEqual([2_396, 2_400, 2_400, 2_400, 2_400])
    expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(11_996)
  })
})

describe('förkortat year (6 months)', () => {
  it('an asset held all year gets 6 months of depreciation, not 12', () => {
    // Before: 2 400.
    const result = computeAnnualDepreciation(
      makeAsset({ acquisition_date: '2025-07-01' }),
      SHORT_6_MONTHS,
    )
    expect(result).toEqual({ amount: 1_200, proRated: false })
  })

  it('an acquisition halfway through gets three months', () => {
    // 92/184 days x 6/12 x 2 400 = 600. Before: 1 200.
    const result = computeAnnualDepreciation(
      makeAsset({ acquisition_date: '2025-10-01' }),
      SHORT_6_MONTHS,
    )
    expect(result).toEqual({ amount: 600, proRated: true })
  })

  it('opening balance: the remaining plan runs 6 months in the short year', () => {
    // 24 of 60 months (4 800) written off per 2025-06-30; 200 per month.
    // Before: 2 400.
    const asset = makeAsset({
      acquisition_date: '2023-07-01',
      opening_accumulated_depreciation: 4_800,
      opening_depreciation_date: '2025-06-30',
    })
    expect(computeAnnualDepreciation(asset, SHORT_6_MONTHS)).toEqual({
      amount: 1_200,
      proRated: false,
    })
  })

  it('K3 components: each component gets 6 months', () => {
    // Before: 1 200 + 1 200.
    const result = computeComponentDepreciation(
      makeComponentAsset({ acquisition_date: '2025-07-01' }),
      SHORT_6_MONTHS,
    )
    expect(result.perComponent).toEqual([
      { name: 'Stomme', amount: 600 },
      { name: 'Tak', amount: 600 },
    ])
    expect(result.amount).toBe(1_200)
    expect(result.proRated).toBe(false)
  })
})
