/**
 * commitAnnualPostings(): one atomic posting per asset (issue #2779).
 *
 * The old shape called createJournalEntry() and then wrote the
 * depreciation_schedules row in a second statement, so a failure in between
 * left a posted voucher with no register row. The voucher and the link are now
 * one engine call backed by one database transaction; these tests pin that
 * this module issues no register write of its own, and how a batch behaves
 * when the database refuses one asset.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

const createAssetDepreciationEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createAssetDepreciationEntry: (...args: unknown[]) => createAssetDepreciationEntry(...args),
}))

const listAssets = vi.fn()
vi.mock('../asset-service', () => ({
  listAssets: (...args: unknown[]) => listAssets(...args),
}))

const { commitAnnualPostings } = await import('../depreciation-engine')
const { AssetDepreciationRefusedError } = await import('@/lib/bookkeeping/errors')

function makeAsset(id: string, name: string): Asset {
  return {
    id,
    user_id: 'u',
    company_id: 'co',
    name,
    category: 'equipment',
    acquisition_date: '2026-01-01',
    acquisition_cost: 100000,
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
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

type ScheduleRow = { id: string; asset_id: string; journal_entry_id: string | null }

/** Serves proposeAnnualPostings()'s three reads and records every call, so a
 *  test can prove this module never writes to the register itself. */
function makeSupabase(currentSchedules: ScheduleRow[] = []) {
  const calls: { table: string; method: string }[] = []
  let scheduleReads = 0
  const chain = (table: string, result: unknown): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
          return () => {
            calls.push({ table, method: String(prop) })
            return chain(table, result)
          }
        },
      },
    )
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'fiscal_periods') {
        return chain(table, {
          data: { id: 'period-1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' },
          error: null,
        })
      }
      if (table === 'depreciation_schedules') {
        scheduleReads += 1
        // 1st read: current period rows. 2nd: prior posted rows (none).
        return chain(table, { data: scheduleReads === 1 ? currentSchedules : [], error: null })
      }
      return chain(table, { data: null, error: null })
    }),
  }
  const writes = () =>
    calls.filter((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method))
  return { supabase: supabase as never, writes }
}

