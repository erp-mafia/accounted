/**
 * Opening accumulated depreciation ("Redan avskrivet per <datum>", desk
 * crm#104): an asset that arrives partly depreciated from a previous system.
 *
 * Covers the engine math (öre-exact), the validation rules, the disposal
 * plan and annual-report note figures that must count the opening amount,
 * and the create/update service paths.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  computeAnnualDepreciation,
  openingAccumulatedBefore,
  openingDepreciationOf,
} from '../depreciation-engine'
import {
  AssetOpeningDepreciationInvalidError,
  validateOpeningDepreciation,
} from '../opening-depreciation'
import {
  AssetCorrectionBlockedError,
  buildAssetDisposalPlan,
  createAsset,
  updateAsset,
} from '../asset-service'
import { computeAssetNoteFigures } from '@/lib/bokslut/arsredovisning/asset-note-figures'
import type { Asset } from '@/types'

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    user_id: 'user-1',
    company_id: 'co-1',
    name: 'Maskin',
    category: 'equipment',
    acquisition_date: '2022-01-01',
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
    opening_accumulated_depreciation: 0,
    opening_depreciation_date: null,
    notes: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

const year = (y: number) => ({ period_start: `${y}-01-01`, period_end: `${y}-12-31` })

/** Cost 100 000, 5 years from 2022-01-01, 3 years (60 000) written off in
 *  the previous system per 2024-12-31: exactly the original linear plan. */
const MIGRATED = {
  opening_accumulated_depreciation: 60_000,
  opening_depreciation_date: '2024-12-31',
}

describe('openingDepreciationOf / openingAccumulatedBefore', () => {
  it('returns null without an amount or without a date', () => {
    expect(openingDepreciationOf(makeAsset())).toBeNull()
    expect(
      openingDepreciationOf(makeAsset({ opening_accumulated_depreciation: 500, opening_depreciation_date: null })),
    ).toBeNull()
  })

  it('reads the NUMERIC string PostgREST returns', () => {
    expect(
      openingDepreciationOf(
        makeAsset({ opening_accumulated_depreciation: '60000.50', opening_depreciation_date: '2024-12-31' }),
      ),
    ).toEqual({ amount: 60_000.5, date: '2024-12-31' })
  })

  it('counts the opening amount only for periods starting after its date', () => {
    const asset = makeAsset(MIGRATED)
    expect(openingAccumulatedBefore(asset, '2025-01-01')).toBe(60_000)
    expect(openingAccumulatedBefore(asset, '2024-01-01')).toBe(0)
  })
})

