import { describe, expect, it } from 'vitest'
import { carryingAmountAt } from '../carrying-amount'
import type { Asset, AssetComponent, AssetValueAdjustment } from '@/types'

/**
 * The carrying amount at a balansdag (K3 29.14): a plain asset from its
 * asset-level history, a component asset per component on the books that
 * day, so a replaced component and a K3 transition split (history in the
 * openings) are never counted twice.
 */

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'a-1',
    name: 'Kontorshus',
    category: 'building',
    acquisition_date: '2020-01-01',
    acquisition_cost: 1_000_000,
    salvage_value: 0,
    useful_life_months: 600,
    opening_accumulated_depreciation: 0,
    opening_depreciation_date: null,
    disposed_at: null,
    k3_components: null,
    components: [],
    value_adjustments: [],
    ...overrides,
  } as Asset
}

function component(id: string, cost: number, overrides: Partial<AssetComponent> = {}): AssetComponent {
  return {
    id,
    user_id: 'u',
    company_id: 'c',
    asset_id: 'a-1',
    name: id,
    cost: String(cost),
    useful_life_months: 600,
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
    ...overrides,
  }
}

function impairment(amount: number, date: string, componentId: string | null = null): AssetValueAdjustment {
  return {
    id: `v-${date}`,
    asset_id: 'a-1',
    component_id: componentId,
    kind: 'impairment',
    adjustment_date: date,
    fiscal_period_id: 'p',
    amount,
    recoverable_amount: 0,
    reason: 'test',
    expense_account: '7720',
    accumulated_account: '1118',
    journal_entry_id: 'je',
    created_at: `${date}T00:00:00Z`,
    journal_entry: { status: 'posted' },
  } as AssetValueAdjustment
}

const none = new Map<string, number>()

describe('carryingAmountAt', () => {
  it('takes a plain asset as cost less opening, posted depreciation and write-down', () => {
    const plain = asset({
      opening_accumulated_depreciation: 50_000,
      opening_depreciation_date: '2021-12-31',
      value_adjustments: [impairment(30_000, '2025-12-31'), impairment(99_000, '2026-12-31')],
    })
    expect(carryingAmountAt(plain, '2025-12-31', { total: 80_000, byComponent: none })).toBe(840_000)
  })

  it('sums a component asset per component and ignores the asset-level total', () => {
    const split = asset({
      components: [
        // A K3 transition split: the history before it is in the openings.
        component('stomme', 700_000, { opening_accumulated_depreciation: '84000', opening_depreciation_date: '2025-12-31' }),
        component('tak', 300_000, { opening_accumulated_depreciation: '36000', opening_depreciation_date: '2025-12-31' }),
      ],
    })
    const byComponent = new Map([
      ['stomme', 7_000],
      ['tak', 10_000],
    ])
    // The plain years before the split total 120 000; they must not count again.
    expect(carryingAmountAt(split, '2026-12-31', { total: 137_000, byComponent })).toBe(863_000)
  })

  it('leaves out a component derecognised by the day and one acquired after it', () => {
    const replaced = asset({
      components: [
        component('stomme', 700_000),
        component('gammalt tak', 300_000, { derecognised_at: '2026-06-30' }),
        component('nytt tak', 400_000, { acquisition_date: '2026-07-01' }),
      ],
      value_adjustments: [impairment(20_000, '2026-12-31', 'stomme')],
    })
    expect(carryingAmountAt(replaced, '2026-06-30', { total: 0, byComponent: none })).toBe(700_000)
    expect(carryingAmountAt(replaced, '2026-12-31', { total: 0, byComponent: none })).toBe(1_080_000)
  })
})