const posted = (entryId: string, scheduleId: string) => ({
  entry: { id: entryId, status: 'posted' },
  scheduleId,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('commitAnnualPostings', () => {
  it('posts each asset through ONE engine call and writes nothing to the register itself', async () => {
    listAssets.mockResolvedValue([makeAsset('a1', 'Maskin'), makeAsset('a2', 'Truck')])
    createAssetDepreciationEntry
      .mockResolvedValueOnce(posted('je-1', 'sched-1'))
      .mockResolvedValueOnce(posted('je-2', 'sched-2'))
    const { supabase, writes } = makeSupabase()

    const result = await commitAnnualPostings(supabase, 'co', 'user-1', 'period-1')

    expect(result.posted.map((p) => [p.assetId, p.entry.id, p.scheduleId])).toEqual([
      ['a1', 'je-1', 'sched-1'],
      ['a2', 'je-2', 'sched-2'],
    ])
    expect(result.skipped).toEqual([])
    // The regression itself: no second statement. The link is the RPC's job.
    expect(writes()).toEqual([])

    const [, companyId, userId, input, link] = createAssetDepreciationEntry.mock.calls[0]
    expect([companyId, userId]).toEqual(['co', 'user-1'])
    expect(input).toMatchObject({
      fiscal_period_id: 'period-1',
      entry_date: '2026-12-31',
      source_type: 'year_end',
      description: 'Planenlig avskrivning 2026: Maskin',
      lines: [
        { account_number: '7832', debit_amount: 20000, credit_amount: 0 },
        { account_number: '1229', debit_amount: 0, credit_amount: 20000 },
      ],
    })
    // The register records exactly what the voucher books.
    expect(link).toEqual({
      asset_id: 'a1', planned_depreciation: 20000,
      opening_accumulated_depreciation: 0, opening_depreciation_date: null,
    })
  })

  it('carries the opening snapshot used by the proposal into the atomic posting', async () => {
    listAssets.mockResolvedValue([{
      ...makeAsset('a1', 'Maskin'),
      opening_accumulated_depreciation: 10000,
      opening_depreciation_date: '2026-06-30',
    }])
    createAssetDepreciationEntry.mockResolvedValueOnce(posted('je-1', 'sched-1'))
    const { supabase } = makeSupabase()
    await commitAnnualPostings(supabase, 'co', 'user-1', 'period-1')
    expect(createAssetDepreciationEntry.mock.calls[0][4]).toMatchObject({
      opening_accumulated_depreciation: 10000,
      opening_depreciation_date: '2026-06-30',
    })
  })

  it('skips an asset the proposal already shows as posted, without calling the engine', async () => {
    listAssets.mockResolvedValue([makeAsset('a1', 'Maskin')])
    const { supabase } = makeSupabase([{ id: 'sched-1', asset_id: 'a1', journal_entry_id: 'je-old' }])

    const result = await commitAnnualPostings(supabase, 'co', 'user-1', 'period-1')

    expect(result).toEqual({ posted: [], skipped: [{ assetId: 'a1', reason: 'already_posted' }] })
    expect(createAssetDepreciationEntry).not.toHaveBeenCalled()
  })

  it('skips an asset someone else posted first and carries on with the rest of the batch', async () => {
    listAssets.mockResolvedValue([makeAsset('a1', 'Maskin'), makeAsset('a2', 'Truck')])
    createAssetDepreciationEntry
      .mockRejectedValueOnce(new AssetDepreciationRefusedError('already_posted'))
      .mockResolvedValueOnce(posted('je-2', 'sched-2'))
    const { supabase } = makeSupabase()

    const result = await commitAnnualPostings(supabase, 'co', 'user-1', 'period-1')

    expect(result.skipped).toEqual([{ assetId: 'a1', reason: 'already_posted' }])
    expect(result.posted.map((p) => p.assetId)).toEqual(['a2'])
  })

  it('skips an asset that was deleted while its posting waited on the row lock', async () => {
    listAssets.mockResolvedValue([makeAsset('a1', 'Maskin'), makeAsset('a2', 'Truck')])
    createAssetDepreciationEntry
      .mockRejectedValueOnce(new AssetDepreciationRefusedError('asset_not_found'))
      .mockResolvedValueOnce(posted('je-2', 'sched-2'))
    const { supabase } = makeSupabase()

    const result = await commitAnnualPostings(supabase, 'co', 'user-1', 'period-1')

    expect(result.skipped).toEqual([{ assetId: 'a1', reason: 'asset_not_found' }])
    expect(result.posted.map((p) => p.assetId)).toEqual(['a2'])
  })

  it('does not swallow a real failure: a locked period stops the batch', async () => {
    listAssets.mockResolvedValue([makeAsset('a1', 'Maskin'), makeAsset('a2', 'Truck')])
    createAssetDepreciationEntry.mockRejectedValueOnce(new Error('Cannot post in a locked period'))
    const { supabase } = makeSupabase()

    await expect(commitAnnualPostings(supabase, 'co', 'user-1', 'period-1')).rejects.toThrow(
      /locked period/,
    )
    expect(createAssetDepreciationEntry).toHaveBeenCalledTimes(1)
  })

  it('honours the assetIds filter', async () => {
    listAssets.mockResolvedValue([makeAsset('a1', 'Maskin'), makeAsset('a2', 'Truck')])
    createAssetDepreciationEntry.mockResolvedValueOnce(posted('je-2', 'sched-2'))
    const { supabase } = makeSupabase()

    const result = await commitAnnualPostings(supabase, 'co', 'user-1', 'period-1', {
      assetIds: ['a2'],
    })

    expect(result.posted.map((p) => p.assetId)).toEqual(['a2'])
    expect(createAssetDepreciationEntry).toHaveBeenCalledTimes(1)
  })
})
