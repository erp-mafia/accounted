import { describe, it, expect, vi } from 'vitest'
import {
  AssetCorrectionBlockedError,
  DEFAULT_ACCOUNTS_BY_CATEGORY,
  disposeAsset,
  updateAsset,
} from '../assets/asset-service'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import type { Asset } from '@/types'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({
    id: 'entry-1',
    voucher_series: 'A',
    voucher_number: 1,
  }),
}))

describe('DEFAULT_ACCOUNTS_BY_CATEGORY', () => {
  it('maps every AssetCategory to a BAS-aligned account triple', () => {
    const expected = {
      immaterial: { asset: '1010', accumulated: '1019', expense: '7810' },
      building: { asset: '1110', accumulated: '1119', expense: '7821' },
      land_improvement: { asset: '1150', accumulated: '1159', expense: '7824' },
      machinery: { asset: '1210', accumulated: '1219', expense: '7831' },
      equipment: { asset: '1220', accumulated: '1229', expense: '7832' },
      vehicle: { asset: '1240', accumulated: '1249', expense: '7832' },
      computer: { asset: '1250', accumulated: '1259', expense: '7832' },
      other_tangible: { asset: '1290', accumulated: '1299', expense: '7839' },
    } as const
    expect(DEFAULT_ACCOUNTS_BY_CATEGORY).toEqual(expected)
  })

  it('uses the convention that accumulated = asset + 9 for tangible categories', () => {
    const tangible = ['machinery', 'equipment', 'vehicle', 'computer', 'other_tangible'] as const
    for (const cat of tangible) {
      const triple = DEFAULT_ACCOUNTS_BY_CATEGORY[cat]
      const assetNum = parseInt(triple.asset, 10)
      const accumulatedNum = parseInt(triple.accumulated, 10)
      expect(accumulatedNum).toBe(assetNum + 9)
    }
  })

  it('expense accounts are in the 78xx range (planenliga avskrivningar)', () => {
    for (const cat of Object.keys(DEFAULT_ACCOUNTS_BY_CATEGORY) as Array<
      keyof typeof DEFAULT_ACCOUNTS_BY_CATEGORY
    >) {
      const expense = DEFAULT_ACCOUNTS_BY_CATEGORY[cat].expense
      expect(expense).toMatch(/^78\d{2}$/)
    }
  })

  // Regression guard for #755: 7833/7834 were referenced here but absent from
  // the BAS reference, so backfillStandardBASAccounts could not seed them and
  // annual depreciation threw AccountsNotInChartError. Every account in the
  // triple must resolve in BAS_REFERENCE: otherwise the lazy backfill silently
  // can't add it and the depreciation posting fails on minimal charts.
  it('every account in the triple exists in the BAS reference (backfillable)', () => {
    for (const cat of Object.keys(DEFAULT_ACCOUNTS_BY_CATEGORY) as Array<
      keyof typeof DEFAULT_ACCOUNTS_BY_CATEGORY
    >) {
      const { asset, accumulated, expense } = DEFAULT_ACCOUNTS_BY_CATEGORY[cat]
      for (const account of [asset, accumulated, expense]) {
        expect(getBASReference(account), `${cat}: ${account} missing from BAS reference`).toBeDefined()
      }
    }
  })
})

