/**
 * deleteNeverPostedAsset() and the "reached the books" rule it enforces.
 *
 * The register is sidoordnad bokföring (BFL 5 kap. 4 §, BFNAR 2013:2 kap. 4):
 * a row becomes räkenskapsinformation once it drives a voucher (posted
 * depreciation or the avyttring voucher). Only a row that never did may be
 * deleted; everything else must leave through disposal or storno.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AssetDeleteBlockedError,
  AssetNotFoundError,
  assetDeleteBlockReason,
  deleteNeverPostedAsset,
  getAssetDeleteBlock,
} from '../asset-service'
import type { Asset } from '@/types'

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    user_id: 'u',
    company_id: 'co',
    name: 'Testrad från Bokio',
    category: 'equipment',
    acquisition_date: '2026-01-15',
    acquisition_cost: 12000,
    salvage_value: 0,
    useful_life_months: 60,
    depreciation_method: 'linear',
    bas_asset_account: '1220',
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
    created_at: '2026-01-15T00:00:00Z',
    updated_at: '2026-01-15T00:00:00Z',
    ...overrides,
  }
}

type Result = { data?: unknown; error?: unknown; count?: number | null }

/**
 * Per-table result queue plus a recording of every chained call, so the tests
 * can assert both what the service decided and the exact filters it sent.
 */
function makeSupabase(byTable: Record<string, Result[]>, rpcResult: Result = { data: 'deleted' }) {
  const queues = new Map(Object.entries(byTable).map(([t, r]) => [t, [...r]]))
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const chain = (table: string, result: Result): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null })
          }
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args })
            return chain(table, result)
          }
        },
      },
    )
  const rpc = vi.fn().mockResolvedValue({ data: rpcResult.data ?? null, error: rpcResult.error ?? null })
  const supabase = {
    rpc,
    from: vi.fn((table: string) => {
      const q = queues.get(table)
      const next = q && q.length > 0 ? q.shift()! : { data: null, error: null, count: null }
      return chain(table, next)
    }),
  }
  const methodsFor = (table: string) => calls.filter((c) => c.table === table).map((c) => c.method)
  const argsFor = (table: string, method: string) =>
    calls.filter((c) => c.table === table && c.method === method).map((c) => c.args)
  return { supabase: supabase as never, rpc, calls, methodsFor, argsFor }
}

describe('assetDeleteBlockReason', () => {
  it('is null for a row that never reached the books', () => {
    expect(assetDeleteBlockReason(makeAsset(), false)).toBeNull()
  })

  it('blocks on a disposal date even without the voucher id (legacy disposals)', () => {
    expect(assetDeleteBlockReason(makeAsset({ disposed_at: '2026-06-30' }), false)).toBe('disposed')
  })

  it('blocks on a disposal voucher id even without the date', () => {
    expect(
      assetDeleteBlockReason(makeAsset({ disposal_journal_entry_id: 'je-1' }), false),
    ).toBe('disposed')
  })

  it('blocks on posted depreciation', () => {
    expect(assetDeleteBlockReason(makeAsset(), true)).toBe('depreciation_posted')
  })

  it('reports disposed before depreciation when both apply', () => {
    expect(assetDeleteBlockReason(makeAsset({ disposed_at: '2026-06-30' }), true)).toBe('disposed')
  })
})

describe('getAssetDeleteBlock', () => {
  it('does not query the schedules for a disposed asset', async () => {
    const { supabase, calls } = makeSupabase({})
    const reason = await getAssetDeleteBlock(supabase, 'co', makeAsset({ disposed_at: '2026-06-30' }))
    expect(reason).toBe('disposed')
    expect(calls).toHaveLength(0)
  })

  it('reads posted schedule rows for this asset and company only', async () => {
    const { supabase, argsFor } = makeSupabase({ depreciation_schedules: [{ count: 1 }] })
    const reason = await getAssetDeleteBlock(supabase, 'co', makeAsset())
    expect(reason).toBe('depreciation_posted')
    expect(argsFor('depreciation_schedules', 'eq')).toEqual([
      ['company_id', 'co'],
      ['asset_id', 'asset-1'],
    ])
    expect(argsFor('depreciation_schedules', 'not')).toEqual([['journal_entry_id', 'is', null]])
  })

  it('is null when no schedule row is posted', async () => {
    const { supabase } = makeSupabase({ depreciation_schedules: [{ count: 0 }] })
    expect(await getAssetDeleteBlock(supabase, 'co', makeAsset())).toBeNull()
  })
})

