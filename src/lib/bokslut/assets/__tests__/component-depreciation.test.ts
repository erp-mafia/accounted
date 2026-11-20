import { describe, expect, it } from 'vitest'
import {
  componentsOf,
  computeComponentDepreciation,
  computeUnitCharge,
  historyCompleteFrom,
  type DepreciationUnit,
} from '../component-depreciation'
import { allocateOpeningToComponents } from '../k3-components'
import type { Asset, AssetComponent } from '@/types'

const YEAR = (y: number) => ({ id: `fp-${y}`, period_start: `${y}-01-01`, period_end: `${y}-12-31` })

function unit(overrides: Partial<DepreciationUnit> = {}): DepreciationUnit {
  return {
    key: 'c-1',
    name: 'Tak',
    cost: 120_000,
    salvage: 0,
    usefulLifeMonths: 120,
    startDate: '2020-01-01',
    opening: null,
    postedBefore: 0,
    writtenDownBefore: 0,
    revaluedBefore: 0,
    endDate: null,
    historyComplete: true,
    ...overrides,
  }
}

function row(overrides: Partial<AssetComponent>): AssetComponent {
  return {
    id: 'c-1',
    user_id: 'u',
    company_id: 'co',
    asset_id: 'a',
    name: 'Tak',
    cost: '120000.00',
    useful_life_months: 120,
    salvage_value: '0.00',
    acquisition_date: '2020-01-01',
    depreciation_start_date: null,
    opening_accumulated_depreciation: '0.00',
    opening_depreciation_date: null,
    replaces_component_id: null,
    derecognised_at: null,
    derecognition_journal_entry_id: null,
    derecognition_depreciation: '0.00',
    sort_order: 0,
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2020-01-01T00:00:00Z',
    ...overrides,
  }
}

function asset(components: AssetComponent[], overrides: Partial<Asset> = {}): Asset {
  return {
    acquisition_date: '2020-01-01',
    k3_components: null,
    components,
    disposed_at: null,
    ...overrides,
  } as Asset
}

describe('computeUnitCharge: the straight-line plan', () => {
  it('charges cost less salvage over the life, a full year at a time', () => {
    expect(computeUnitCharge(unit(), YEAR(2020))).toEqual({ amount: 12_000, proRated: false })
    expect(computeUnitCharge(unit({ salvage: 24_000 }), YEAR(2020)).amount).toBe(9_600)
  })

  it('a component that is not depreciated (mark) is never charged', () => {
    expect(computeUnitCharge(unit({ usefulLifeMonths: null }), YEAR(2025))).toEqual({ amount: 0, proRated: false })
  })

  it('starts when the component can be used (K3 17.18), not at acquisition', () => {
    const charge = computeUnitCharge(unit({ startDate: '2025-07-01' }), YEAR(2025))
    expect(charge.proRated).toBe(true)
    // 184 of 365 days of a 12 000 kr year.
    expect(charge.amount).toBe(6_049)
  })
})

describe('computeUnitCharge: prospective from the posted history', () => {
  it('spreads what is left over the remaining life after a shortened life (K3 10.9)', () => {
    // Posted 2020-2022 on a 10-year life (36 000), then the life is cut to
    // 5 years in total: 84 000 left over the 24 months to 2024-12-31.
    const changed = unit({ usefulLifeMonths: 60, postedBefore: 36_000 })
    expect(computeUnitCharge(changed, YEAR(2023)).amount).toBe(42_000)
    // The last year takes exactly what is left.
    expect(computeUnitCharge({ ...changed, postedBefore: 78_000 }, YEAR(2024)).amount).toBe(42_000)
  })

  it('reproduces the straight line when nothing changed', () => {
    expect(computeUnitCharge(unit({ postedBefore: 36_000 }), YEAR(2023)).amount).toBe(12_000)
  })

  it('trues up the last year to the öre', () => {
    const odd = unit({ cost: 10_000.5, usefulLifeMonths: 24, startDate: '2024-01-01', postedBefore: 5_000 })
    expect(computeUnitCharge(odd, YEAR(2025)).amount).toBe(5_000.5)
  })

  it('with an incomplete history keeps the straight-line charge instead of catching up', () => {
    const migrated = unit({ historyComplete: false })
    // Nothing posted in Accounted for 2020-2024 (booked elsewhere): 12 000, not 120 000 / 60 months.
    expect(computeUnitCharge(migrated, YEAR(2025)).amount).toBe(12_000)
  })

  it('continues an opening balance per component over the remaining life', () => {
    const opened = unit({ opening: { amount: 30_000, date: '2022-12-31' } })
    // 90 000 left over the 84 months from 2023-01-01.
    expect(computeUnitCharge(opened, YEAR(2023)).amount).toBe(12_857)
  })

  it('stops at the disposal date', () => {
    const charge = computeUnitCharge(unit({ endDate: '2025-06-30', postedBefore: 60_000 }), YEAR(2025))
    expect(charge.proRated).toBe(true)
    expect(charge.amount).toBe(5_951)
  })
})

