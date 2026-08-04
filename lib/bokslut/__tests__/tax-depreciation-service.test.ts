import { describe, expect, it } from 'vitest'
import type { Asset } from '@/types'
import {
  buildTaxDepreciationPopulation,
  findImmediatePreviousTaxPeriod,
  resolveTaxDepreciationOpening,
  taxDepreciationSnapshotMatches,
  type TaxDepreciationSnapshot,
} from '../assets/tax-depreciation-service'
import { computeTaxDepreciation } from '../assets/tax-depreciation'

function asset(overrides: Partial<Asset>): Asset {
  return {
    id: 'asset-1',
    user_id: 'user-1',
    company_id: 'company-1',
    name: 'Asset',
    category: 'equipment',
    acquisition_date: '2024-01-01',
    acquisition_cost: 100_000,
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
    notes: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

function period(
  id: string,
  name: string,
  periodStart: string,
  periodEnd: string,
) {
  return {
    id,
    name,
    period_start: periodStart,
    period_end: periodEnd,
    previous_period_id: null,
    is_closed: false,
    locked_at: null,
    closing_entry_id: null,
    tax_depreciation_method: null,
    tax_depreciation_rule: null,
    tax_depreciation_opening_value: null,
    tax_depreciation_base: null,
    tax_depreciation_deduction: null,
    tax_depreciation_closing_value: null,
    tax_depreciation_calculation: null,
  }
}

describe('buildTaxDepreciationPopulation', () => {
  it('builds a company pool with net prior-year disposals and fiscal-year cohorts', () => {
    const periods = [
      period('period-2024', '2024', '2024-01-01', '2024-12-31'),
      period('period-2025', '2025', '2025-01-01', '2025-12-31'),
    ]
    const population = buildTaxDepreciationPopulation(
      [
        asset({ id: 'prior-held' }),
        asset({
          id: 'current-held',
          category: 'computer',
          acquisition_date: '2025-11-01',
          acquisition_cost: 50_000,
        }),
        asset({
          id: 'prior-sold',
          category: 'vehicle',
          disposed_at: '2025-06-30',
          disposed_proceeds: 125_000,
          disposed_proceeds_vat: 25_000,
        }),
        asset({
          id: 'current-sold',
          acquisition_date: '2025-02-01',
          acquisition_cost: 30_000,
          disposed_at: '2025-10-01',
          disposed_proceeds: 40_000,
        }),
        asset({
          id: 'building',
          category: 'building',
          acquisition_cost: 200_000,
        }),
      ],
      periods[1],
      periods,
      1,
    )

    expect(population.additions).toBe(50_000)
    expect(population.disposals).toBe(100_000)
    expect(population.periodMonths).toBe(12)
    expect(population.eligibleAssetCount).toBe(2)
    expect(population.excludedAssetCount).toBe(1)
    expect(population.excludedCategories).toEqual(['building'])
    expect(population.cohortHistoryComplete).toBe(true)
    expect(population.incompleteCohortCount).toBe(0)
    expect(population.cohorts).toEqual([
      { label: '2025', acquisitionCost: 50_000, elapsedMonths: 12 },
      { label: '2024', acquisitionCost: 100_000, elapsedMonths: 24 },
    ])
  })
})

describe('findImmediatePreviousTaxPeriod', () => {
  it('does not skip an unsaved immediate period to reuse an older saved snapshot', () => {
    const saved2024 = {
      ...period('period-2024', '2024', '2024-01-01', '2024-12-31'),
      tax_depreciation_method: 'rakenskapsenlig' as const,
      tax_depreciation_rule: 'huvudregel_30' as const,
      tax_depreciation_opening_value: 100_000,
      tax_depreciation_base: 100_000,
      tax_depreciation_deduction: 30_000,
      tax_depreciation_closing_value: 70_000,
    }
    const unsaved2025 = period('period-2025', '2025', '2025-01-01', '2025-12-31')
    const current2026 = {
      ...period('period-2026', '2026', '2026-01-01', '2026-12-31'),
      previous_period_id: 'period-2025',
    }

    expect(findImmediatePreviousTaxPeriod(current2026, [saved2024, unsaved2025, current2026]))
      .toBe(unsaved2025)
  })

  it('uses only a date-adjacent fallback when the explicit chain is missing', () => {
    const distant = period('period-2024', '2024', '2024-01-01', '2024-12-31')
    const adjacent = period('period-2025', '2025', '2025-01-01', '2025-12-31')
    const current = period('period-2026', '2026', '2026-01-01', '2026-12-31')

    expect(findImmediatePreviousTaxPeriod(current, [distant, adjacent, current])).toBe(adjacent)
    expect(findImmediatePreviousTaxPeriod(current, [distant, current])).toBeNull()
  })

  it('rejects a non-adjacent explicit predecessor link', () => {
    const distant = period('period-2024', '2024', '2024-01-01', '2024-12-31')
    const current = {
      ...period('period-2026', '2026', '2026-01-01', '2026-12-31'),
      previous_period_id: distant.id,
    }

    expect(findImmediatePreviousTaxPeriod(current, [distant, current])).toBeNull()
  })
})

describe('complementary-rule cohort history', () => {
  it('does not invent elapsed months when an acquisition period is missing', () => {
    const current = period('period-2026', '2026', '2026-01-01', '2026-12-31')
    const population = buildTaxDepreciationPopulation(
      [asset({ acquisition_date: '2024-06-01' })],
      current,
      [current],
      0,
    )

    expect(population.cohorts).toEqual([])
    expect(population.cohortHistoryComplete).toBe(false)
    expect(population.incompleteCohortCount).toBe(1)
  })
})

describe('tax depreciation opening continuity', () => {
  const currentSnapshot: TaxDepreciationSnapshot = {
    method: 'rakenskapsenlig',
    selectedRule: 'huvudregel_30',
    openingTaxValue: 70_000,
    basis: 70_000,
    deduction: 20_000,
    closingTaxValue: 50_000,
    calculation: null,
  }

  it('keeps the immediate previous closing authoritative after the current year is saved', () => {
    const previousSnapshot = {
      ...currentSnapshot,
      openingTaxValue: 100_000,
      basis: 100_000,
      deduction: 30_000,
      closingTaxValue: 70_000,
    }

    expect(resolveTaxDepreciationOpening(currentSnapshot, previousSnapshot, true)).toEqual({
      value: 70_000,
      source: 'previous_period',
    })
  })

  it('marks a saved successor stale when the previous closing value changes', () => {
    const changedPrevious = { ...currentSnapshot, closingTaxValue: 65_000 }
    const opening = resolveTaxDepreciationOpening(currentSnapshot, changedPrevious, true)
    expect(opening.value).toBe(65_000)

    const staleInput = {
      method: 'rakenskapsenlig' as const,
      selectedRule: 'huvudregel_30' as const,
      openingTaxValue: opening.value ?? 0,
      additions: 0,
      disposals: 0,
      periodMonths: 12,
      cohorts: [],
    }
    // The saved 20 000 kr election now exceeds the statutory maximum
    // (30% of 65 000 = 19 500), so recomputing with it must reject...
    expect(() =>
      computeTaxDepreciation({ ...staleInput, electedDeduction: currentSnapshot.deduction }),
    ).toThrow(/electedDeduction/)
    // ...and the statutory recomputation no longer matches the snapshot,
    // which is what flags it as stale in the view.
    const recomputed = computeTaxDepreciation(staleInput)
    expect(taxDepreciationSnapshotMatches(currentSnapshot, recomputed)).toBe(false)
  })

  it('blocks a saved current year when its immediate predecessor has no snapshot', () => {
    expect(resolveTaxDepreciationOpening(currentSnapshot, null, true)).toEqual({
      value: null,
      source: 'previous_period_required',
    })
  })
})