describe('disposeAsset: gain/loss account selection', () => {
  function makeAsset(overrides: Partial<Asset> = {}): Asset {
    return {
      id: 'asset-1',
      user_id: 'u',
      company_id: 'co',
      name: 'Test',
      category: 'equipment',
      acquisition_date: '2023-01-01',
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
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
      ...overrides,
    }
  }

  function makeSupabaseForDispose(asset: Asset, schedules: Array<{ planned_depreciation: number }>) {
    // Three from() calls happen inside disposeAsset:
    //   1. getAsset (.maybeSingle on 'assets')
    //   2. sumPostedDepreciation (.then on 'depreciation_schedules': server-derived
    //      accumulated_depreciation; replaces the previously client-supplied value)
    //   3. update (.single on 'assets', returning the disposed row)
    const builders = {
      getBuilder: {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: asset, error: null }),
      },
      schedulesBuilder: (() => {
        const b: Record<string, unknown> = {
          select: vi.fn(),
          eq: vi.fn(),
          not: vi.fn(),
          then: undefined,
        }
        ;(b.select as ReturnType<typeof vi.fn>).mockReturnValue(b)
        ;(b.eq as ReturnType<typeof vi.fn>).mockReturnValue(b)
        ;(b.not as ReturnType<typeof vi.fn>).mockReturnValue(b)
        b.then = (resolve: (v: { data: unknown; error: unknown }) => void) =>
          resolve({ data: schedules, error: null })
        return b as { select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn>; not: ReturnType<typeof vi.fn> }
      })(),
      updateBuilder: {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { ...asset, disposed_at: '2025-06-30', disposed_proceeds: 50_000 },
          error: null,
        }),
      },
    }
    let calls = 0
    const supabase = {
      from: vi.fn((table: string) => {
        calls++
        if (table === 'depreciation_schedules') return builders.schedulesBuilder
        return calls === 1 ? builders.getBuilder : builders.updateBuilder
      }),
    }
    return { supabase, builders } as const
  }

  it('uses 3973 / 7973 for tangible asset disposal (equipment)', async () => {
    const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
    vi.mocked(createJournalEntry).mockClear()
    const asset = makeAsset({ category: 'equipment' })
    // Two prior posted schedules summing to 40_000 → NBV = 60_000, proceeds 80_000 → gain 20_000
    const { supabase } = makeSupabaseForDispose(asset, [
      { planned_depreciation: 20_000 },
      { planned_depreciation: 20_000 },
    ])

    await disposeAsset(
      supabase as unknown as Parameters<typeof disposeAsset>[0],
      'co',
      'u',
      'asset-1',
      {
        disposed_at: '2025-06-30',
        disposed_proceeds: 80_000,
        fiscal_period_id: 'fp',
      },
    )

    const call = vi.mocked(createJournalEntry).mock.calls[0]
    expect(call).toBeDefined()
    const lines = (call![3] as { lines: { account_number: string; debit_amount: number; credit_amount: number }[] }).lines
    // Server-derived accumulated debits 1229
    expect(lines.find((l) => l.account_number === '1229')?.debit_amount).toBe(40_000)
    // Gain goes to 3973 (tangible), not 3013
    expect(lines.find((l) => l.account_number === '3973')).toBeDefined()
    expect(lines.find((l) => l.account_number === '3013')).toBeUndefined()
  })

  it('uses 3013 / 7813 for immaterial asset disposal', async () => {
    const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
    vi.mocked(createJournalEntry).mockClear()
    const asset = makeAsset({
      category: 'immaterial',
      bas_asset_account: '1010',
      bas_accumulated_account: '1019',
      bas_expense_account: '7810',
    })
    // NBV = 50_000, proceeds 10_000 → loss 40_000
    const { supabase } = makeSupabaseForDispose(asset, [{ planned_depreciation: 50_000 }])

    await disposeAsset(
      supabase as unknown as Parameters<typeof disposeAsset>[0],
      'co',
      'u',
      'asset-1',
      {
        disposed_at: '2025-06-30',
        disposed_proceeds: 10_000,
        fiscal_period_id: 'fp',
      },
    )

    const call = vi.mocked(createJournalEntry).mock.calls[0]
    expect(call).toBeDefined()
    const lines = (call![3] as { lines: { account_number: string; debit_amount: number }[] }).lines
    expect(lines.find((l) => l.account_number === '7813')).toBeDefined()
    expect(lines.find((l) => l.account_number === '7973')).toBeUndefined()
  })

  it('uses 3971 / 7971 for building disposal', async () => {
    const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
    vi.mocked(createJournalEntry).mockClear()
    const asset = makeAsset({
      category: 'building',
      acquisition_cost: 2_000_000,
      bas_asset_account: '1110',
      bas_accumulated_account: '1119',
      bas_expense_account: '7821',
    })
    // NBV = 1_500_000, proceeds 2_000_000 → gain 500_000
    const { supabase } = makeSupabaseForDispose(asset, [{ planned_depreciation: 500_000 }])

    await disposeAsset(
      supabase as unknown as Parameters<typeof disposeAsset>[0],
      'co',
      'u',
      'asset-1',
      {
        disposed_at: '2025-06-30',
        disposed_proceeds: 2_000_000,
        fiscal_period_id: 'fp',
      },
    )

    const call = vi.mocked(createJournalEntry).mock.calls[0]
    const lines = (call![3] as { lines: { account_number: string }[] }).lines
    // Buildings route to 3971/7971, not 3973/7973
    expect(lines.find((l) => l.account_number === '3971')).toBeDefined()
    expect(lines.find((l) => l.account_number === '3973')).toBeUndefined()
  })

  it('uses 3971 / 7971 for land_improvement disposal', async () => {
    const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
    vi.mocked(createJournalEntry).mockClear()
    const asset = makeAsset({
      category: 'land_improvement',
      acquisition_cost: 100_000,
      bas_asset_account: '1150',
      bas_accumulated_account: '1159',
      bas_expense_account: '7824',
    })
    // NBV = 80_000, proceeds 40_000 → loss 40_000
    const { supabase } = makeSupabaseForDispose(asset, [{ planned_depreciation: 20_000 }])

    await disposeAsset(
      supabase as unknown as Parameters<typeof disposeAsset>[0],
      'co',
      'u',
      'asset-1',
      {
        disposed_at: '2025-06-30',
        disposed_proceeds: 40_000,
        fiscal_period_id: 'fp',
      },
    )

    const call = vi.mocked(createJournalEntry).mock.calls[0]
    const lines = (call![3] as { lines: { account_number: string }[] }).lines
    // Markanläggning routes to 7971 like buildings
    expect(lines.find((l) => l.account_number === '7971')).toBeDefined()
    expect(lines.find((l) => l.account_number === '7973')).toBeUndefined()
  })

  it('server-derives accumulated_depreciation: caller cannot inflate gain', async () => {
    const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
    vi.mocked(createJournalEntry).mockClear()
    const asset = makeAsset({ category: 'equipment', acquisition_cost: 100_000 })
    // Real accumulated = 30_000 from one posted schedule. A malicious client
    // could previously pass accumulated_depreciation: 100_000 to fake a fully
    // depreciated asset and pocket a 50_000 phantom gain on proceeds. With
    // server derivation, the lines reflect the actual 30_000.
    const { supabase } = makeSupabaseForDispose(asset, [{ planned_depreciation: 30_000 }])

    await disposeAsset(
      supabase as unknown as Parameters<typeof disposeAsset>[0],
      'co',
      'u',
      'asset-1',
      {
        disposed_at: '2025-06-30',
        disposed_proceeds: 50_000,
        fiscal_period_id: 'fp',
      },
    )

    const call = vi.mocked(createJournalEntry).mock.calls[0]
    const lines = (call![3] as { lines: { account_number: string; debit_amount: number; credit_amount: number }[] }).lines
    // accumulated debit must be 30_000 (server-derived), not anything else
    expect(lines.find((l) => l.account_number === '1229')?.debit_amount).toBe(30_000)
    // NBV = 100_000 − 30_000 = 70_000, proceeds 50_000 → loss 20_000 to 7973
    expect(lines.find((l) => l.account_number === '7973')?.debit_amount).toBe(20_000)
  })
})

