/**
 * Unit tests for the anläggningsregister tools: gnubok_list_assets,
 * gnubok_get_asset (reads) and the staged writes gnubok_create_asset,
 * gnubok_update_asset, gnubok_dispose_asset. Covers registration/scope/
 * risk-tier wiring, argument validation, the shared framework gates, the
 * correction-lock pre-flight and dry-run staging previews. Executor-side
 * coverage lives in lib/pending-operations/__tests__/asset-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/bokslut/assets/asset-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bokslut/assets/asset-service')>(
    '@/lib/bokslut/assets/asset-service',
  )
  return {
    ...actual,
    listAssets: vi.fn(),
    getAsset: vi.fn(),
    hasPostedDepreciation: vi.fn(),
    previewAssetDisposal: vi.fn(),
  }
})

import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import {
  listAssets,
  getAsset,
  hasPostedDepreciation,
  previewAssetDisposal,
  AssetNotFoundError,
} from '@/lib/bokslut/assets/asset-service'

const listTool = tools.find((t) => t.name === 'gnubok_list_assets')!
const getTool = tools.find((t) => t.name === 'gnubok_get_asset')!
const createTool = tools.find((t) => t.name === 'gnubok_create_asset')!
const updateTool = tools.find((t) => t.name === 'gnubok_update_asset')!
const disposeTool = tools.find((t) => t.name === 'gnubok_dispose_asset')!

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ASSET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PERIOD_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const ASSET = {
  id: ASSET_ID,
  user_id: 'user-1',
  company_id: COMPANY_ID,
  name: 'MacBook Pro 16"',
  category: 'computer',
  acquisition_date: '2026-03-01',
  acquisition_cost: 32000,
  salvage_value: 0,
  useful_life_months: 36,
  depreciation_method: 'linear',
  bas_asset_account: '1224',
  bas_accumulated_account: '1229',
  bas_expense_account: '7832',
  restvarde_target: null,
  disposed_at: null,
  disposed_proceeds: null,
  disposal_type: null,
  disposal_journal_entry_id: null,
  disposed_proceeds_vat: 0,
  disposed_vat_treatment: null,
  jamkning_amount: 0,
  jamkning_remaining_months: null,
  jamkning_total_months: null,
  jamkning_original_input_vat: null,
  k3_components: null,
  notes: null,
  created_at: '2026-03-01T09:12:00.000Z',
  updated_at: '2026-03-01T09:12:00.000Z',
}

const K2_COMPANY = { data: { accounting_framework: 'k2', entity_type: 'aktiebolag' } }

const noopSupabase = { from: vi.fn() } as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('asset tools: registration', () => {
  it('all five tools exist with strict input schemas', () => {
    for (const tool of [listTool, getTool, createTool, updateTool, disposeTool]) {
      expect(tool).toBeDefined()
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    }
  })

  it('reads are read-only, writes stage', () => {
    for (const tool of [listTool, getTool]) {
      expect(tool.annotations.readOnlyHint).toBe(true)
    }
    for (const tool of [createTool, updateTool, disposeTool]) {
      const out = tool.outputSchema as { properties?: Record<string, unknown>; required?: string[] }
      expect(out?.properties?.staged).toBeDefined()
      expect(out?.required).toContain('staged')
      expect(tool.description).toMatch(/stag(e|es|ing)/i)
      expect(tool.annotations.readOnlyHint).toBe(false)
      expect(tool.annotations.destructiveHint).toBe(false)
    }
  })

  it('is mapped to the right scopes and risk tiers', () => {
    expect(TOOL_SCOPE_MAP.gnubok_list_assets).toBe('reports:read')
    expect(TOOL_SCOPE_MAP.gnubok_get_asset).toBe('reports:read')
    expect(TOOL_SCOPE_MAP.gnubok_create_asset).toBe('bookkeeping:write')
    expect(TOOL_SCOPE_MAP.gnubok_update_asset).toBe('bookkeeping:write')
    expect(TOOL_SCOPE_MAP.gnubok_dispose_asset).toBe('bookkeeping:write')
    expect(OPERATION_RISK_TIERS.create_asset).toBe('low')
    expect(OPERATION_RISK_TIERS.update_asset).toBe('low')
    expect(OPERATION_RISK_TIERS.dispose_asset).toBe('medium')
  })

  it('declares the required write arguments', () => {
    expect((createTool.inputSchema as { required?: string[] }).required).toEqual([
      'name', 'category', 'acquisition_date', 'acquisition_cost', 'useful_life_months',
    ])
    expect((updateTool.inputSchema as { required?: string[] }).required).toEqual(['asset_id'])
    expect((disposeTool.inputSchema as { required?: string[] }).required).toEqual([
      'asset_id', 'disposal_type', 'disposed_at', 'disposed_proceeds', 'fiscal_period_id',
    ])
  })
})

describe('gnubok_list_assets', () => {
  it('returns qualified ids and has_posted_depreciation', async () => {
    vi.mocked(listAssets).mockResolvedValue([ASSET] as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ asset_id: ASSET_ID }] }) // depreciation_schedules with a posted entry
    const result = (await listTool.execute({ active_only: true }, COMPANY_ID, 'user-1', supabase as never)) as {
      assets: Array<Record<string, unknown>>
      count: number
    }
    expect(vi.mocked(listAssets)).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, { activeOnly: true })
    expect(result.count).toBe(1)
    expect(result.assets[0]).toMatchObject({
      asset_id: ASSET_ID,
      name: 'MacBook Pro 16"',
      acquisition_cost: 32000,
      has_posted_depreciation: true,
    })
    expect(result.assets[0]).not.toHaveProperty('id')
  })
})

describe('gnubok_get_asset', () => {
  it('rejects a non-UUID asset_id before any DB call', async () => {
    await expect(getTool.execute({ asset_id: 'nope' }, COMPANY_ID, 'user-1', noopSupabase)).rejects.toThrow(/UUID/)
    expect(vi.mocked(getAsset)).not.toHaveBeenCalled()
  })

  it('throws the coded not-found error', async () => {
    vi.mocked(getAsset).mockResolvedValue(null)
    await expect(getTool.execute({ asset_id: ASSET_ID }, COMPANY_ID, 'user-1', noopSupabase)).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    })
  })

  it('returns the asset with its depreciation schedule', async () => {
    vi.mocked(getAsset).mockResolvedValue(ASSET as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { fiscal_period_id: PERIOD_ID, planned_depreciation: '8888.89', journal_entry_id: 'je-1' },
        { fiscal_period_id: 'p-2027', planned_depreciation: 10666.67, journal_entry_id: null },
      ],
    })
    const result = (await getTool.execute({ asset_id: ASSET_ID }, COMPANY_ID, 'user-1', supabase as never)) as {
      asset: Record<string, unknown>
      depreciation_schedule: Array<Record<string, unknown>>
    }
    expect(result.asset).toMatchObject({ asset_id: ASSET_ID, has_posted_depreciation: true })
    expect(result.depreciation_schedule).toEqual([
      { fiscal_period_id: PERIOD_ID, planned_depreciation: 8888.89, journal_entry_id: 'je-1' },
      { fiscal_period_id: 'p-2027', planned_depreciation: 10666.67, journal_entry_id: null },
    ])
  })
})

describe('gnubok_create_asset', () => {
  const validArgs = {
    name: 'MacBook Pro 16"',
    category: 'computer',
    acquisition_date: '2026-03-01',
    acquisition_cost: 32000,
    useful_life_months: 36,
  }

  it('rejects invalid arguments before any DB call', async () => {
    await expect(
      createTool.execute({ ...validArgs, acquisition_cost: -1 }, COMPANY_ID, 'user-1', noopSupabase),
    ).rejects.toThrow(/Invalid acquisition_cost/)
    await expect(
      createTool.execute({ ...validArgs, bas_asset_account: '1110' }, COMPANY_ID, 'user-1', noopSupabase),
    ).rejects.toThrow(/Invalid bas_asset_account/)
  })

  it('refuses k3_components for a K2 company with the registry code', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(K2_COMPANY)
    await expect(
      createTool.execute(
        { ...validArgs, k3_components: [{ name: 'Skärm', cost: 32000, useful_life_months: 36 }], dry_run: true },
        COMPANY_ID,
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({ code: 'K3_REQUIRED_FOR_COMPONENTS' })
  })

  it('dry_run previews the resolved account triple without staging', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(K2_COMPANY) // gate
    enqueue(K2_COMPANY) // account resolution
    const result = (await createTool.execute(
      { ...validArgs, dry_run: true },
      COMPANY_ID,
      'user-1',
      supabase as never,
    )) as { staged: boolean; dry_run?: boolean; preview: Record<string, unknown> }
    expect(result.dry_run).toBe(true)
    expect(result.staged).toBe(false)
    expect(result.preview).toMatchObject({
      name: 'MacBook Pro 16"',
      category: 'computer',
      acquisition_cost: 32000,
      depreciation_method: 'linear',
      accounts: { asset: '1224', accumulated: '1229', expense: '7832' },
      k3_component_count: 0,
    })
  })
})

describe('gnubok_update_asset', () => {
  it('requires at least one change', async () => {
    await expect(
      updateTool.execute({ asset_id: ASSET_ID, dry_run: true }, COMPANY_ID, 'user-1', noopSupabase),
    ).rejects.toThrow(/At least one field/)
    expect(vi.mocked(getAsset)).not.toHaveBeenCalled()
  })

  it('throws the coded not-found error', async () => {
    vi.mocked(getAsset).mockResolvedValue(null)
    await expect(
      updateTool.execute({ asset_id: ASSET_ID, name: 'X' }, COMPANY_ID, 'user-1', noopSupabase),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' })
  })

  it('pre-flights the correction lock once depreciation is posted', async () => {
    vi.mocked(getAsset).mockResolvedValue(ASSET as never)
    vi.mocked(hasPostedDepreciation).mockResolvedValue(true)
    await expect(
      updateTool.execute({ asset_id: ASSET_ID, acquisition_cost: 30000, dry_run: true }, COMPANY_ID, 'user-1', noopSupabase),
    ).rejects.toMatchObject({ code: 'ASSET_CORRECTION_BLOCKED' })
  })

  it('pre-flights the correction lock on a disposed asset', async () => {
    vi.mocked(getAsset).mockResolvedValue({ ...ASSET, disposed_at: '2026-09-15' } as never)
    await expect(
      updateTool.execute({ asset_id: ASSET_ID, category: 'equipment', dry_run: true }, COMPANY_ID, 'user-1', noopSupabase),
    ).rejects.toMatchObject({ code: 'ASSET_CORRECTION_BLOCKED' })
    expect(vi.mocked(hasPostedDepreciation)).not.toHaveBeenCalled()
  })

  it('dry_run previews the changes for a plain rename', async () => {
    vi.mocked(getAsset).mockResolvedValue(ASSET as never)
    const result = (await updateTool.execute(
      { asset_id: ASSET_ID, name: 'Renamed', notes: null, dry_run: true },
      COMPANY_ID,
      'user-1',
      noopSupabase,
    )) as { staged: boolean; dry_run?: boolean; preview: Record<string, unknown> }
    expect(result.dry_run).toBe(true)
    expect(result.preview).toMatchObject({
      asset_id: ASSET_ID,
      asset_name: 'MacBook Pro 16"',
      changes: { name: 'Renamed', notes: null },
    })
    // A rename never touches the framework gates or the correction lock.
    expect(vi.mocked(hasPostedDepreciation)).not.toHaveBeenCalled()
  })
})

describe('gnubok_dispose_asset', () => {
  const sale = {
    asset_id: ASSET_ID,
    disposal_type: 'sale',
    disposed_at: '2026-09-15',
    disposed_proceeds: 12500,
    vat_treatment: 'standard_25',
    fiscal_period_id: PERIOD_ID,
  }

  it('rejects a scrap with proceeds before any DB call', async () => {
    await expect(
      disposeTool.execute(
        { ...sale, disposal_type: 'scrap', vat_treatment: undefined, disposed_proceeds: 5 },
        COMPANY_ID,
        'user-1',
        noopSupabase,
      ),
    ).rejects.toThrow(/Invalid disposed_proceeds/)
    expect(vi.mocked(previewAssetDisposal)).not.toHaveBeenCalled()
  })

  it('propagates the coded errors from the disposal preview', async () => {
    vi.mocked(previewAssetDisposal).mockRejectedValue(new AssetNotFoundError())
    await expect(disposeTool.execute(sale, COMPANY_ID, 'user-1', noopSupabase)).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    })
  })

  it('dry_run previews the exact plan lines and gain/loss', async () => {
    vi.mocked(previewAssetDisposal).mockResolvedValue({
      asset: ASSET,
      fiscalPeriod: { id: PERIOD_ID, period_start: '2026-01-01', period_end: '2026-12-31' },
      plan: {
        lines: [
          { account_number: '1930', debit_amount: 12500, credit_amount: 0 },
          { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
          { account_number: '1224', debit_amount: 0, credit_amount: 32000 },
          { account_number: '1229', debit_amount: 8000, credit_amount: 0 },
          { account_number: '7973', debit_amount: 14000, credit_amount: 0 },
        ],
        currentDepreciation: 5000,
        accumulatedDepreciation: 8000,
        proceedsGross: 12500,
        proceedsVat: 2500,
        vatTreatment: 'standard_25',
        gainOrLoss: -14000,
        jamkning: { amount: 0, direction: 'none' },
      },
    } as never)
    const { supabase } = createQueuedMockSupabase()
    const result = (await disposeTool.execute(
      { ...sale, dry_run: true },
      COMPANY_ID,
      'user-1',
      supabase as never,
    )) as { staged: boolean; dry_run?: boolean; preview: Record<string, unknown> }
    expect(vi.mocked(previewAssetDisposal)).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      ASSET_ID,
      expect.objectContaining({ disposal_type: 'sale', disposed_proceeds: 12500, fiscal_period_id: PERIOD_ID }),
    )
    expect(result.dry_run).toBe(true)
    expect(result.staged).toBe(false)
    expect(result.preview).toMatchObject({
      asset_id: ASSET_ID,
      asset_name: 'MacBook Pro 16"',
      proceeds_gross: 12500,
      gain_or_loss: -14000,
      book_value: 24000,
      posts_journal_entry: true,
    })
    expect((result.preview.lines as unknown[]).length).toBe(5)
    expect(result.preview.will).toMatch(/avyttring voucher/)
  })
})
