import { describe, expect, it } from 'vitest'
import { buildAssetDisposalPlan, type DisposeAssetInput } from '../asset-service'
import type { Asset, AssetCategory } from '@/types'

const PERIOD = { id: 'period-2026', period_start: '2026-01-01', period_end: '2026-12-31' }
const PERIODS = [
  { id: 'period-2025', period_start: '2025-01-01' },
  { id: 'period-2026', period_start: '2026-01-01' },
  { id: 'period-2027', period_start: '2027-01-01' },
]

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    user_id: 'user-1',
    company_id: 'company-1',
    name: 'Machine',
    category: 'equipment',
    acquisition_date: '2025-01-01',
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
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeInput(overrides: Partial<DisposeAssetInput> = {}): DisposeAssetInput {
  return {
    disposal_type: 'sale',
    disposed_at: '2026-06-30',
    disposed_proceeds: 100_000,
    proceeds_account: '1930',
    fiscal_period_id: PERIOD.id,
    vat_treatment: 'standard_25',
    ...overrides,
  }
}

function build(overrides: {
  asset?: Partial<Asset>
  input?: Partial<DisposeAssetInput>
  schedules?: Array<{
    fiscal_period_id: string
    planned_depreciation: number
    journal_entry_id: string | null
  }>
} = {}) {
  return buildAssetDisposalPlan({
    asset: makeAsset(overrides.asset),
    input: makeInput(overrides.input),
    fiscalPeriod: PERIOD,
    periods: PERIODS,
    schedules: overrides.schedules ?? [
      {
        fiscal_period_id: 'period-2025',
        planned_depreciation: 20_000,
        journal_entry_id: 'entry-2025',
      },
    ],
  })
}

describe('buildAssetDisposalPlan', () => {
  it('books depreciation through the disposal date before removing the asset', () => {
    const plan = build()

    expect(plan.currentDepreciation).toBe(9_918)
    expect(plan.accumulatedDepreciation).toBe(29_918)
    expect(plan.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_number: '7832', debit_amount: 9_918 }),
        expect.objectContaining({ account_number: '1229', credit_amount: 9_918 }),
        expect.objectContaining({ account_number: '1229', debit_amount: 29_918 }),
        expect.objectContaining({ account_number: '1220', credit_amount: 100_000 }),
      ]),
    )
  })

  it('derives 25 percent output VAT from gross proceeds on the server', () => {
    const plan = build({ input: { disposed_proceeds: 125_000 } })

    expect(plan.proceedsVat).toBe(25_000)
    expect(plan.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_number: '1930', debit_amount: 125_000 }),
        expect.objectContaining({ account_number: '2611', credit_amount: 25_000 }),
      ]),
    )
  })

  it.each<[AssetCategory, string, string]>([
    ['immaterial', '3971', '7971'],
    ['building', '3972', '7972'],
    ['land_improvement', '3972', '7972'],
    ['equipment', '3973', '7973'],
  ])('uses the BAS disposal pair for %s', (category, gainAccount, lossAccount) => {
    const accountOverrides =
      category === 'immaterial'
        ? { bas_asset_account: '1010', bas_accumulated_account: '1019', bas_expense_account: '7810' }
        : category === 'building' || category === 'land_improvement'
          ? { bas_asset_account: '1110', bas_accumulated_account: '1119', bas_expense_account: '7821' }
          : {}
    const gain = build({
      asset: { category, acquisition_cost: 20_000, ...accountOverrides },
      input: { disposed_proceeds: 125_000 },
      schedules: [],
    })
    const loss = build({
      asset: { category, acquisition_cost: 100_000, ...accountOverrides },
      input: { disposal_type: 'scrap', disposed_proceeds: 0, vat_treatment: undefined },
      schedules: [],
    })

    expect(gain.lines.some((line) => line.account_number === gainAccount)).toBe(true)
    expect(loss.lines.some((line) => line.account_number === lossAccount)).toBe(true)
  })

  it('fully clears a fully depreciated asset on scrapping', () => {
    const plan = build({
      asset: { acquisition_date: '2021-01-01' },
      input: { disposal_type: 'scrap', disposed_proceeds: 0, vat_treatment: undefined },
      schedules: [
        { fiscal_period_id: 'period-2025', planned_depreciation: 100_000, journal_entry_id: 'entry' },
      ],
    })

    expect(plan.gainOrLoss).toBe(0)
    expect(plan.lines).toEqual([
      expect.objectContaining({ account_number: '1229', debit_amount: 100_000 }),
      expect.objectContaining({ account_number: '1220', credit_amount: 100_000 }),
    ])
  })

  it('refuses disposal when a later period already has posted depreciation', () => {
    expect(() =>
      build({
        schedules: [
          { fiscal_period_id: 'period-2027', planned_depreciation: 20_000, journal_entry_id: 'entry' },
        ],
      }),
    ).toThrow('later_depreciation_posted')
  })

  it('refuses to overwrite a mismatched posted current-period schedule', () => {
    expect(() =>
      build({
        schedules: [
          { fiscal_period_id: 'period-2026', planned_depreciation: 20_000, journal_entry_id: 'entry' },
        ],
      }),
    ).toThrow('current_depreciation_mismatch')
  })

  it('books negative VAT adjustment to 6999 and 2641', () => {
    const plan = build({
      asset: { acquisition_cost: 300_000 },
      input: {
        vat_treatment: 'exempt',
        jamkning_original_input_vat: 75_000,
        jamkning_original_deduction_percent: 100,
      },
    })

    expect(plan.jamkning).toMatchObject({ direction: 'decrease', amount: 60_000 })
    expect(plan.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_number: '6999', debit_amount: 60_000 }),
        expect.objectContaining({ account_number: '2641', credit_amount: 60_000 }),
      ]),
    )
  })

  it('requires explicit ML 5:38 confirmation for a business transfer', () => {
    expect(() =>
      build({
        input: {
          disposal_type: 'business_transfer',
          vat_treatment: undefined,
        },
      }),
    ).toThrow('ASSET_BUSINESS_TRANSFER_CONFIRMATION_REQUIRED')
  })

  it('requires an adjustment document when an investment-good obligation transfers', () => {
    expect(() =>
      build({
        asset: { acquisition_cost: 300_000 },
        input: {
          disposal_type: 'business_transfer',
          vat_treatment: undefined,
          business_transfer_confirmed: true,
          jamkning_original_input_vat: 50_000,
          jamkning_original_deduction_percent: 100,
        },
      }),
    ).toThrow('ASSET_ADJUSTMENT_DOCUMENT_REQUIRED')

    const plan = build({
      asset: { acquisition_cost: 300_000 },
      input: {
        disposal_type: 'business_transfer',
        vat_treatment: undefined,
        business_transfer_confirmed: true,
        adjustment_document_confirmed: true,
        jamkning_original_input_vat: 50_000,
        jamkning_original_deduction_percent: 100,
      },
    })
    expect(plan.jamkning.direction).toBe('transferred')
  })
})
