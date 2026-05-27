import { describe, it, expect } from 'vitest'
import { validateComponents } from '../k3-components'
import { computeComponentDepreciation, computeAnnualDepreciation } from '../depreciation-engine'
import type { Asset, K3Component } from '@/types'

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    user_id: 'user-1',
    company_id: 'co-1',
    name: 'Test',
    category: 'building',
    acquisition_date: '2025-01-01',
    acquisition_cost: 1_000_000,
    salvage_value: 0,
    useful_life_months: 240, // 20 years asset-level (overridden by components when set)
    depreciation_method: 'linear',
    bas_asset_account: '1110',
    bas_accumulated_account: '1119',
    bas_expense_account: '7821',
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

const FULL_YEAR_2025 = { period_start: '2025-01-01', period_end: '2025-12-31' }

// ============================================================
// validateComponents — pure validator
// ============================================================

describe('validateComponents', () => {
  it('null components → no errors', () => {
    const { errors } = validateComponents({
      acquisition_cost: 100_000,
      k3_components: null,
    })
    expect(errors).toEqual([])
  })

  it('undefined components → no errors', () => {
    const { errors } = validateComponents({
      acquisition_cost: 100_000,
      k3_components: undefined,
    })
    expect(errors).toEqual([])
  })

  it('valid breakdown summing to acquisition_cost → no errors', () => {
    const components: K3Component[] = [
      { name: 'Stomme', cost: 600_000, useful_life_months: 600 },
      { name: 'Tak', cost: 300_000, useful_life_months: 360 },
      { name: 'Installationer', cost: 100_000, useful_life_months: 240 },
    ]
    const { errors } = validateComponents({
      acquisition_cost: 1_000_000,
      k3_components: components,
    })
    expect(errors).toEqual([])
  })

  it('cost mismatch: 100 000 asset with components summing to 95 000 → error', () => {
    const components: K3Component[] = [
      { name: 'A', cost: 50_000, useful_life_months: 60 },
      { name: 'B', cost: 45_000, useful_life_months: 120 },
    ]
    const { errors } = validateComponents({
      acquisition_cost: 100_000,
      k3_components: components,
    })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => e.includes('summerar'))).toBe(true)
  })

  it('cost mismatch within 1 kr tolerance → no error', () => {
    // 99_999.5 vs 100_000 — öre rounding shouldn't fail
    const components: K3Component[] = [
      { name: 'A', cost: 50_000, useful_life_months: 60 },
      { name: 'B', cost: 49_999.5, useful_life_months: 60 },
    ]
    const { errors } = validateComponents({
      acquisition_cost: 100_000,
      k3_components: components,
    })
    expect(errors).toEqual([])
  })

  it('negative useful_life_months → error', () => {
    const components: K3Component[] = [
      { name: 'A', cost: 50_000, useful_life_months: -60 },
      { name: 'B', cost: 50_000, useful_life_months: 60 },
    ]
    const { errors } = validateComponents({
      acquisition_cost: 100_000,
      k3_components: components,
    })
    expect(errors.some((e) => e.toLowerCase().includes('nyttjandeperioden'))).toBe(true)
  })

  it('non-integer useful_life_months → error', () => {
    const components: K3Component[] = [
      { name: 'A', cost: 100_000, useful_life_months: 60.5 },
    ]
    const { errors } = validateComponents({
      acquisition_cost: 100_000,
      k3_components: components,
    })
    expect(errors.some((e) => e.toLowerCase().includes('heltal'))).toBe(true)
  })

  it('component cost ≤ 0 → error', () => {
    const components: K3Component[] = [
      { name: 'A', cost: 0, useful_life_months: 60 },
      { name: 'B', cost: 100_000, useful_life_months: 60 },
    ]
    const { errors } = validateComponents({
      acquisition_cost: 100_000,
      k3_components: components,
    })
    expect(errors.some((e) => e.toLowerCase().includes('anskaffningsvärdet'))).toBe(true)
  })

  it('salvage_value > component cost → error', () => {
    const components: K3Component[] = [
      { name: 'A', cost: 50_000, useful_life_months: 60, salvage_value: 60_000 },
      { name: 'B', cost: 50_000, useful_life_months: 60 },
    ]
    const { errors } = validateComponents({
      acquisition_cost: 100_000,
      k3_components: components,
    })
    expect(errors.some((e) => e.toLowerCase().includes('restvärdet'))).toBe(true)
  })

  it('salvage_value negative → error', () => {
    const components: K3Component[] = [
      { name: 'A', cost: 100_000, useful_life_months: 60, salvage_value: -100 },
    ]
    const { errors } = validateComponents({
      acquisition_cost: 100_000,
      k3_components: components,
    })
    expect(errors.some((e) => e.toLowerCase().includes('restvärdet'))).toBe(true)
  })

  it('empty array but k3_components set to non-null → error', () => {
    const { errors } = validateComponents({
      acquisition_cost: 100_000,
      k3_components: [],
    })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => e.toLowerCase().includes('tom'))).toBe(true)
  })

  it('non-array value → error', () => {
    // Defensive: simulate malformed JSONB read from DB.
    const { errors } = validateComponents({
      acquisition_cost: 100_000,
      // @ts-expect-error -- intentional malformed input
      k3_components: 'not-an-array',
    })
    expect(errors.length).toBeGreaterThan(0)
  })

  it('aggregates multiple errors — does not bail on first', () => {
    const components: K3Component[] = [
      { name: 'A', cost: -100, useful_life_months: 0 },
      { name: 'B', cost: 50_000, useful_life_months: 60, salvage_value: 60_000 },
    ]
    const { errors } = validateComponents({
      acquisition_cost: 100_000,
      k3_components: components,
    })
    // Should catch: negative cost, zero useful life, salvage > cost, plus sum mismatch.
    expect(errors.length).toBeGreaterThanOrEqual(3)
  })
})

