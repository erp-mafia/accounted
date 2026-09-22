/**
 * createAssetDepreciationEntry(): the engine entry point that posts a
 * planenlig avskrivning voucher and its depreciation_schedules link as one
 * database transaction (commit_asset_depreciation, issue #2779).
 *
 * What the database guarantees is pinned against real Postgres in
 * tests/pg/asset-depreciation-atomic.pg.test.ts. These tests pin the engine's
 * side of the contract: what it sends, how it maps the RPC's SQLSTATEs, and
 * that it never strands a draft or mistakes a committed voucher for a failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

const emit = vi.fn().mockResolvedValue([])
vi.mock('@/lib/events', () => ({
  eventBus: { emit: (...args: unknown[]) => emit(...args) },
}))

vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: vi.fn().mockResolvedValue([]),
}))

const { createAssetDepreciationEntry } = await import('../engine')
const { AssetDepreciationRefusedError, BookkeepingDatabaseError } = await import('../errors')

type Result = { data?: unknown; error?: unknown }

const DRAFT = {
  id: 'draft-1',
  user_id: 'user-1',
  company_id: 'co',
  fiscal_period_id: 'period-1',
  status: 'draft',
}
const POSTED = { ...DRAFT, status: 'posted', voucher_number: 7, lines: [] }

const INPUT = {
  fiscal_period_id: 'period-1',
  entry_date: '2026-12-31',
  description: 'Planenlig avskrivning 2026: Maskin',
  source_type: 'year_end' as const,
  lines: [
    { account_number: '7832', debit_amount: 20000, credit_amount: 0 },
    { account_number: '1229', debit_amount: 0, credit_amount: 20000 },
  ],
}
const LINK = { asset_id: 'asset-1', planned_depreciation: 20000 }

/**
 * Per-table result queues behind a chain-shape-agnostic proxy, recording every
 * call so a test can assert the exact writes. `journalEntries` is the queue
 * for that table AFTER the draft insert and its reload, which every test
 * needs and the helper supplies.
 */
function makeSupabase(options: { rpc: Result; journalEntries?: Result[] }) {
  const queues = new Map<string, Result[]>([
    ['fiscal_periods', [{ data: { name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' } }]],
    [
      'chart_of_accounts',
      [{ data: [{ account_number: '7832', id: 'acc-1' }, { account_number: '1229', id: 'acc-2' }] }],
    ],
    ['journal_entry_lines', [{ data: null }]],
    // createDraftEntry: insert().select().single(), then the reload with lines.
    ['journal_entries', [{ data: DRAFT }, { data: { ...DRAFT, lines: [] } }, ...(options.journalEntries ?? [])]],
  ])
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const chain = (table: string, result: Result): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve({ data: result.data ?? null, error: result.error ?? null })
          }
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args })
            return chain(table, result)
          }
        },
      },
    )

  const rpc = vi.fn().mockResolvedValue({ data: options.rpc.data ?? null, error: options.rpc.error ?? null })
  const supabase = {
    rpc,
    from: vi.fn((table: string) => {
      const q = queues.get(table)
      return chain(table, q && q.length > 0 ? q.shift()! : { data: null })
    }),
  }
  const updates = () => calls.filter((c) => c.table === 'journal_entries' && c.method === 'update')
  return { supabase: supabase as never, rpc, calls, updates }
}

/** The CAS cancel: update({status:'cancelled'}) scoped to id AND status=draft. */
function expectDraftCancelled(calls: { table: string; method: string; args: unknown[] }[]) {
  const je = calls.filter((c) => c.table === 'journal_entries')
  const at = je.findIndex((c) => c.method === 'update')
  expect(at).toBeGreaterThanOrEqual(0)
  expect(je[at].args).toEqual([{ status: 'cancelled' }])
  expect(je.slice(at + 1, at + 3).map((c) => c.args)).toEqual([
    ['id', 'draft-1'],
    ['status', 'draft'],
  ])
}

/** createDraftEntry legitimately emits journal_entry.drafted, so "nothing was
 *  posted" is asserted on the committed event specifically. */