describe('deleteNeverPostedAsset', () => {
  // The rule is decided by the delete_never_posted_asset RPC under the asset
  // row lock (issue #2779); what Postgres guarantees is pinned in
  // tests/pg/asset-depreciation-atomic.pg.test.ts. Here: what the service
  // sends, and how it turns each outcome into the routes' 404 / 409 contract.

  it('throws ASSET_NOT_FOUND for a row outside the company without calling the rpc', async () => {
    const { supabase, rpc } = makeSupabase({ assets: [{ data: null }] })
    await expect(deleteNeverPostedAsset(supabase, 'co', 'asset-1')).rejects.toBeInstanceOf(
      AssetNotFoundError,
    )
    expect(rpc).not.toHaveBeenCalled()
  })

  it('deletes through ONE company-scoped rpc and returns the row as it was', async () => {
    const asset = makeAsset()
    const { supabase, rpc, calls } = makeSupabase({ assets: [{ data: asset }] })

    const deleted = await deleteNeverPostedAsset(supabase, 'co', 'asset-1')

    expect(deleted).toEqual(asset)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('delete_never_posted_asset', {
      p_company_id: 'co',
      p_asset_id: 'asset-1',
    })
    // The regression itself: no check-then-delete from the application. The
    // service issues no delete, and no schedule read that could go stale.
    expect(calls.some((c) => c.method === 'delete')).toBe(false)
    expect(calls.some((c) => c.table === 'depreciation_schedules')).toBe(false)
  })

  it('answers ASSET_DELETE_BLOCKED(disposed) when the rpc finds the asset disposed', async () => {
    const { supabase } = makeSupabase({ assets: [{ data: makeAsset() }] }, { data: 'disposed' })
    const err = await deleteNeverPostedAsset(supabase, 'co', 'asset-1').catch((e) => e)
    expect(err).toBeInstanceOf(AssetDeleteBlockedError)
    expect(err.code).toBe('ASSET_DELETE_BLOCKED')
    expect(err.reason).toBe('disposed')
  })

  it('answers ASSET_DELETE_BLOCKED(depreciation_posted) even when the row looked clean a moment ago', async () => {
    // The pre-read shows a never-posted asset; a posting committed before the
    // rpc took the row lock. The rpc, not the pre-read, is the authority.
    const { supabase } = makeSupabase(
      { assets: [{ data: makeAsset() }] },
      { data: 'depreciation_posted' },
    )
    const err = await deleteNeverPostedAsset(supabase, 'co', 'asset-1').catch((e) => e)
    expect(err).toBeInstanceOf(AssetDeleteBlockedError)
    expect(err.reason).toBe('depreciation_posted')
  })

  it('answers ASSET_NOT_FOUND when the row vanished between the read and the lock', async () => {
    const { supabase } = makeSupabase({ assets: [{ data: makeAsset() }] }, { data: 'not_found' })
    await expect(deleteNeverPostedAsset(supabase, 'co', 'asset-1')).rejects.toBeInstanceOf(
      AssetNotFoundError,
    )
  })

  it('surfaces an rpc failure (for example the writer-role trigger) as an error, not as a delete', async () => {
    const { supabase } = makeSupabase(
      { assets: [{ data: makeAsset() }] },
      { error: { message: 'permission denied' } },
    )
    await expect(deleteNeverPostedAsset(supabase, 'co', 'asset-1')).rejects.toThrow(
      /Failed to delete asset asset-1: permission denied/,
    )
  })

  it('refuses to report success on an outcome it does not know', async () => {
    const { supabase } = makeSupabase({ assets: [{ data: makeAsset() }] }, { data: 'something_new' })
    await expect(deleteNeverPostedAsset(supabase, 'co', 'asset-1')).rejects.toThrow(
      /unexpected outcome something_new/,
    )
  })
})