describe('updateAsset: acquisition-basis correction guard', () => {
  function makeAssetRow(overrides: Partial<Asset> = {}): Asset {
    return {
      id: 'asset-1',
      user_id: 'u',
      company_id: 'co',
      name: 'reMarkable Paper Pro',
      category: 'computer',
      acquisition_date: '2025-04-19',
      acquisition_cost: 7999.2,
      salvage_value: 0,
      useful_life_months: 36,
      depreciation_method: 'linear',
      bas_asset_account: '1250',
      bas_accumulated_account: '1259',
      bas_expense_account: '7833',
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
      created_at: '2026-06-11T00:00:00Z',
      updated_at: '2026-06-11T00:00:00Z',
      ...overrides,
    }
  }

  const asSupabase = (s: unknown) => s as Parameters<typeof updateAsset>[0]

  /**
   * Minimal Supabase mock that captures the final UPDATE payload. updateAsset's
   * correction guard touches three tables:
   *   - 'assets'                 → getAsset (.maybeSingle) and the update (.single)
   *   - 'depreciation_schedules' → hasPostedDepreciation (1st call, head {count})
   *                                then hasManualDepreciationPosted (2nd call,
   *                                .select('journal_entry_id') → {data})
   *   - 'journal_entry_lines'    → hasManualDepreciationPosted ledger scan → {data}
   */
  function mockForUpdate(
    asset: Asset,
    opts: {
      postedCount?: number
      otherAssetEntryIds?: string[]
      accumulatedCredits?: { journal_entry_id: string }[]
    } = {},
  ) {
    const captured: { update: Record<string, unknown> | null } = { update: null }
    let schedCall = 0
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'depreciation_schedules') {
          schedCall += 1
          const isCountQuery = schedCall === 1
          const chain: Record<string, unknown> = {}
          chain.select = vi.fn(() => chain)
          chain.eq = vi.fn(() => chain)
          chain.neq = vi.fn(() => chain)
          chain.not = vi.fn(() => chain)
          chain.then = (resolve: (v: unknown) => void) =>
            resolve(
              isCountQuery
                ? { count: opts.postedCount ?? 0, error: null }
                : {
                    data: (opts.otherAssetEntryIds ?? []).map((id) => ({
                      journal_entry_id: id,
                    })),
                    error: null,
                  },
            )
          return chain
        }
        if (table === 'journal_entry_lines') {
          const chain: Record<string, unknown> = {}
          chain.select = vi.fn(() => chain)
          chain.eq = vi.fn(() => chain)
          chain.gt = vi.fn(() => chain)
          chain.then = (resolve: (v: unknown) => void) =>
            resolve({ data: opts.accumulatedCredits ?? [], error: null })
          return chain
        }
        const chain: Record<string, unknown> = {}
        chain.select = vi.fn(() => chain)
        chain.eq = vi.fn(() => chain)
        chain.maybeSingle = vi.fn(async () => ({ data: asset, error: null }))
        chain.update = vi.fn((payload: Record<string, unknown>) => {
          captured.update = payload
          return chain
        })
        chain.single = vi.fn(async () => ({
          data: { ...asset, ...(captured.update ?? {}) },
          error: null,
        }))
        return chain
      }),
    }
    return { supabase, captured }
  }

  it('corrects acquisition_date when not disposed and no depreciation is posted', async () => {
    const { supabase } = mockForUpdate(makeAssetRow(), { postedCount: 0 })
    const result = await updateAsset(asSupabase(supabase), 'co', 'asset-1', {
      acquisition_date: '2025-08-15',
    })
    expect(result.acquisition_date).toBe('2025-08-15')
  })

  it('blocks an acquisition_date correction once depreciation is posted', async () => {
    const { supabase } = mockForUpdate(makeAssetRow(), { postedCount: 2 })
    await expect(
      updateAsset(asSupabase(supabase), 'co', 'asset-1', { acquisition_date: '2025-08-15' }),
    ).rejects.toBeInstanceOf(AssetCorrectionBlockedError)
  })

  it('blocks an acquisition_cost correction on a disposed asset', async () => {
    const { supabase } = mockForUpdate(
      makeAssetRow({ disposed_at: '2026-01-01', disposed_proceeds: 1000 }),
    )
    await expect(
      updateAsset(asSupabase(supabase), 'co', 'asset-1', { acquisition_cost: 5000 }),
    ).rejects.toThrow(/disposed/i)
  })

  it('allows a name-only edit even when depreciation is posted', async () => {
    // A name-only patch touches no acquisition-basis field, so the guard never
    // runs and the edit succeeds regardless of depreciation state.
    const { supabase } = mockForUpdate(makeAssetRow(), { postedCount: 5 })
    const result = await updateAsset(asSupabase(supabase), 'co', 'asset-1', {
      name: 'reMarkable Paper Pro 2',
    })
    expect(result.name).toBe('reMarkable Paper Pro 2')
  })

  it('realigns the BAS triple to the new category defaults on a category correction', async () => {
    const { supabase, captured } = mockForUpdate(makeAssetRow(), { postedCount: 0 })
    await updateAsset(asSupabase(supabase), 'co', 'asset-1', { category: 'equipment' })
    // computer (1250/1259/7833) → equipment defaults (1220/1229/7832)
    expect(captured.update).toMatchObject({
      category: 'equipment',
      bas_asset_account: '1220',
      bas_accumulated_account: '1229',
      bas_expense_account: '7832',
    })
  })

  it('blocks a correction when depreciation was hand-posted (no engine schedule)', async () => {
    // No depreciation_schedules row, but a manual credit to the asset's 1259
    // accumulated account exists in the ledger: must still block.
    const { supabase } = mockForUpdate(makeAssetRow(), {
      postedCount: 0,
      otherAssetEntryIds: [],
      accumulatedCredits: [{ journal_entry_id: 'manual-entry-1' }],
    })
    await expect(
      updateAsset(asSupabase(supabase), 'co', 'asset-1', { acquisition_date: '2025-08-15' }),
    ).rejects.toBeInstanceOf(AssetCorrectionBlockedError)
  })

  it('allows a correction when the only 1259 credit is a sibling asset’s engine entry', async () => {
    // Two computers share 1259. The sibling was depreciated via the engine, so
    // its journal entry is attributable to the OTHER asset and must NOT block a
    // correction of this still-undepreciated asset (no false positive).
    const { supabase, captured } = mockForUpdate(makeAssetRow(), {
      postedCount: 0,
      otherAssetEntryIds: ['sibling-engine-entry'],
      accumulatedCredits: [{ journal_entry_id: 'sibling-engine-entry' }],
    })
    const result = await updateAsset(asSupabase(supabase), 'co', 'asset-1', {
      acquisition_date: '2025-08-15',
    })
    expect(result.acquisition_date).toBe('2025-08-15')
    expect(captured.update).toMatchObject({ acquisition_date: '2025-08-15' })
  })
})
