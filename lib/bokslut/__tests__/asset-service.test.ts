
import { describe, it, expect, vi } from 'vitest'
import {
  AssetCorrectionBlockedError,
  DEFAULT_ACCOUNTS_BY_CATEGORY,
  createAsset,
  defaultAccountsForCategory,
  updateAsset,
} from '../assets/asset-service'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import type { AccountingFramework, Asset, AssetCategory } from '@/types'

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
    for (const framework of ['k2', 'k3'] as const) {
      for (const cat of Object.keys(DEFAULT_ACCOUNTS_BY_CATEGORY) as AssetCategory[]) {
        const { asset, accumulated, expense } = defaultAccountsForCategory(cat, framework)
        for (const account of [asset, accumulated, expense]) {
          expect(
            getBASReference(account),
            `${framework}/${cat}: ${account} missing from BAS reference`,
          ).toBeDefined()
        }
      }
    }
  })
})

/**
 * K2 (BFNAR 2016:10 punkt 10.4) forbids capitalizing EGENUPPARBETADE
 * immateriella tillgångar, which is what 1010/1019 carry. An ACQUIRED
 * intangible is lawful under K2 and belongs on 1090/1099
 * (.claude/skills/swedish-year-end-closing/references/k2-vs-k3.md:24, "Only
 * acquired intangibles may be recognized"), so the default has to follow the
 * company's framework rather than being one pair for everyone.
 */