describe('computeComponentDepreciation', () => {
  it('splits the year per active component, summing exactly', () => {
    const result = computeComponentDepreciation(
      asset([
        row({ id: 'tak', name: 'Tak' }),
        row({ id: 'stomme', name: 'Stomme', cost: '600000.00', useful_life_months: 600, sort_order: 1 }),
        row({ id: 'mark', name: 'Mark', cost: '200000.00', useful_life_months: null, sort_order: 2 }),
      ]),
      YEAR(2021),
      { posted: new Map([['tak', 12_000], ['stomme', 12_000]]), isComplete: () => true },
    )
    expect(result.perComponent.map((c) => [c.componentId, c.amount])).toEqual([
      ['tak', 12_000],
      ['stomme', 12_000],
      ['mark', 0],
    ])
    expect(result.amount).toBe(24_000)
  })

  it('leaves out a component derecognised in the year: its charge was on the replacement voucher', () => {
    const result = computeComponentDepreciation(
      asset([
        row({ id: 'tak', derecognised_at: '2021-06-30', derecognition_journal_entry_id: 'je' }),
        row({ id: 'nytt', acquisition_date: '2021-06-30', cost: '150000.00', useful_life_months: 300, replaces_component_id: 'tak', sort_order: 1 }),
      ]),
      YEAR(2021),
    )
    expect(result.perComponent.map((c) => c.componentId)).toEqual(['nytt'])
  })

  it('reads the projection when the register rows were not loaded', () => {
    const projected = { acquisition_date: '2025-01-01', components: undefined, disposed_at: null, k3_components: [
      { component_id: 'x', name: 'Tak', cost: 60_000, useful_life_months: 60 },
    ] } as unknown as Asset
    expect(componentsOf(projected)[0].id).toBe('x')
    expect(computeComponentDepreciation(projected, YEAR(2025)).amount).toBe(12_000)
  })
})

describe('historyCompleteFrom', () => {
  const periods = [YEAR(2023), YEAR(2024), YEAR(2025)]

  it('is whole when every year from the anchor is posted', () => {
    expect(historyCompleteFrom('2023-03-01', '2025-01-01', periods, new Set(['fp-2023', 'fp-2024']))).toBe(true)
  })

  it('is not whole with a year missing or the anchor before the first fiscal year', () => {
    expect(historyCompleteFrom('2023-03-01', '2025-01-01', periods, new Set(['fp-2024']))).toBe(false)
    expect(historyCompleteFrom('2020-01-01', '2025-01-01', periods, new Set(['fp-2023', 'fp-2024']))).toBe(false)
  })

  it('is whole when the anchor falls in the period itself', () => {
    expect(historyCompleteFrom('2025-04-01', '2025-01-01', periods, new Set())).toBe(true)
  })
})

describe('allocateOpeningToComponents', () => {
  it('splits by how much of each life had passed, sums exactly, gives mark nothing', () => {
    const split = allocateOpeningToComponents(
      [
        { name: 'Tak', cost: 120_000, useful_life_months: 120 },
        { name: 'Stomme', cost: 600_000, useful_life_months: 600 },
        { name: 'Mark', cost: 280_000, useful_life_months: null },
      ],
      { amount: 49_999.99, date: '2024-12-31' },
      '2020-01-01',
    )
    // Five years in: Tak 60 000 and Stomme 60 000 by their own plans, so half
    // each, the öre of rounding on one of them.
    const amounts = split.map((c) => c.opening_accumulated_depreciation ?? 0)
    expect(Math.abs(amounts[0] - 25_000)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(amounts[1] - 25_000)).toBeLessThanOrEqual(0.01)
    expect(amounts[2]).toBe(0)
    expect(Math.round((amounts[0] + amounts[1]) * 100)).toBe(4_999_999)
    expect(split[0].opening_depreciation_date).toBe('2024-12-31')
    expect(split[2].opening_depreciation_date).toBeNull()
  })

  it('caps a component at its depreciable base and moves the rest on', () => {
    const split = allocateOpeningToComponents(
      [
        { name: 'Kort', cost: 10_000, useful_life_months: 12 },
        { name: 'Lång', cost: 90_000, useful_life_months: 1200 },
      ],
      { amount: 20_000, date: '2024-12-31' },
      '2020-01-01',
    )
    expect(split[0].opening_accumulated_depreciation).toBe(10_000)
    expect(split[1].opening_accumulated_depreciation).toBe(10_000)
  })
})
