import { describe, expect, it } from 'vitest'
import { roundOre } from '@/lib/money'
import { computeComponentDepreciation } from '../component-depreciation'
import { monthsUsedBefore, transitionSplitRows } from '../transition-split'
import type { Asset, AssetComponent } from '@/types'

/**
 * K3 35.18: a plain asset's carrying amount at the transition date divided
 * on components. The components hold the asset's cost and accumulated
 * depreciation unchanged (the split books nothing); the accumulated
 * depreciation follows the depreciated components' carrying amounts and
 * never lands on mark.
 */

const figures = {
  cost: 1_000_000,
  // 2016-2025: ten years at 1.2 %.
  carried: 120_000,
  depreciationStart: '2016-01-01',
  transitionDate: '2026-01-01',
}

describe('transitionSplitRows', () => {
  it('carries the accumulated depreciation into the depreciated components by carrying amount', () => {
    const { rows, errors } = transitionSplitRows(figures, [
      { name: 'Stomme', carrying_amount: 600_000, useful_life_months: 1200, salvage_value: 0 },
      { name: 'Tak', carrying_amount: 180_000, useful_life_months: 480, salvage_value: 0 },
      { name: 'Mark', carrying_amount: 100_000, useful_life_months: null, salvage_value: 0 },
    ])
    expect(errors).toEqual([])
    expect(rows).toEqual([
      { name: 'Stomme', cost: 692_307.69, useful_life_months: 1200, salvage_value: 0, opening_accumulated_depreciation: 92_307.69 },
      { name: 'Tak', cost: 207_692.31, useful_life_months: 480, salvage_value: 0, opening_accumulated_depreciation: 27_692.31 },
      { name: 'Mark', cost: 100_000, useful_life_months: null, salvage_value: 0, opening_accumulated_depreciation: 0 },
    ])
    const cost = rows.reduce((sum, row) => sum + row.cost, 0)
    const opening = rows.reduce((sum, row) => sum + row.opening_accumulated_depreciation, 0)
    expect(roundOre(cost)).toBe(1_000_000)
    expect(roundOre(opening)).toBe(120_000)
  })

  it('needs the carrying amounts to add up to the asset at the transition', () => {
    const { errors } = transitionSplitRows(figures, [
      { name: 'Stomme', carrying_amount: 600_000, useful_life_months: 1200, salvage_value: 0 },
      { name: 'Tak', carrying_amount: 200_000, useful_life_months: 480, salvage_value: 0 },
    ])
    expect(errors.join(' ')).toMatch(/880000 kr \(nu 800000 kr\)/)
  })

  it('refuses one component, a life already run out, a restvärde above the carrying amount and all of it on mark', () => {
    expect(
      transitionSplitRows(figures, [{ name: 'Allt', carrying_amount: 880_000, useful_life_months: 600, salvage_value: 0 }]).errors,
    ).toHaveLength(1)
    const { errors } = transitionSplitRows(figures, [
      { name: 'Stomme', carrying_amount: 780_000, useful_life_months: 120, salvage_value: 0 },
      { name: 'Tak', carrying_amount: 100_000, useful_life_months: 480, salvage_value: 150_000 },
    ])
    expect(errors.join(' ')).toMatch(/Stomme: nyttjandeperioden/)
    expect(errors.join(' ')).toMatch(/Tak: restvärdet/)
    const mark = transitionSplitRows(figures, [
      { name: 'Mark', carrying_amount: 440_000, useful_life_months: null, salvage_value: 0 },
      { name: 'Tomt', carrying_amount: 440_000, useful_life_months: null, salvage_value: 0 },
    ])
    expect(mark.errors.join(' ')).toMatch(/inte till mark/)
  })

  it('counts the months of use from the depreciation start', () => {
    expect(monthsUsedBefore({ depreciationStart: '2016-01-01', transitionDate: '2026-01-01' })).toBe(120)
    expect(monthsUsedBefore({ depreciationStart: '2025-07-15', transitionDate: '2026-01-01' })).toBe(5)
  })

  it('lets the component engine continue from the K2 carrying amount, never recharging a year', () => {
    const { rows } = transitionSplitRows(figures, [
      { name: 'Stomme', carrying_amount: 600_000, useful_life_months: 1200, salvage_value: 0 },
      { name: 'Tak', carrying_amount: 180_000, useful_life_months: 480, salvage_value: 0 },
      { name: 'Mark', carrying_amount: 100_000, useful_life_months: null, salvage_value: 0 },
    ])
    // The rows as split_asset_at_k3_transition writes them: openings stated
    // the day before the transition.
    const components = rows.map((row, index): AssetComponent => ({
      id: `c-${index}`,
      user_id: 'u',
      company_id: 'c',
      asset_id: 'a',
      name: row.name,
      cost: String(row.cost),
      useful_life_months: row.useful_life_months,
      salvage_value: String(row.salvage_value),
      acquisition_date: '2016-01-01',
      depreciation_start_date: null,
      opening_accumulated_depreciation: String(row.opening_accumulated_depreciation),
      opening_depreciation_date: row.opening_accumulated_depreciation > 0 ? '2025-12-31' : null,
      replaces_component_id: null,
      derecognised_at: null,
      derecognition_journal_entry_id: null,
      derecognition_depreciation: '0',
      sort_order: index,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }))
    const asset = { acquisition_date: '2016-01-01', k3_components: null, components, disposed_at: null } as unknown as Asset
    const result = computeComponentDepreciation(asset, { period_start: '2026-01-01', period_end: '2026-12-31' })
    // Stomme: 600 000 over the 1 080 months left; tak: 180 000 over 360; mark none.
    expect(result.perComponent.map((charge) => [charge.name, charge.amount])).toEqual([
      ['Stomme', 6_667],
      ['Tak', 6_000],
      ['Mark', 0],
    ])
  })
})