describe('defaultAccountsForCategory', () => {
  it('gives a K3 company the egenupparbetade pair for immaterial', () => {
    expect(defaultAccountsForCategory('immaterial', 'k3')).toEqual({
      asset: '1010',
      accumulated: '1019',
      expense: '7810',
    })
  })

  it.each([['k2' as const], [null], [undefined]])(
    'gives the acquired pair 1090/1099 for immaterial when the framework is %s',
    (framework: AccountingFramework | null | undefined) => {
      expect(defaultAccountsForCategory('immaterial', framework)).toEqual({
        asset: '1090',
        accumulated: '1099',
        expense: '7810',
      })
    },
  )

  it('leaves 1090/1099 unflagged in the BAS chart, so the K2 gate passes them', () => {
    expect(getBASReference('1090')?.k2_excluded).toBe(false)
    expect(getBASReference('1099')?.k2_excluded).toBe(false)
    // Inside the 1010-1099 window the immaterial Zod/service range checks allow.
    expect('1090' >= '1010' && '1099' <= '1099').toBe(true)
  })

  it('is framework-independent for every tangible category', () => {
    const tangible: AssetCategory[] = [
      'building',
      'land_improvement',
      'machinery',
      'equipment',
      'vehicle',
      'computer',
      'other_tangible',
    ]
    for (const cat of tangible) {
      expect(defaultAccountsForCategory(cat, 'k2')).toEqual(DEFAULT_ACCOUNTS_BY_CATEGORY[cat])
      expect(defaultAccountsForCategory(cat, 'k3')).toEqual(DEFAULT_ACCOUNTS_BY_CATEGORY[cat])
    }
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
   * correction guard touches four tables:
   *   - 'assets'                 → getAsset (.maybeSingle) and the update (.single)
   *   - 'depreciation_schedules' → hasPostedDepreciation (1st call, head {count})
   *                                then hasManualDepreciationPosted (2nd call,
   *                                .select('journal_entry_id') → {data})
   *   - 'journal_entries'        → hasManualDepreciationPosted entries step of the
   *                                two-step entry-lines fetch (lib/bookkeeping/entry-lines.ts)
   *   - 'journal_entry_lines'    → hasManualDepreciationPosted ledger scan → {data}
   */
  function mockForUpdate(
    asset: Asset,
    opts: {
      postedCount?: number
      otherAssetEntryIds?: string[]
      accumulatedCredits?: { journal_entry_id: string }[]
      accountingFramework?: AccountingFramework | null
    } = {},
  ) {
    const captured: { update: Record<string, unknown> | null } = { update: null }
    let schedCall = 0
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'companies') {
          // Only read when a category change needs a framework-dependent
          // default (the immaterial category).
          const chain: Record<string, unknown> = {}
          chain.select = vi.fn(() => chain)
          chain.eq = vi.fn(() => chain)
          chain.single = vi.fn(async () => ({
            data: { accounting_framework: opts.accountingFramework ?? null },
            error: null,
          }))
          return chain
        }
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
        if (table === 'journal_entries') {
          // Entries step of the two-step fetch: derive the entry ids from the
          // line fixtures so the chunked line query has ids to ask for.
          const entryIds = [
            ...new Set((opts.accumulatedCredits ?? []).map((l) => l.journal_entry_id)),
          ]
          const chain: Record<string, unknown> = {}
          chain.select = vi.fn(() => chain)
          chain.eq = vi.fn(() => chain)
          chain.order = vi.fn(() => chain)
          chain.range = vi.fn(() => chain)
          chain.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: entryIds.length > 0 ? entryIds.map((id) => ({ id })) : [{ id: 'entry-none' }],
              error: null,
            })
          return chain
        }
        if (table === 'journal_entry_lines') {
          const chain: Record<string, unknown> = {}
          chain.select = vi.fn(() => chain)
          chain.eq = vi.fn(() => chain)
          chain.gt = vi.fn(() => chain)
          chain.in = vi.fn(() => chain)
          chain.order = vi.fn(() => chain)
          chain.range = vi.fn(() => chain)
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

  // A K2 aktiebolag that bought a software licence and first filed it under
  // "Inventarier" must be able to recategorize it to "Immateriell tillgång":
  // K2 forbids only EGENUPPARBETADE intangibles, and an acquired one is
  // lawful on 1090/1099. Landing it on 1010/1019 would be the Ej K2 pair and
  // the API gate would reject the whole edit.
  it('realigns a category correction to immaterial onto 1090/1099 for a K2 company', async () => {
    const { supabase, captured } = mockForUpdate(
      makeAssetRow({
        category: 'equipment',
        bas_asset_account: '1220',
        bas_accumulated_account: '1229',
        bas_expense_account: '7832',
      }),
      { postedCount: 0, accountingFramework: 'k2' },
    )
    await updateAsset(asSupabase(supabase), 'co', 'asset-1', { category: 'immaterial' })
    expect(captured.update).toMatchObject({
      category: 'immaterial',
      bas_asset_account: '1090',
      bas_accumulated_account: '1099',
      bas_expense_account: '7810',
    })
  })

  it('realigns a category correction to immaterial onto 1010/1019 for a K3 company', async () => {
    const { supabase, captured } = mockForUpdate(
      makeAssetRow({
        category: 'equipment',
        bas_asset_account: '1220',
        bas_accumulated_account: '1229',
        bas_expense_account: '7832',
      }),
      { postedCount: 0, accountingFramework: 'k3' },
    )
    await updateAsset(asSupabase(supabase), 'co', 'asset-1', { category: 'immaterial' })
    expect(captured.update).toMatchObject({
      category: 'immaterial',
      bas_asset_account: '1010',
      bas_accumulated_account: '1019',
      bas_expense_account: '7810',
    })
  })

  it('keeps an explicit account override on a recategorization to immaterial', async () => {
    // Explicit accounts suppress the realign entirely (unchanged semantics):
    // a K3 company deliberately picking 1010/1019 still gets them.
    const { supabase, captured } = mockForUpdate(
      makeAssetRow({
        category: 'equipment',
        bas_asset_account: '1220',
        bas_accumulated_account: '1229',
        bas_expense_account: '7832',
      }),
      { postedCount: 0, accountingFramework: 'k3' },
    )
    await updateAsset(asSupabase(supabase), 'co', 'asset-1', {
      category: 'immaterial',
      bas_asset_account: '1010',
      bas_accumulated_account: '1019',
      bas_expense_account: '7810',
    })
    expect(captured.update).toMatchObject({
      bas_asset_account: '1010',
      bas_accumulated_account: '1019',
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

describe('createAsset: framework-aware immaterial defaults', () => {
  function mockForCreate(
    opts: { accountingFramework?: AccountingFramework | null; companyError?: string } = {},
  ) {
    const captured: { insert: Record<string, unknown> | null; companyReads: number } = {
      insert: null,
      companyReads: 0,
    }
    const supabase = {
      from: vi.fn((table: string) => {
        const chain: Record<string, unknown> = {}
        if (table === 'companies') {
          captured.companyReads += 1
          chain.select = vi.fn(() => chain)
          chain.eq = vi.fn(() => chain)
          chain.single = vi.fn(async () =>
            opts.companyError
              ? { data: null, error: { message: opts.companyError } }
              : { data: { accounting_framework: opts.accountingFramework ?? null }, error: null },
          )
          return chain
        }
        chain.insert = vi.fn((payload: Record<string, unknown>) => {
          captured.insert = payload
          return chain
        })
        chain.select = vi.fn(() => chain)
        chain.single = vi.fn(async () => ({
          data: { id: 'asset-new', ...(captured.insert ?? {}) },
          error: null,
        }))
        return chain
      }),
    }
    return { supabase, captured }
  }

  const asSupabase = (s: unknown) => s as Parameters<typeof createAsset>[0]

  const baseInput = {
    name: 'Programvarulicens',
    category: 'immaterial' as const,
    acquisition_date: '2025-03-01',
    acquisition_cost: 60_000,
    useful_life_months: 60,
  }

  it('books a K2 company immaterial asset on the acquired pair 1090/1099', async () => {
    const { supabase, captured } = mockForCreate({ accountingFramework: 'k2' })
    await createAsset(asSupabase(supabase), 'co', 'user-1', baseInput)
    expect(captured.insert).toMatchObject({
      bas_asset_account: '1090',
      bas_accumulated_account: '1099',
      bas_expense_account: '7810',
    })
  })

  it('books a K3 company immaterial asset on 1010/1019', async () => {
    const { supabase, captured } = mockForCreate({ accountingFramework: 'k3' })
    await createAsset(asSupabase(supabase), 'co', 'user-1', baseInput)
    expect(captured.insert).toMatchObject({
      bas_asset_account: '1010',
      bas_accumulated_account: '1019',
    })
  })

  it('still honours an explicit account override', async () => {
    const { supabase, captured } = mockForCreate({ accountingFramework: 'k2' })
    await createAsset(asSupabase(supabase), 'co', 'user-1', {
      ...baseInput,
      bas_asset_account: '1030',
      bas_accumulated_account: '1039',
    })
    expect(captured.insert).toMatchObject({
      bas_asset_account: '1030',
      bas_accumulated_account: '1039',
    })
  })

  it('does not read the company for a tangible category', async () => {
    const { supabase, captured } = mockForCreate({ accountingFramework: 'k2' })
    await createAsset(asSupabase(supabase), 'co', 'user-1', {
      ...baseInput,
      name: 'MacBook Pro',
      category: 'computer',
    })
    expect(captured.companyReads).toBe(0)
    expect(captured.insert).toMatchObject({
      bas_asset_account: '1250',
      bas_accumulated_account: '1259',
    })
  })

  it('throws instead of guessing a framework when the company read fails', async () => {
    const { supabase, captured } = mockForCreate({ companyError: 'connection reset' })
    await expect(
      createAsset(asSupabase(supabase), 'co', 'user-1', baseInput),
    ).rejects.toThrow(/accounting framework/i)
    expect(captured.insert).toBeNull()
  })
})


