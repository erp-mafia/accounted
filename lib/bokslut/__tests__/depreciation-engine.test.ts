import { describe, it, expect } from 'vitest'
import { computeAnnualDepreciation } from '../assets/depreciation-engine'
import type { Asset } from '@/types'

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    user_id: 'user-1',
    company_id: 'co-1',
    name: 'Test',
    category: 'equipment',
    acquisition_date: '2025-01-01',
    acquisition_cost: 60_000,
    salvage_value: 0,
    useful_life_months: 60, // 5 years
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
    notes: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

const FULL_YEAR = { period_start: '2025-01-01', period_end: '2025-12-31' }

describe('computeAnnualDepreciation', () => {
  it('linear over full year: 60_000 / 5 yrs = 12_000', () => {
    const result = computeAnnualDepreciation(makeAsset(), FULL_YEAR)
    expect(result.amount).toBe(12_000)
    expect(result.proRated).toBe(false)
  })

  it('respects salvage value (only depreciates cost − salvage)', () => {
    const asset = makeAsset({ acquisition_cost: 60_000, salvage_value: 10_000 })
    const result = computeAnnualDepreciation(asset, FULL_YEAR)
    // depreciable = 50_000, /5 = 10_000
    expect(result.amount).toBe(10_000)
  })

  it('returns zero when depreciable base ≤ 0', () => {
    const asset = makeAsset({ acquisition_cost: 10_000, salvage_value: 10_000 })
    const result = computeAnnualDepreciation(asset, FULL_YEAR)
    expect(result.amount).toBe(0)
  })

  it('pro-rates first year when acquired mid-period', () => {
    // Acquired July 1, full year period: window = Jul 1: Dec 31 = 184 days
    // out of 365 ≈ 0.5041. Annual depreciation 12_000 × 0.5041 ≈ 6_049
    const asset = makeAsset({ acquisition_date: '2025-07-01' })
    const result = computeAnnualDepreciation(asset, FULL_YEAR)
    expect(result.proRated).toBe(true)
    expect(result.amount).toBeGreaterThan(5_900)
    expect(result.amount).toBeLessThan(6_100)
  })

  it('pro-rates final year when life ends mid-period', () => {
    // 5-year asset acquired 2021-07-01. End of life = 2026-07-01. For fiscal
    // year 2026 (Jan 1: Dec 31) only 181 days are inside the asset's life.
    const asset = makeAsset({
      acquisition_date: '2021-07-01',
      useful_life_months: 60,
    })
    const result = computeAnnualDepreciation(asset, {
      period_start: '2026-01-01',
      period_end: '2026-12-31',
    })
    expect(result.proRated).toBe(true)
    // ~6_000 (half year). Days math: Jan 1 - Jun 30 = 181 days / 365 ≈ 0.4959.
    expect(result.amount).toBeGreaterThan(5_900)
    expect(result.amount).toBeLessThan(6_100)
  })

  it('returns 0 when asset was disposed before the period starts', () => {
    const asset = makeAsset({
      disposed_at: '2024-06-30',
      disposed_proceeds: 5_000,
    })
    const result = computeAnnualDepreciation(asset, FULL_YEAR)
    expect(result.amount).toBe(0)
  })

  it('pro-rates when asset is disposed mid-period', () => {
    // Disposed June 30 of the fiscal year: half-year depreciation.
    const asset = makeAsset({
      disposed_at: '2025-06-30',
      disposed_proceeds: 5_000,
    })
    const result = computeAnnualDepreciation(asset, FULL_YEAR)
    expect(result.proRated).toBe(true)
    expect(result.amount).toBeGreaterThan(5_900)
    expect(result.amount).toBeLessThan(6_100)
  })

  it('returns 0 when asset is fully depreciated before period start', () => {
    // 5-year asset acquired 2018-01-01: fully depreciated by 2023-01-01.
    const asset = makeAsset({ acquisition_date: '2018-01-01' })
    const result = computeAnnualDepreciation(asset, FULL_YEAR)
    expect(result.amount).toBe(0)
  })

  it('K2 5-year schablon for inventarier: 100_000 / 5 = 20_000', () => {
    const asset = makeAsset({
      category: 'equipment',
      acquisition_cost: 100_000,
      useful_life_months: 60,
    })
    const result = computeAnnualDepreciation(asset, FULL_YEAR)
    expect(result.amount).toBe(20_000)
  })

  it('handles 3-year computer with K2 schablon: 30_000 / 3 = 10_000', () => {
    const asset = makeAsset({
      category: 'computer',
      acquisition_cost: 30_000,
      useful_life_months: 36,
    })
    const result = computeAnnualDepreciation(asset, FULL_YEAR)
    expect(result.amount).toBe(10_000)
  })

  it('end-of-month acquisition does not overflow life end (Jan 31 + N months)', () => {
    // Acquired 2025-01-31, 12-month life. Life ends 2026-01-30 (Jan 31 + 12mo
    // clamped to last day of Jan = Jan 31 the following year, exclusive →
    // Jan 30 inclusive). For fiscal year 2026 only Jan 1-30 = 30 days of
    // life remain. Without the clamp, life would overflow to Feb 3 (Jan 31
    // + 12mo via setUTCMonth) and over-depreciate.
    const asset = makeAsset({
      acquisition_date: '2025-01-31',
      acquisition_cost: 12_000,
      useful_life_months: 12,
    })
    const result = computeAnnualDepreciation(asset, {
      period_start: '2026-01-01',
      period_end: '2026-12-31',
    })
    // 30 days out of 365 of a 12_000 annual = ~986. The buggy version would
    // have computed ~1_117 (34 days): the gap detects the regression.
    expect(result.amount).toBeGreaterThan(950)
    expect(result.amount).toBeLessThan(1_020)
  })
})