describe('computeAnnualDepreciation with an opening balance', () => {
  it('reproduces the original linear plan when the previous system followed it', () => {
    const withOpening = makeAsset(MIGRATED)
    const withoutOpening = makeAsset()

    // Periods up to the opening date are already in the opening amount.
    expect(computeAnnualDepreciation(withOpening, year(2024)).amount).toBe(0)
    // 40 000 left over the remaining 24 months = 20 000 a year, the same
    // annual charge the original plan gives.
    expect(computeAnnualDepreciation(withOpening, year(2025)).amount).toBe(20_000)
    expect(computeAnnualDepreciation(withoutOpening, year(2025)).amount).toBe(20_000)
    expect(computeAnnualDepreciation(withOpening, year(2026), 20_000).amount).toBe(20_000)
    // Life over.
    expect(computeAnnualDepreciation(withOpening, year(2027), 40_000).amount).toBe(0)
  })

  it('continues from the actual book value over the remaining life when the opening differs from the plan', () => {
    // Previous system wrote off only 50 000 by 2024-12-31: the remaining
    // 50 000 goes over the remaining 24 months.
    const asset = makeAsset({ ...MIGRATED, opening_accumulated_depreciation: 50_000 })
    expect(computeAnnualDepreciation(asset, year(2025)).amount).toBe(25_000)
    expect(computeAnnualDepreciation(asset, year(2026), 25_000).amount).toBe(25_000)
  })

  it('is öre-exact: opening + every charge sums to the cost', () => {
    const asset = makeAsset({
      acquisition_date: '2023-01-01',
      acquisition_cost: 10_000.55,
      useful_life_months: 36,
      opening_accumulated_depreciation: 3_333.33,
      opening_depreciation_date: '2023-12-31',
    })
    const y2024 = computeAnnualDepreciation(asset, year(2024)).amount
    const y2025 = computeAnnualDepreciation(asset, year(2025), y2024).amount
    // Remaining 6 667.22 over 24 months: 3 333.61 a year, whole kronor for
    // the first year, the final year takes exactly what is left.
    expect(y2024).toBe(3_334)
    expect(y2025).toBe(3_333.22)
    expect(Math.round((3_333.33 + y2024 + y2025) * 100) / 100).toBe(10_000.55)
    expect(computeAnnualDepreciation(asset, year(2026), y2024 + y2025).amount).toBe(0)
  })

  it('pro-rates the period that contains a mid-year opening date', () => {
    // 6 000 written off per 2024-06-30; 54 000 over the remaining 54 months
    // = 12 000 a year; 2024-07-01..2024-12-31 is 184 of 366 days.
    const asset = makeAsset({
      acquisition_date: '2024-01-01',
      acquisition_cost: 60_000,
      useful_life_months: 60,
      opening_accumulated_depreciation: 6_000,
      opening_depreciation_date: '2024-06-30',
    })
    const result = computeAnnualDepreciation(asset, year(2024))
    expect(result.proRated).toBe(true)
    expect(result.amount).toBe(Math.round((12_000 * 184) / 366))
    expect(result.amount).toBe(6_033)
  })

  it('stops at the salvage value', () => {
    // 60 000 - 10 000 salvage - 20 000 opening = 30 000 over 36 months.
    const asset = makeAsset({
      acquisition_date: '2024-01-01',
      acquisition_cost: 60_000,
      salvage_value: 10_000,
      useful_life_months: 60,
      opening_accumulated_depreciation: 20_000,
      opening_depreciation_date: '2025-12-31',
    })
    expect(computeAnnualDepreciation(asset, year(2026)).amount).toBe(10_000)
    expect(computeAnnualDepreciation(asset, year(2028), 20_000).amount).toBe(10_000)
  })

  it('returns 0 for a fully depreciated opening or a life that already ended', () => {
    expect(
      computeAnnualDepreciation(
        makeAsset({ ...MIGRATED, opening_accumulated_depreciation: 100_000 }),
        year(2025),
      ).amount,
    ).toBe(0)
    expect(
      computeAnnualDepreciation(
        makeAsset({
          acquisition_date: '2015-01-01',
          opening_accumulated_depreciation: 90_000,
          opening_depreciation_date: '2024-12-31',
        }),
        year(2025),
      ).amount,
    ).toBe(0)
  })

  it('caps the charge at what is left after depreciation booked in Accounted', () => {
    const asset = makeAsset(MIGRATED)
    expect(computeAnnualDepreciation(asset, year(2025), 39_990).amount).toBe(10)
    expect(computeAnnualDepreciation(asset, year(2025), 40_000).amount).toBe(0)
  })
})

describe('buildAssetDisposalPlan with an opening balance', () => {
  it('clears the opening amount from 12x9 together with Accounted depreciation', () => {
    const asset = makeAsset(MIGRATED)
    const plan = buildAssetDisposalPlan({
      asset,
      input: {
        disposal_type: 'scrap',
        disposed_at: '2025-06-30',
        disposed_proceeds: 0,
        fiscal_period_id: 'p2025',
      },
      fiscalPeriod: { id: 'p2025', period_start: '2025-01-01', period_end: '2025-12-31' },
      periods: [{ id: 'p2025', period_start: '2025-01-01' }],
      schedules: [],
    })
    // 20 000 × 181/365 through the disposal date.
    expect(plan.currentDepreciation).toBe(9_918)
    expect(plan.accumulatedDepreciation).toBe(69_918)
    expect(plan.gainOrLoss).toBe(-30_082)
    expect(plan.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_number: '1229', debit_amount: 69_918 }),
        expect.objectContaining({ account_number: '1220', credit_amount: 100_000 }),
      ]),
    )
    const debit = plan.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const credit = plan.lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(Math.round(debit * 100) / 100).toBe(Math.round(credit * 100) / 100)
  })
})