// ============================================================
// computeComponentDepreciation — engine
// ============================================================

describe('computeComponentDepreciation', () => {
  it('1M building: roof 300k/240mo, facade 500k/480mo, installations 200k/120mo', () => {
    const asset = makeAsset({
      acquisition_cost: 1_000_000,
      k3_components: [
        { name: 'Tak', cost: 300_000, useful_life_months: 240 },
        { name: 'Fasad', cost: 500_000, useful_life_months: 480 },
        { name: 'Installationer', cost: 200_000, useful_life_months: 120 },
      ],
    })
    // Annual per component:
    //   Tak: 300_000 × 12/240 = 15_000
    //   Fasad: 500_000 × 12/480 = 12_500
    //   Installationer: 200_000 × 12/120 = 20_000
    //   Sum: 47_500
    const result = computeComponentDepreciation(asset, FULL_YEAR_2025)
    expect(result.amount).toBe(47_500)
    expect(result.proRated).toBe(false)
    expect(result.perComponent).toHaveLength(3)
    expect(result.perComponent[0]).toEqual({ name: 'Tak', amount: 15_000 })
    expect(result.perComponent[1]).toEqual({ name: 'Fasad', amount: 12_500 })
    expect(result.perComponent[2]).toEqual({ name: 'Installationer', amount: 20_000 })
  })

  it('half-year pro-ration: acquired July 1 → roughly half the annual sum', () => {
    const asset = makeAsset({
      acquisition_date: '2025-07-01',
      acquisition_cost: 1_000_000,
      k3_components: [
        { name: 'Tak', cost: 300_000, useful_life_months: 240 },
        { name: 'Fasad', cost: 500_000, useful_life_months: 480 },
        { name: 'Installationer', cost: 200_000, useful_life_months: 120 },
      ],
    })
    // Full-year sum = 47_500. Jul 1 - Dec 31 = 184 days, 184/365 ≈ 0.5041.
    // Per-component rounding may slightly drift — accept ~5_900–6_100 per row sum.
    const result = computeComponentDepreciation(asset, FULL_YEAR_2025)
    expect(result.proRated).toBe(true)
    expect(result.amount).toBeGreaterThan(23_500)
    expect(result.amount).toBeLessThan(24_500)
    // perComponent entries each carry roughly half of their full-year amount.
    expect(result.perComponent[0].amount).toBeGreaterThan(7_400)
    expect(result.perComponent[0].amount).toBeLessThan(7_700)
  })

  it('mid-year disposal: each component pro-rates to disposal date', () => {
    const asset = makeAsset({
      acquisition_cost: 1_000_000,
      disposed_at: '2025-06-30',
      disposed_proceeds: 800_000,
      k3_components: [
        { name: 'Tak', cost: 300_000, useful_life_months: 240 },
        { name: 'Fasad', cost: 500_000, useful_life_months: 480 },
        { name: 'Installationer', cost: 200_000, useful_life_months: 120 },
      ],
    })
    // Jan 1 - Jun 30 = 181 days / 365 ≈ 0.4959. Full sum 47_500 × 0.4959 ≈ 23_555.
    const result = computeComponentDepreciation(asset, FULL_YEAR_2025)
    expect(result.proRated).toBe(true)
    expect(result.amount).toBeGreaterThan(23_200)
    expect(result.amount).toBeLessThan(23_900)
  })

  it('respects per-component salvage_value', () => {
    const asset = makeAsset({
      acquisition_cost: 100_000,
      k3_components: [
        // 100_000 cost − 20_000 salvage = 80_000 depreciable / 60 months
        // → 80_000 × 12/60 = 16_000 per year
        { name: 'A', cost: 100_000, useful_life_months: 60, salvage_value: 20_000 },
      ],
    })
    const result = computeComponentDepreciation(asset, FULL_YEAR_2025)
    expect(result.amount).toBe(16_000)
  })

  it('returns zero when components array is empty', () => {
    const asset = makeAsset({
      k3_components: [],
    })
    const result = computeComponentDepreciation(asset, FULL_YEAR_2025)
    expect(result.amount).toBe(0)
    expect(result.perComponent).toEqual([])
  })

  it('skips components fully past end-of-life (window collapses)', () => {
    // Component with 12-month life acquired Jan 1, 2023 — fully depreciated by
    // Jan 1, 2024. For fiscal year 2025 (Jan 1 - Dec 31) the window is empty.
    const asset = makeAsset({
      acquisition_date: '2023-01-01',
      acquisition_cost: 100_000,
      k3_components: [
        { name: 'Kort', cost: 30_000, useful_life_months: 12 },
        { name: 'Lång', cost: 70_000, useful_life_months: 240 },
      ],
    })
    const result = computeComponentDepreciation(asset, FULL_YEAR_2025)
    // Kort: 0 (life ended). Lång: 70_000 × 12/240 = 3_500.
    expect(result.amount).toBe(3_500)
    expect(result.perComponent[0]).toEqual({ name: 'Kort', amount: 0 })
    expect(result.perComponent[1]).toEqual({ name: 'Lång', amount: 3_500 })
  })

  it('treats components with non-positive cost/life as 0 (defensive)', () => {
    const asset = makeAsset({
      acquisition_cost: 100_000,
      k3_components: [
        { name: 'Trasig', cost: 0, useful_life_months: 0 },
        { name: 'Ok', cost: 100_000, useful_life_months: 60 },
      ],
    })
    const result = computeComponentDepreciation(asset, FULL_YEAR_2025)
    // Bad row is skipped; good row produces 100_000 × 12/60 = 20_000.
    expect(result.amount).toBe(20_000)
    expect(result.perComponent[0].amount).toBe(0)
    expect(result.perComponent[1].amount).toBe(20_000)
  })

  it('uses empty-name fallback label', () => {
    const asset = makeAsset({
      acquisition_cost: 100_000,
      k3_components: [
        { name: '', cost: 100_000, useful_life_months: 60 },
      ],
    })
    const result = computeComponentDepreciation(asset, FULL_YEAR_2025)
    expect(result.perComponent[0].name).toBe('Komponent 1')
  })
})

