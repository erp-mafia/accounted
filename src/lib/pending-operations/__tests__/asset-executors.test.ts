/**
 * Executor tests for the staged anläggningsregister operations:
 * commitCreateAsset, commitUpdateAsset, commitDisposeAsset. The executors are
 * private to lib/pending-operations/commit.ts and reached through
 * commitPendingOperation, same pattern as account-and-note-executors.test.ts.
 * The asset service is mocked so the tests pin the executor contract:
 * re-validation at the commit boundary, the shared framework gates, the
 * coded error surface, and the result payload the approver sees.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/bokslut/assets/asset-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bokslut/assets/asset-service')>(
    '@/lib/bokslut/assets/asset-service',
  )
  return {
    ...actual,
    createAsset: vi.fn(),
    updateAsset: vi.fn(),
    getAsset: vi.fn(),
    disposeAsset: vi.fn(),
    hasPostedDepreciation: vi.fn(),
  }
})
vi.mock('@/lib/bokslut/assets/asset-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bokslut/assets/asset-api')>(
    '@/lib/bokslut/assets/asset-api',
  )
  return { ...actual, checkCreateAssetGates: vi.fn(), checkUpdateAssetGates: vi.fn() }
})

import { commitPendingOperation } from '../commit'
import {
  createAsset,
  updateAsset,
  getAsset,
  disposeAsset,
  hasPostedDepreciation,
  AssetCorrectionBlockedError,
  AssetAlreadyDisposedError,
  AssetJamkningDataRequiredError,
} from '@/lib/bokslut/assets/asset-service'
import { checkCreateAssetGates, checkUpdateAssetGates } from '@/lib/bokslut/assets/asset-api'

const COMPANY_ID = 'company-1'
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

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: COMPANY_ID,
    operation_type: 'create_asset',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'low',
    created_at: '2026-09-19T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-09-19T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

/** CAS claim + finalize update: what every executor path consumes around its own calls. */
function makeDispatcherSupabase() {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: { id: 'op-1' } }) // CAS claim
  enqueue({ data: null }) // finalize / reject update
  return supabase
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  vi.mocked(checkCreateAssetGates).mockResolvedValue(null)
  vi.mocked(checkUpdateAssetGates).mockResolvedValue(null)
})

describe('commitPendingOperation: create_asset', () => {
  const params = {
    name: 'MacBook Pro 16"',
    category: 'computer',
    acquisition_date: '2026-03-01',
    acquisition_cost: 32000,
    useful_life_months: 36,
  }

  it('creates the asset and returns the register row with asset_id', async () => {
    vi.mocked(createAsset).mockResolvedValue(ASSET as never)
    const result = await commitPendingOperation(
      makeDispatcherSupabase() as never,
      'user-1',
      COMPANY_ID,
      makePendingOp({ params }),
    )
    expect(result.status).toBe('committed')
    expect(vi.mocked(createAsset)).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ name: 'MacBook Pro 16"', acquisition_cost: 32000 }),
    )
    expect(result.data).toMatchObject({ asset_id: ASSET_ID, name: 'MacBook Pro 16"', has_posted_depreciation: false })
  })

  it('re-validates staged params at the commit boundary', async () => {
    const result = await commitPendingOperation(
      makeDispatcherSupabase() as never,
      'user-1',
      COMPANY_ID,
      makePendingOp({ params: { ...params, category: 'yacht' } }),
    )
    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/Invalid category/)
    expect(vi.mocked(createAsset)).not.toHaveBeenCalled()
  })

  it('surfaces a framework gate failure with its registry code', async () => {
    vi.mocked(checkCreateAssetGates).mockResolvedValue({
      code: 'K3_REQUIRED_FOR_COMPONENTS',
      status: 422,
      message_sv: 'K3 krävs.',
      message_en: 'K3 required.',
    })
    const result = await commitPendingOperation(
      makeDispatcherSupabase() as never,
      'user-1',
      COMPANY_ID,
      makePendingOp({ params }),
    )
    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(422)
    expect(result.code).toBe('K3_REQUIRED_FOR_COMPONENTS')
    expect(vi.mocked(createAsset)).not.toHaveBeenCalled()
  })
})

