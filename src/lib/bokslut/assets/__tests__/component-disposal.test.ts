import { describe, expect, it } from 'vitest'
import { buildAssetDisposalPlan } from '../asset-service'
import type { Asset, AssetComponent } from '@/types'

/**
 * Disposal of a K3 component asset (K3 17.21-17.22): every active component's
 * accumulated depreciation leaves the books, its opening from a previous
 * system or the K3 split included, plus the year's charge to the disposal
 * date per component; a component replaced earlier left with its own
 * voucher and is not cleared again. Before the register, disposal cleared
 * only the asset-level opening and the posted totals (gap A5).
 */

const P2025 = { id: 'fp-2025', period_start: '2025-01-01', period_end: '2025-12-31' }
const P2026 = { id: 'fp-2026', period_start: '2026-01-01', period_end: '2026-12-31' }

function component(overrides: Partial<AssetComponent>): AssetComponent {
  return {
    id: 'tak',
    user_id: 'u',
    company_id: 'co',
    asset_id: 'a',
    name: 'Tak',
    cost: '200000.00',
    useful_life_months: 300,
    salvage_value: '0.00',
    acquisition_date: '2020-01-01',
    depreciation_start_date: null,
    opening_accumulated_depreciation: '40000.00',
    opening_depreciation_date: '2024-12-31',
    replaces_component_id: null,
    derecognised_at: null,
    derecognition_journal_entry_id: null,
    derecognition_depreciation: '0.00',
    sort_order: 0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

function asset(components: AssetComponent[]): Asset {
  return {
    id: 'a',
    name: 'Fastighet',
    category: 'building',
    acquisition_date: '2020-01-01',
    acquisition_cost: 1_000_000,
    salvage_value: 0,
    useful_life_months: 600,
    bas_asset_account: '1110',
    bas_accumulated_account: '1119',
    bas_expense_account: '7821',
    // The asset-level opening is the components' projection: never read here.
    opening_accumulated_depreciation: 80_000,
    opening_depreciation_date: '2024-12-31',
    disposed_at: null,
    k3_components: null,
    components,
  } as Asset
}

describe('buildAssetDisposalPlan for a component asset', () => {
  it('clears each component\'s opening, posted split and the charge to the disposal date', () => {
    const plan = buildAssetDisposalPlan({
      asset: asset([
        component({}),
        component({ id: 'stomme', name: 'Stomme', cost: '800000.00', useful_life_months: 1200, sort_order: 1 }),
      ]),
      input: { disposal_type: 'scrap', disposed_at: '2026-06-30', disposed_proceeds: 0, fiscal_period_id: 'fp-2026', jamkning_original_input_vat: 0, jamkning_original_deduction_percent: 0 },
      fiscalPeriod: P2026,
      periods: [P2025, P2026],
      schedules: [{ id: 's-2025', fiscal_period_id: 'fp-2025', planned_depreciation: 15_000, journal_entry_id: 'je-2025' }],
      componentSplits: [
        { schedule_id: 's-2025', component_id: 'tak', amount: 8_000 },
        { schedule_id: 's-2025', component_id: 'stomme', amount: 7_000 },
      ],
    })
    // Tak: 160 000 left over 2025-2044 once 2025 is posted (8 000), 152 000 over
    // 228 months from 2026-01-01; Stomme: 800 000 - 40 000 - 7 000 over 1 128.
    expect(plan.components?.map((c) => c.component_id)).toEqual(['tak', 'stomme'])
    const charge = plan.components!.reduce((s, c) => s + c.amount, 0)
    expect(plan.currentDepreciation).toBe(charge)
    expect(plan.accumulatedDepreciation).toBe(40_000 + 8_000 + 40_000 + 7_000 + charge)
    expect(plan.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_number: '1110', credit_amount: 1_000_000 }),
        expect.objectContaining({ account_number: '1119', debit_amount: plan.accumulatedDepreciation }),
      ]),
    )
    expect(plan.gainOrLoss).toBe(-(1_000_000 - plan.accumulatedDepreciation))
  })

  it('does not clear a component replaced earlier', () => {
    const plan = buildAssetDisposalPlan({
      asset: asset([
        component({ derecognised_at: '2025-06-30', derecognition_journal_entry_id: 'je-r' }),
        component({ id: 'nytt', name: 'Nytt tak', opening_accumulated_depreciation: '0.00', opening_depreciation_date: null, acquisition_date: '2025-06-30', replaces_component_id: 'tak' }),
      ]),
      input: { disposal_type: 'scrap', disposed_at: '2026-01-01', disposed_proceeds: 0, fiscal_period_id: 'fp-2026', jamkning_original_input_vat: 0, jamkning_original_deduction_percent: 0 },
      fiscalPeriod: P2026,
      periods: [P2025, P2026],
      schedules: [{ id: 's-2025', fiscal_period_id: 'fp-2025', planned_depreciation: 4_000, journal_entry_id: 'je-2025' }],
      componentSplits: [{ schedule_id: 's-2025', component_id: 'nytt', amount: 4_000 }],
    })
    expect(plan.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ account_number: '1110', credit_amount: 200_000 })]),
    )
    expect(plan.accumulatedDepreciation).toBe(4_000 + plan.currentDepreciation)
  })
})