function committedEvents() {
  return emit.mock.calls.filter(([event]) => (event as { type: string }).type === 'journal_entry.committed')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createAssetDepreciationEntry', () => {
  it('sends the draft, asset and amount to ONE rpc and returns the posted entry with its schedule id', async () => {
    const { supabase, rpc, calls } = makeSupabase({
      rpc: { data: [{ voucher_number: 7, schedule_id: 'sched-1' }] },
      journalEntries: [{ data: POSTED }],
    })

    const result = await createAssetDepreciationEntry(supabase, 'co', 'user-1', INPUT, LINK)

    expect(result).toEqual({ entry: POSTED, scheduleId: 'sched-1' })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('commit_asset_depreciation', {
      p_company_id: 'co',
      p_asset_id: 'asset-1',
      p_entry_id: 'draft-1',
      p_fiscal_period_id: 'period-1',
      p_planned_depreciation: 20000,
      p_actor_type: null,
      p_actor_label: null,
    })
    // The regression itself: the engine issues no second statement against
    // the register. The link is written inside the RPC or not at all.
    expect(calls.some((c) => c.table === 'depreciation_schedules')).toBe(false)
    expect(emit).toHaveBeenCalledWith({
      type: 'journal_entry.committed',
      payload: { entry: POSTED, userId: 'user-1', companyId: 'co' },
    })
  })

  it('maps 23505 to already_posted and cancels the draft', async () => {
    const { supabase, calls } = makeSupabase({
      rpc: { error: { code: '23505', message: 'Depreciation is already posted' } },
    })

    const err = await createAssetDepreciationEntry(supabase, 'co', 'user-1', INPUT, LINK).catch((e) => e)

    expect(err).toBeInstanceOf(AssetDepreciationRefusedError)
    expect(err.reason).toBe('already_posted')
    expect(err.code).toBe('ASSET_DEPRECIATION_REFUSED')
    expectDraftCancelled(calls)
    expect(committedEvents()).toHaveLength(0)
  })

  it('maps P0002 to asset_not_found (deleted while waiting on the row lock) and cancels the draft', async () => {
    const { supabase, calls } = makeSupabase({
      rpc: { error: { code: 'P0002', message: 'Asset not found: asset-1' } },
    })

    const err = await createAssetDepreciationEntry(supabase, 'co', 'user-1', INPUT, LINK).catch((e) => e)

    expect(err).toBeInstanceOf(AssetDepreciationRefusedError)
    expect(err.reason).toBe('asset_not_found')
    expectDraftCancelled(calls)
  })

  it('does not swallow a bad-draft 22023 as a skip: it is a real error, and the draft is still cancelled', async () => {
    const { supabase, calls } = makeSupabase({
      rpc: { error: { code: '22023', message: 'Valid depreciation draft not found' } },
    })

    const err = await createAssetDepreciationEntry(supabase, 'co', 'user-1', INPUT, LINK).catch((e) => e)

    expect(err).toBeInstanceOf(BookkeepingDatabaseError)
    expect(err).not.toBeInstanceOf(AssetDepreciationRefusedError)
    expect(err.operation).toBe('commit_asset_depreciation')
    expectDraftCancelled(calls)
  })

  it('surfaces any other database failure (period lock, balance) and cancels the draft', async () => {
    const { supabase, calls } = makeSupabase({
      rpc: { error: { code: 'P0001', message: 'Journal entry draft-1 is not balanced' } },
    })

    await expect(
      createAssetDepreciationEntry(supabase, 'co', 'user-1', INPUT, LINK),
    ).rejects.toThrow(/is not balanced/)
    expectDraftCancelled(calls)
  })

  it('never cancels after a successful rpc: a failed reload is reported as a reload failure', async () => {
    // Voucher and link are committed. Cancelling here would be wrong (and the
    // immutability trigger would refuse it); the caller must learn that the
    // posting happened.
    const { supabase, updates } = makeSupabase({
      rpc: { data: [{ voucher_number: 7, schedule_id: 'sched-1' }] },
      journalEntries: [{ error: { message: 'timeout' } }, { error: { message: 'timeout' } }],
    })

    const err = await createAssetDepreciationEntry(supabase, 'co', 'user-1', INPUT, LINK).catch((e) => e)

    expect(err).toBeInstanceOf(BookkeepingDatabaseError)
    expect(err.operation).toBe('fetch_asset_depreciation_entry')
    expect(err.message).toMatch(/is committed but could not be reloaded/)
    expect(updates()).toHaveLength(0)
    expect(committedEvents()).toHaveLength(0)
  })

  it('retries the reload once before giving up', async () => {
    const { supabase } = makeSupabase({
      rpc: { data: [{ voucher_number: 7, schedule_id: 'sched-1' }] },
      journalEntries: [{ error: { message: 'blip' } }, { data: POSTED }],
    })

    const result = await createAssetDepreciationEntry(supabase, 'co', 'user-1', INPUT, LINK)
    expect(result.entry).toEqual(POSTED)
  })

  it('treats an rpc that reports no schedule row as a failure, not as a posting', async () => {
    const { supabase } = makeSupabase({ rpc: { data: [] } })
    await expect(
      createAssetDepreciationEntry(supabase, 'co', 'user-1', INPUT, LINK),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)
  })
})