// ============================================================
// computeAnnualDepreciation dispatch — k3_components precedence
// ============================================================

describe('computeAnnualDepreciation — K3 dispatch', () => {
  it('routes to component depreciation when k3_components is non-empty', () => {
    const asset = makeAsset({
      acquisition_cost: 1_000_000,
      // method+life on the asset would compute different number — engine should ignore them
      depreciation_method: 'declining_balance_30',
      useful_life_months: 60,
      k3_components: [
        { name: 'Tak', cost: 300_000, useful_life_months: 240 },
        { name: 'Fasad', cost: 500_000, useful_life_months: 480 },
        { name: 'Installationer', cost: 200_000, useful_life_months: 120 },
      ],
    })
    const result = computeAnnualDepreciation(asset, FULL_YEAR_2025)
    // Component sum (see test above) = 47_500.
    expect(result.amount).toBe(47_500)
    expect(result.proRated).toBe(false)
  })

  it('K2-path stays byte-equivalent: linear asset without k3_components is unchanged', () => {
    // 60_000 / 5yr = 12_000 per year — same as the linear baseline test.
    const asset = makeAsset({
      acquisition_cost: 60_000,
      useful_life_months: 60,
      k3_components: null,
      depreciation_method: 'linear',
      category: 'equipment',
      bas_asset_account: '1220',
      bas_accumulated_account: '1229',
      bas_expense_account: '7832',
    })
    const result = computeAnnualDepreciation(asset, FULL_YEAR_2025)
    expect(result.amount).toBe(12_000)
    expect(result.proRated).toBe(false)
  })

  it('K2-path stays byte-equivalent: empty array of components is treated as "no components"', () => {
    // Engine guards with .length > 0 — an empty array must fall through to
    // the method-based dispatch so a tampered DB row doesn't zero out the
    // depreciation silently.
    const asset = makeAsset({
      acquisition_cost: 60_000,
      useful_life_months: 60,
      k3_components: [],
      depreciation_method: 'linear',
    })
    const result = computeAnnualDepreciation(asset, FULL_YEAR_2025)
    expect(result.amount).toBe(12_000)
  })

  it('disposal before period start returns 0 even with components', () => {
    const asset = makeAsset({
      acquisition_cost: 1_000_000,
      disposed_at: '2024-12-31',
      disposed_proceeds: 500_000,
      k3_components: [
        { name: 'Tak', cost: 300_000, useful_life_months: 240 },
        { name: 'Fasad', cost: 500_000, useful_life_months: 480 },
        { name: 'Installationer', cost: 200_000, useful_life_months: 120 },
      ],
    })
    const result = computeAnnualDepreciation(asset, FULL_YEAR_2025)
    expect(result.amount).toBe(0)
  })
})
