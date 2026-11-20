import { describe, expect, it } from 'vitest'
import {
  buildingTaxAdjustment,
  taxDepreciationForYear,
  taxPlanForYear,
  taxPlanOf,
  taxValueAt,
} from '../building-tax'
import type { Asset, AssetComponent } from '@/types'

/**
 * Tax depreciation on buildings and markanläggningar (IL 19 kap. 5-5 a §§,
 * 20 kap. 5 §) and INK2S 4.9: straight-line on the acquisition value from
 * completion or acquisition, pro rata the first year, the primäravdrag for a
 * new hyreshus, never past the basis, mark never; the book charge added back
 * and the tax plan deducted.
 */

const Y2026 = { period_start: '2026-01-01', period_end: '2026-12-31' }

function building(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'b-1',
    name: 'Kontorshus',
    category: 'building',
    acquisition_date: '2020-01-01',
    acquisition_cost: 1_000_000,
    salvage_value: 0,
    useful_life_months: 600,
    bas_asset_account: '1110',
    bas_accumulated_account: '1119',
    bas_expense_account: '7821',
    disposed_at: null,
    k3_components: null,
    components: [],
    value_adjustments: [],
    tax_depreciation_rate: 2,
    tax_depreciation_from: null,
    tax_primary_allowance: false,
    ...overrides,
  } as Asset
}

function component(id: string, cost: number, life: number | null): AssetComponent {
  return {
    id,
    user_id: 'u',
    company_id: 'c',
    asset_id: 'b-1',
    name: id,
    cost: String(cost),
    useful_life_months: life,
    salvage_value: '0',
    acquisition_date: '2020-01-01',
    depreciation_start_date: null,
    opening_accumulated_depreciation: '0',
    opening_depreciation_date: null,
    replaces_component_id: null,
    derecognised_at: null,
    derecognition_journal_entry_id: null,
    derecognition_depreciation: '0',
    sort_order: 0,
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2020-01-01T00:00:00Z',
  }
}

describe('the tax plan', () => {
  it('needs a rate, never applies to mark, and leaves a mark component out of the basis', () => {
    expect(taxPlanOf(building({ tax_depreciation_rate: null }))).toBeNull()
    expect(taxPlanOf(building({ category: 'land' }))).toBeNull()
    const withComponents = building({
      components: [component('stomme', 700_000, 1200), component('mark', 300_000, null)],
    })
    expect(taxPlanOf(withComponents)?.basis).toBe(700_000)
  })

  it('deducts the rate a year, pro rata in the first year, never past the basis', () => {
    expect(taxDepreciationForYear(taxPlanOf(building())!, Y2026)).toBe(20_000)
    const fromJuly = taxPlanOf(building({ acquisition_date: '2026-07-01' }))!
    expect(taxDepreciationForYear(fromJuly, Y2026)).toBe(10_000)
    const nearlyDone = taxPlanOf(building({ acquisition_date: '1977-01-01', tax_depreciation_rate: 2 }))!
    // 49 years at 2 % leave 20 000; the 50th year takes it, the 51st nothing.
    expect(taxDepreciationForYear(nearlyDone, Y2026)).toBe(20_000)
    expect(taxDepreciationForYear(nearlyDone, { period_start: '2027-01-01', period_end: '2027-12-31' })).toBe(0)
  })

  it('adds the primäravdrag for six years from completion (IL 19 kap. 5 a §)', () => {
    const hyreshus = taxPlanOf(building({ acquisition_date: '2022-01-01', tax_primary_allowance: true }))!
    // Year five of six: 2 % plan and 2 % primäravdrag.
    expect(taxDepreciationForYear(hyreshus, Y2026)).toBe(40_000)
    // Year seven: the plan alone.
    expect(taxDepreciationForYear(hyreshus, { period_start: '2028-01-01', period_end: '2028-12-31' })).toBe(20_000)
  })

  it('gives the tax value at a balansdag', () => {
    // 2020-2026: seven years at 2 %.
    expect(taxValueAt(taxPlanOf(building())!, '2026-12-31')).toBe(860_000)
  })
})

describe('INK2S 4.9', () => {
  it('adds the book charge back and deducts the tax plan, filed net', () => {
    const adjustment = buildingTaxAdjustment([{ asset: building(), book: 30_000 }], Y2026)
    expect(adjustment.net).toBe(10_000)
    expect(adjustment.lines).toEqual([{ assetId: 'b-1', name: 'Kontorshus', book: 30_000, tax: 20_000 }])
    expect(adjustment.warnings).toEqual([])
  })

  it('adds a write-down of mark back, and warns instead of adjusting without a tax plan', () => {
    const land = building({ id: 'm-1', name: 'Tomt', category: 'land', tax_depreciation_rate: null })
    const unplanned = building({ id: 'b-2', name: 'Lager', tax_depreciation_rate: null })
    const adjustment = buildingTaxAdjustment(
      [
        { asset: land, book: 50_000 },
        { asset: unplanned, book: 25_000 },
      ],
      Y2026,
    )
    expect(adjustment.net).toBe(50_000)
    expect(adjustment.warnings).toHaveLength(1)
    expect(adjustment.warnings[0]).toMatch(/Lager/)
  })

  // F6: a plan stated after 2025 was closed reaches 2026 on, never 2025:
  // 2025's INK2 was declared without it and may not move.
  it('applies a plan only to the years it reaches (tax_plan_applies_from)', () => {
    const planned = building({ tax_plan_applies_from: '2026-01-01' })
    const declared = buildingTaxAdjustment([{ asset: planned, book: 30_000 }], { period_start: '2025-01-01', period_end: '2025-12-31' })
    expect(declared.net).toBe(0)
    expect(declared.lines).toEqual([{ assetId: 'b-1', name: 'Kontorshus', book: 30_000, tax: null }])
    expect(buildingTaxAdjustment([{ asset: planned, book: 30_000 }], Y2026).net).toBe(10_000)
    expect(taxPlanForYear(planned, '2025-01-01')).toBeNull()
    expect(taxPlanForYear(planned, '2026-01-01')).not.toBeNull()
  })

  it('leaves machinery out', () => {
    const machine = building({ category: 'machinery', tax_depreciation_rate: null })
    expect(buildingTaxAdjustment([{ asset: machine, book: 10_000 }], Y2026)).toEqual({ net: 0, lines: [], warnings: [] })
  })
})