describe('computeAssetNoteFigures with an opening balance', () => {
  it('puts the opening amount in the ingående ackumulerade avskrivningar', () => {
    const asset = makeAsset(MIGRATED)
    const figures = computeAssetNoteFigures({
      assets: [asset],
      postedSchedules: [],
      fiscalPeriods: [{ id: 'p2025', period_start: '2025-01-01', period_end: '2025-12-31' }],
      currentPeriodId: 'p2025',
    }).get(asset.id)
    expect(figures).toEqual({ ibAck: 60_000, aretsAvskrivning: 20_000, avgaendeAck: 0 })
  })

  it('adds posted Accounted depreciation on top of the opening amount', () => {
    const asset = makeAsset(MIGRATED)
    const figures = computeAssetNoteFigures({
      assets: [asset],
      postedSchedules: [
        { asset_id: asset.id, fiscal_period_id: 'p2025', planned_depreciation: '20000', journal_entry_id: 'je-1' },
      ],
      fiscalPeriods: [
        { id: 'p2025', period_start: '2025-01-01', period_end: '2025-12-31' },
        { id: 'p2026', period_start: '2026-01-01', period_end: '2026-12-31' },
      ],
      currentPeriodId: 'p2026',
    }).get(asset.id)
    expect(figures).toEqual({ ibAck: 80_000, aretsAvskrivning: 20_000, avgaendeAck: 0 })
  })
})

describe('validateOpeningDepreciation', () => {
  const base = { acquisition_cost: 100_000, acquisition_date: '2022-01-01' }
  const TODAY = '2026-09-22'
  const kinds = (value: Parameters<typeof validateOpeningDepreciation>[0]) =>
    validateOpeningDepreciation(value, TODAY).map((issue) => issue.kind)

  it('accepts no opening, a valid pair, and an amount equal to the cost', () => {
    expect(kinds(base)).toEqual([])
    expect(kinds({ ...base, ...MIGRATED })).toEqual([])
    expect(kinds({ ...base, opening_accumulated_depreciation: 100_000, opening_depreciation_date: TODAY })).toEqual([])
  })

  it('refuses a negative amount and one above the cost', () => {
    expect(kinds({ ...base, opening_accumulated_depreciation: -0.01, opening_depreciation_date: '2024-12-31' })).toEqual(['negative'])
    expect(kinds({ ...base, opening_accumulated_depreciation: 100_000.01, opening_depreciation_date: '2024-12-31' })).toEqual(['exceeds_cost'])
  })

  it('requires a date that is not after today nor before the acquisition', () => {
    expect(kinds({ ...base, opening_accumulated_depreciation: 1_000 })).toEqual(['date_required'])
    expect(kinds({ ...base, opening_accumulated_depreciation: 1_000, opening_depreciation_date: '2026-09-23' })).toEqual(['date_future'])
    expect(kinds({ ...base, opening_accumulated_depreciation: 1_000, opening_depreciation_date: '2021-12-31' })).toEqual(['date_before_acquisition'])
  })

  it('refuses the combination with K3 components', () => {
    expect(
      kinds({
        ...base,
        ...MIGRATED,
        k3_components: [{ name: 'Stomme', cost: 100_000, useful_life_months: 60 }],
      }),
    ).toEqual(['components'])
  })
})

// ── Service paths ────────────────────────────────────────────────

type Captured = { insert: Record<string, unknown> | null; update: Record<string, unknown> | null; tables: string[] }

function mockSupabase(asset: Asset | null, opts: { postedCount?: number } = {}) {
  const captured: Captured = { insert: null, update: null, tables: [] }
  const supabase = {
    from: vi.fn((table: string) => {
      captured.tables.push(table)
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'neq', 'not', 'gt', 'in', 'order', 'range']) {
        chain[m] = vi.fn(() => chain)
      }
      if (table === 'companies') {
        chain.single = vi.fn(async () => ({ data: { accounting_framework: 'k2' }, error: null }))
        return chain
      }
      if (table !== 'assets') {
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({ data: [], count: opts.postedCount ?? 0, error: null })
        return chain
      }
      chain.maybeSingle = vi.fn(async () => ({ data: asset, error: null }))
      chain.insert = vi.fn((payload: Record<string, unknown>) => {
        captured.insert = payload
        return chain
      })
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        captured.update = payload
        return chain
      })
      chain.single = vi.fn(async () => ({
        data: { ...(asset ?? {}), ...(captured.insert ?? {}), ...(captured.update ?? {}) },
        error: null,
      }))
      return chain
    }),
  }
  return { supabase: supabase as unknown as Parameters<typeof updateAsset>[0], captured }
}