describe('commitPendingOperation: update_asset', () => {
  it('updates and returns the row with the posted-depreciation flag', async () => {
    vi.mocked(getAsset).mockResolvedValue(ASSET as never)
    vi.mocked(updateAsset).mockResolvedValue({ ...ASSET, name: 'Renamed' } as never)
    vi.mocked(hasPostedDepreciation).mockResolvedValue(true)
    const result = await commitPendingOperation(
      makeDispatcherSupabase() as never,
      'user-1',
      COMPANY_ID,
      makePendingOp({ operation_type: 'update_asset', params: { asset_id: ASSET_ID, changes: { name: 'Renamed' } } }),
    )
    expect(result.status).toBe('committed')
    expect(vi.mocked(updateAsset)).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, ASSET_ID, { name: 'Renamed' })
    expect(result.data).toMatchObject({ asset_id: ASSET_ID, name: 'Renamed', has_posted_depreciation: true })
  })

  it('auto-rejects with 404 when the asset is gone', async () => {
    vi.mocked(getAsset).mockResolvedValue(null)
    const result = await commitPendingOperation(
      makeDispatcherSupabase() as never,
      'user-1',
      COMPANY_ID,
      makePendingOp({ operation_type: 'update_asset', params: { asset_id: ASSET_ID, changes: { name: 'X' } } }),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(404)
    expect(result.code).toBe('ASSET_NOT_FOUND')
  })

  it('maps the service correction lock to 409 ASSET_CORRECTION_BLOCKED', async () => {
    vi.mocked(getAsset).mockResolvedValue(ASSET as never)
    vi.mocked(updateAsset).mockRejectedValue(new AssetCorrectionBlockedError('depreciation_posted'))
    const result = await commitPendingOperation(
      makeDispatcherSupabase() as never,
      'user-1',
      COMPANY_ID,
      makePendingOp({ operation_type: 'update_asset', params: { asset_id: ASSET_ID, changes: { acquisition_cost: 1 } } }),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('ASSET_CORRECTION_BLOCKED')
  })

  it('rejects empty or tampered changes', async () => {
    const empty = await commitPendingOperation(
      makeDispatcherSupabase() as never,
      'user-1',
      COMPANY_ID,
      makePendingOp({ operation_type: 'update_asset', params: { asset_id: ASSET_ID, changes: {} } }),
    )
    expect(empty.status).toBe('failed')
    expect(empty.http_status).toBe(400)

    const tampered = await commitPendingOperation(
      makeDispatcherSupabase() as never,
      'user-1',
      COMPANY_ID,
      makePendingOp({
        operation_type: 'update_asset',
        params: { asset_id: ASSET_ID, changes: { bas_asset_account: '12345' } },
      }),
    )
    expect(tampered.status).toBe('failed')
    expect(tampered.error).toMatch(/Invalid bas_asset_account/)
    expect(vi.mocked(updateAsset)).not.toHaveBeenCalled()
  })
})

describe('commitPendingOperation: dispose_asset', () => {
  const params = {
    asset_id: ASSET_ID,
    disposal_type: 'sale',
    disposed_at: '2026-09-15',
    disposed_proceeds: 12500,
    vat_treatment: 'standard_25',
    fiscal_period_id: PERIOD_ID,
  }

  it('disposes and returns the voucher reference and gain/loss', async () => {
    vi.mocked(disposeAsset).mockResolvedValue({
      asset: { ...ASSET, disposed_at: '2026-09-15', disposal_type: 'sale' },
      disposal_entry: { id: 'je-1', voucher_number: 118 },
      gain_or_loss: -14000,
    } as never)
    const result = await commitPendingOperation(
      makeDispatcherSupabase() as never,
      'user-1',
      COMPANY_ID,
      makePendingOp({ operation_type: 'dispose_asset', risk_level: 'medium', params }),
    )
    expect(result.status).toBe('committed')
    expect(vi.mocked(disposeAsset)).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      ASSET_ID,
      expect.objectContaining({ disposal_type: 'sale', disposed_proceeds: 12500, fiscal_period_id: PERIOD_ID }),
    )
    expect(result.data).toEqual({
      asset_id: ASSET_ID,
      disposed_at: '2026-09-15',
      disposal_type: 'sale',
      disposal_journal_entry_id: 'je-1',
      voucher_number: 118,
      gain_or_loss: -14000,
    })
  })

  it('re-validates staged params (a scrap with proceeds never reaches the service)', async () => {
    const result = await commitPendingOperation(
      makeDispatcherSupabase() as never,
      'user-1',
      COMPANY_ID,
      makePendingOp({
        operation_type: 'dispose_asset',
        params: { ...params, disposal_type: 'scrap', vat_treatment: undefined },
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/Invalid disposed_proceeds/)
    expect(vi.mocked(disposeAsset)).not.toHaveBeenCalled()
  })

  it('auto-rejects an already-disposed asset with 409 and the registry code', async () => {
    vi.mocked(disposeAsset).mockRejectedValue(new AssetAlreadyDisposedError())
    const result = await commitPendingOperation(
      makeDispatcherSupabase() as never,
      'user-1',
      COMPANY_ID,
      makePendingOp({ operation_type: 'dispose_asset', params }),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('ASSET_ALREADY_DISPOSED')
  })

  it('surfaces missing jämkning data as 422', async () => {
    vi.mocked(disposeAsset).mockRejectedValue(new AssetJamkningDataRequiredError())
    const result = await commitPendingOperation(
      makeDispatcherSupabase() as never,
      'user-1',
      COMPANY_ID,
      makePendingOp({ operation_type: 'dispose_asset', params }),
    )
    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(422)
    expect(result.code).toBe('ASSET_JAMKNING_DATA_REQUIRED')
  })
})
