import { describe, it, expect } from 'vitest'
import {
  computeAssetNoteFigures,
  type PostedScheduleRow,
  type PeriodLike,
} from '../asset-note-figures'
import type { Asset } from '@/types'

const FP2023: PeriodLike = { id: 'fp2023', period_start: '2023-01-01', period_end: '2023-12-31' }
const FP2024: PeriodLike = { id: 'fp2024', period_start: '2024-01-01', period_end: '2024-12-31' }
const FP2025: PeriodLike = { id: 'fp2025', period_start: '2025-01-01', period_end: '2025-12-31' }
const ALL_PERIODS = [FP2023, FP2024, FP2025]

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    user_id: 'user-1',
    company_id: 'company-1',
    name: 'Testinventarie',
    category: 'equipment',
    acquisition_date: '2024-01-01',
    acquisition_cost: 146_000,
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
  } as Asset
}

function posted(
  assetId: string,
  periodId: string,
  amount: number | string,
): PostedScheduleRow {
  return {
    asset_id: assetId,
    fiscal_period_id: periodId,
    planned_depreciation: amount,
    journal_entry_id: `je-${assetId}-${periodId}`,
  }
}

function figuresFor(
  asset: Asset,
  schedules: PostedScheduleRow[],
  periods: PeriodLike[] = ALL_PERIODS,
  currentPeriodId = 'fp2025',
) {
  const map = computeAssetNoteFigures({
    assets: [asset],
    postedSchedules: schedules,
    fiscalPeriods: periods,
    currentPeriodId,
  })
  return map.get(asset.id)
}