describe('createAsset with an opening balance', () => {
  const input = {
    name: 'Maskin',
    category: 'equipment' as const,
    acquisition_date: '2022-01-01',
    acquisition_cost: 100_000,
    useful_life_months: 60,
  }

  it('stores the öre-rounded pair and writes no journal entry', async () => {
    const { supabase, captured } = mockSupabase(null)
    await createAsset(supabase, 'co', 'user-1', {
      ...input,
      opening_accumulated_depreciation: 60_000.004,
      opening_depreciation_date: '2024-12-31',
    })
    expect(captured.insert).toMatchObject({
      opening_accumulated_depreciation: 60_000,
      opening_depreciation_date: '2024-12-31',
    })
    expect(captured.tables).not.toContain('journal_entries')
    expect(captured.tables).not.toContain('journal_entry_lines')
  })

  it('stores (0, null) when no opening is given', async () => {
    const { supabase, captured } = mockSupabase(null)
    await createAsset(supabase, 'co', 'user-1', { ...input, opening_depreciation_date: '2024-12-31' })
    expect(captured.insert).toMatchObject({
      opening_accumulated_depreciation: 0,
      opening_depreciation_date: null,
    })
  })
})

describe('updateAsset with an opening balance', () => {
  it('sets the opening pair while nothing is posted, without the ledger scan', async () => {
    const { supabase, captured } = mockSupabase(makeAsset(), { postedCount: 0 })
    await updateAsset(supabase, 'co', 'asset-1', {
      opening_accumulated_depreciation: 60_000,
      opening_depreciation_date: '2024-12-31',
    })
    expect(captured.update).toMatchObject({
      opening_accumulated_depreciation: 60_000,
      opening_depreciation_date: '2024-12-31',
    })
    // Previous-system depreciation already sits on 12x9 in the imported
    // ledger: a credit there must not lock the opening field.
    expect(captured.tables).not.toContain('journal_entry_lines')
  })

  it('clears the date when the amount is set to 0', async () => {
    const { supabase, captured } = mockSupabase(makeAsset(MIGRATED))
    await updateAsset(supabase, 'co', 'asset-1', { opening_accumulated_depreciation: 0 })
    expect(captured.update).toMatchObject({
      opening_accumulated_depreciation: 0,
      opening_depreciation_date: null,
    })
  })

  it('refuses a change once Accounted has posted depreciation (409 path)', async () => {
    const { supabase, captured } = mockSupabase(makeAsset(), { postedCount: 1 })
    await expect(
      updateAsset(supabase, 'co', 'asset-1', {
        opening_accumulated_depreciation: 60_000,
        opening_depreciation_date: '2024-12-31',
      }),
    ).rejects.toBeInstanceOf(AssetCorrectionBlockedError)
    expect(captured.update).toBeNull()
  })

  it('refuses an amount above the cost (400 path)', async () => {
    const { supabase, captured } = mockSupabase(makeAsset())
    await expect(
      updateAsset(supabase, 'co', 'asset-1', {
        opening_accumulated_depreciation: 100_000.01,
        opening_depreciation_date: '2024-12-31',
      }),
    ).rejects.toBeInstanceOf(AssetOpeningDepreciationInvalidError)
    expect(captured.update).toBeNull()
  })

  it('refuses lowering the cost below a stored opening amount', async () => {
    const { supabase, captured } = mockSupabase(makeAsset(MIGRATED))
    await expect(
      updateAsset(supabase, 'co', 'asset-1', { acquisition_cost: 50_000 }),
    ).rejects.toBeInstanceOf(AssetOpeningDepreciationInvalidError)
    expect(captured.update).toBeNull()
  })

  it('refuses adding K3 components to an asset carrying an opening amount', async () => {
    const { supabase } = mockSupabase(makeAsset(MIGRATED))
    await expect(
      updateAsset(supabase, 'co', 'asset-1', {
        k3_components: [{ name: 'Stomme', cost: 100_000, useful_life_months: 60 }],
      }),
    ).rejects.toBeInstanceOf(AssetOpeningDepreciationInvalidError)
  })
})
