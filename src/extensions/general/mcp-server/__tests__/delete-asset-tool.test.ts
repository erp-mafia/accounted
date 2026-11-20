/**
 * gnubok_delete_asset (crm#1452): stage removal of an anläggningsregister row
 * that never reached the books, with the rule the v1 and dashboard deletes
 * apply. Executor coverage: lib/pending-operations/__tests__/asset-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/bokslut/assets/asset-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bokslut/assets/asset-service')>(
    '@/lib/bokslut/assets/asset-service',
  )
  return { ...actual, getAsset: vi.fn(), getAssetDeleteBlock: vi.fn() }
})

import { tools, isDefaultCatalogTool } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { getAsset, getAssetDeleteBlock } from '@/lib/bokslut/assets/asset-service'

const deleteTool = tools.find((t) => t.name === 'gnubok_delete_asset')!

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ASSET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ASSET = {
  id: ASSET_ID,
  company_id: COMPANY_ID,
  name: 'Laptop',
  category: 'computer',
  acquisition_date: '2026-10-01',
  acquisition_cost: 20000,
  bas_asset_account: '1224',
  disposed_at: null,
  disposal_journal_entry_id: null,
}
const noopSupabase = { from: vi.fn() } as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_delete_asset', () => {
  it('is a search-only staged destructive write with a strict schema', () => {
    expect(deleteTool).toBeDefined()
    expect((deleteTool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    expect((deleteTool.inputSchema as { required?: string[] }).required).toEqual(['asset_id'])
    expect(deleteTool.annotations.destructiveHint).toBe(true)
    expect(isDefaultCatalogTool(deleteTool)).toBe(false)
    expect(TOOL_SCOPE_MAP.gnubok_delete_asset).toBe('bookkeeping:write')
    expect(OPERATION_RISK_TIERS.delete_asset).toBe('medium')
  })

  it('rejects a non-UUID asset_id before any read', async () => {
    await expect(
      deleteTool.execute({ asset_id: 'nope' }, COMPANY_ID, 'user-1', noopSupabase),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(vi.mocked(getAsset)).not.toHaveBeenCalled()
  })

  it('throws the coded not-found error', async () => {
    vi.mocked(getAsset).mockResolvedValue(null)
    await expect(
      deleteTool.execute({ asset_id: ASSET_ID, dry_run: true }, COMPANY_ID, 'user-1', noopSupabase),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' })
  })

  it('refuses a row that reached the books', async () => {
    vi.mocked(getAsset).mockResolvedValue(ASSET as never)
    vi.mocked(getAssetDeleteBlock).mockResolvedValue('depreciation_posted')
    await expect(
      deleteTool.execute({ asset_id: ASSET_ID, dry_run: true }, COMPANY_ID, 'user-1', noopSupabase),
    ).rejects.toMatchObject({ code: 'ASSET_DELETE_BLOCKED' })
  })

  it('dry_run previews the row that would go', async () => {
    vi.mocked(getAsset).mockResolvedValue(ASSET as never)
    vi.mocked(getAssetDeleteBlock).mockResolvedValue(null)
    const result = (await deleteTool.execute(
      { asset_id: ASSET_ID, dry_run: true },
      COMPANY_ID,
      'user-1',
      noopSupabase,
    )) as { staged: boolean; dry_run?: boolean; preview: Record<string, unknown> }
    expect(result.dry_run).toBe(true)
    expect(result.preview).toMatchObject({
      asset_id: ASSET_ID,
      asset_name: 'Laptop',
      bas_asset_account: '1224',
      will: expect.stringMatching(/no voucher/),
    })
  })
})
