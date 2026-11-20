import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Asset } from '@/types'

vi.mock('../asset-chart-accounts', () => ({
  chartAwareDefaultAccounts: vi.fn(async (_s: unknown, _c: unknown, _cat: unknown, defaults: unknown) => defaults),
  ensureAssetAccountsInChart: vi.fn(async () => undefined),
  unusableAssetAccounts: vi.fn(async () => []),
}))

const { AssetOwnDevelopmentAccountError, updateAsset } = await import('../asset-service')

/**
 * R1: an asset already on 1010 before own_development existed is unmarked,
 * and the fond för utvecklingsutgifter holds back until the user says what
 * it is. The edit form marks it through set_asset_own_development, whose
 * trigger writes the audit_log row with who did it.
 */

function intangible(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'a-1',
    user_id: 'creator',
    company_id: 'co',
    name: 'Kundportal',
    category: 'immaterial',
    acquisition_date: '2024-03-01',
    acquisition_cost: 300_000,
    salvage_value: 0,
    useful_life_months: 60,
    depreciation_method: 'linear',
    bas_asset_account: '1010',
    bas_accumulated_account: '1019',
    bas_expense_account: '7810',
    disposed_at: null,
    own_development: false,
    components: [],
    value_adjustments: [],
    k3_components: null,
    ...overrides,
  } as Asset
}

function client(asset: Asset, model: string | null = 'capitalise', rpcError?: string) {
  return createTableMockSupabase({
    assets: { data: asset },
    companies: { data: { accounting_framework: 'k3', development_expenditure_model: model } },
    'rpc:set_asset_own_development': rpcError ? { error: { message: rpcError } } : { data: true },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('updateAsset: the own development mark', () => {
  it('marks an asset on 1010 through the audited door, as the user who acts', async () => {
    const { supabase, findCall } = client(intangible())
    await updateAsset(supabase as never, 'co', 'a-1', { own_development: true }, { userId: 'user-2' })
    expect(findCall('rpc:set_asset_own_development', 'rpc')).toEqual([
      { p_company_id: 'co', p_asset_id: 'a-1', p_own: true, p_user_id: 'user-2', p_actor_type: null, p_actor_label: null },
    ])
    // Never a plain row update for the mark.
    expect(findCall('assets', 'update')).toBeUndefined()
  })

  it('unmarks, and writes nothing when the mark already stands', async () => {
    const marked = client(intangible({ own_development: true }))
    await updateAsset(marked.supabase as never, 'co', 'a-1', { own_development: false })
    expect(findP(marked.findCall)).toMatchObject({ p_own: false })

    const same = client(intangible({ own_development: true }))
    await updateAsset(same.supabase as never, 'co', 'a-1', { own_development: true })
    expect(same.findCall('rpc:set_asset_own_development', 'rpc')).toBeUndefined()
  })

  it('refuses to mark an asset off 1010-1019, or without the aktiveringsmodell', async () => {
    const off = client(intangible({ bas_asset_account: '1090', bas_accumulated_account: '1099' }))
    await expect(updateAsset(off.supabase as never, 'co', 'a-1', { own_development: true })).rejects.toBeInstanceOf(
      AssetOwnDevelopmentAccountError,
    )
    expect(off.findCall('rpc:set_asset_own_development', 'rpc')).toBeUndefined()

    const expense = client(intangible(), 'expense')
    await expect(updateAsset(expense.supabase as never, 'co', 'a-1', { own_development: true })).rejects.toMatchObject({
      code: 'OWN_DEVELOPMENT_NOT_CAPITALISED',
    })
    expect(expense.findCall('rpc:set_asset_own_development', 'rpc')).toBeUndefined()
  })

  it('reads the database\'s refusal as the same errors', async () => {
    const { supabase } = client(intangible(), 'capitalise', 'OWN_DEVELOPMENT_ACCOUNT')
    await expect(updateAsset(supabase as never, 'co', 'a-1', { own_development: true })).rejects.toMatchObject({
      code: 'OWN_DEVELOPMENT_ACCOUNT',
    })
  })
})

function findP(findCall: (table: string, method: string) => unknown[] | undefined) {
  return (findCall('rpc:set_asset_own_development', 'rpc') ?? [])[0]
}