describe('computeAssetNoteFigures', () => {
  it('uses posted schedule amounts verbatim (regression: 20 kr note drift)', () => {
    // 146,000 kr over 60 months books round(146000 * 12/60) = 29,200/year.
    // The old theoretical formula (base * 365 / (60 * 30.4375)) gave 29,180:
    // the exact 20 kr inconsistency reported against the ledger-driven RR/BR.
    const asset = makeAsset()
    const f = figuresFor(asset, [
      posted('asset-1', 'fp2024', 29_200),
      posted('asset-1', 'fp2025', 29_200),
    ])
    expect(f).toEqual({ ibAck: 29_200, aretsAvskrivning: 29_200, avgaendeAck: 0 })
  })

  it('falls back to the booking engine for the current year when nothing is posted', () => {
    const asset = makeAsset()
    const f = figuresFor(asset, [posted('asset-1', 'fp2024', 29_200)])
    // Engine full-year linear: round(146000 * 12/60) = 29,200, not 29,180.
    expect(f).toEqual({ ibAck: 29_200, aretsAvskrivning: 29_200, avgaendeAck: 0 })
  })

  it('iterates synthetic prior years through the engine for pre-onboarding assets', () => {
    // Acquired 2023-01-01 but only the current fiscal period exists in the
    // DB and nothing was ever posted: two synthetic 12-month windows.
    const asset = makeAsset({ acquisition_date: '2023-01-01' })
    const f = figuresFor(asset, [], [FP2025])
    expect(f).toEqual({ ibAck: 58_400, aretsAvskrivning: 29_200, avgaendeAck: 0 })
  })

  it('caps the engine-iterated fallback at the depreciable base after useful life', () => {
    const asset = makeAsset({ acquisition_date: '2010-01-01' })
    const f = figuresFor(asset, [], [FP2025])
    expect(f).toEqual({ ibAck: 146_000, aretsAvskrivning: 0, avgaendeAck: 0 })
  })

  it('sums K3 component depreciation via the engine fallback', () => {
    const asset = makeAsset({
      acquisition_date: '2025-01-01',
      acquisition_cost: 100_000,
      k3_components: [
        { name: 'Stomme', cost: 80_000, useful_life_months: 120 },
        { name: 'Tak', cost: 20_000, useful_life_months: 60, salvage_value: 0 },
      ],
    })
    const f = figuresFor(asset, [])
    // round(80000 * 12/120) + round(20000 * 12/60) = 8,000 + 4,000
    expect(f).toEqual({ ibAck: 0, aretsAvskrivning: 12_000, avgaendeAck: 0 })
  })

  it('ignores draft schedules (journal_entry_id null) everywhere', () => {
    const asset = makeAsset()
    const drafts: PostedScheduleRow[] = [
      { asset_id: 'asset-1', fiscal_period_id: 'fp2024', planned_depreciation: 999, journal_entry_id: null },
      { asset_id: 'asset-1', fiscal_period_id: 'fp2025', planned_depreciation: 999, journal_entry_id: null },
    ]
    const f = figuresFor(asset, drafts)
    // Both fall back to the engine: 2024 via prior-year iteration, 2025 live.
    expect(f).toEqual({ ibAck: 29_200, aretsAvskrivning: 29_200, avgaendeAck: 0 })
  })

  it('mirrors disposeAsset for in-period disposals: all posted rows reversed, nothing new charged', () => {
    const asset = makeAsset({
      acquisition_date: '2023-01-01',
      disposed_at: '2025-06-30',
      disposed_proceeds: 10_000,
    })
    const f = figuresFor(asset, [
      posted('asset-1', 'fp2023', 29_200),
      posted('asset-1', 'fp2024', 29_200),
    ])
    // disposeAsset reversed sumPostedDepreciation() = 58,400; no current-year
    // charge was ever booked, so the note must not invent one.
    expect(f).toEqual({ ibAck: 58_400, aretsAvskrivning: 0, avgaendeAck: 58_400 })
  })

  it('includes a posted current-year row in the disposal reversal so the asset nets to zero', () => {
    const asset = makeAsset({
      acquisition_date: '2023-01-01',
      disposed_at: '2025-06-30',
      disposed_proceeds: 10_000,
    })
    const f = figuresFor(asset, [
      posted('asset-1', 'fp2023', 29_200),
      posted('asset-1', 'fp2024', 29_200),
      posted('asset-1', 'fp2025', 29_200),
    ])
    expect(f).toEqual({ ibAck: 58_400, aretsAvskrivning: 29_200, avgaendeAck: 87_600 })
    expect(f!.ibAck + f!.aretsAvskrivning - f!.avgaendeAck).toBe(0)
  })

  it('previews engine amounts for disposals with no posted schedules at all', () => {
    const asset = makeAsset({
      acquisition_date: '2023-01-01',
      disposed_at: '2025-06-30',
      disposed_proceeds: 10_000,
    })
    const f = figuresFor(asset, [])
    // Fallback ibAck = 2 full engine years = 58,400. Current year clamps at
    // the disposal date: round(29200 * 181/365) = 14,480. The reversal takes
    // the asset's accumulated depreciation back to zero.
    expect(f).toEqual({ ibAck: 58_400, aretsAvskrivning: 14_480, avgaendeAck: 72_880 })
  })

  it('coerces NUMERIC string amounts from PostgREST', () => {
    const asset = makeAsset()
    const f = figuresFor(asset, [
      posted('asset-1', 'fp2024', '29200.00'),
      posted('asset-1', 'fp2025', '29200.00'),
    ])
    expect(f).toEqual({ ibAck: 29_200, aretsAvskrivning: 29_200, avgaendeAck: 0 })
  })

  it('omits assets disposed before the period', () => {
    const asset = makeAsset({
      acquisition_date: '2023-01-01',
      disposed_at: '2024-12-31',
      disposed_proceeds: 0,
    })
    const map = computeAssetNoteFigures({
      assets: [asset],
      postedSchedules: [],
      fiscalPeriods: ALL_PERIODS,
      currentPeriodId: 'fp2025',
    })
    expect(map.has('asset-1')).toBe(false)
  })

  it('throws when the current period is missing from the period list', () => {
    expect(() =>
      computeAssetNoteFigures({
        assets: [makeAsset()],
        postedSchedules: [],
        fiscalPeriods: [FP2024],
        currentPeriodId: 'fp2025',
      }),
    ).toThrow('Current fiscal period not found')
  })
})
