/**
 * runConnectionSync is the one sync behind "Synka nu", the initial backfill,
 * the agent-triggered sync and the cron. These pin what every door now
 * shares: the SIE-overlap guard, the fetch options, the totals and dates, the
 * post-sync sweep and the persisted result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StoredAccount } from '../../types'

vi.mock('../sync', () => ({ syncAccountTransactions: vi.fn() }))
vi.mock('@/lib/bank-sync/persist-sync-result', () => ({ persistBankSyncResult: vi.fn() }))
vi.mock('@/lib/reconciliation/unattended-sweep', () => ({
  runUnattendedReconciliationSweep: vi.fn(),
  toSweepSummary: vi.fn(() => ({ summary: true })),
}))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn() } }))

import { syncAccountTransactions } from '../sync'
import { persistBankSyncResult } from '@/lib/bank-sync/persist-sync-result'
import { runUnattendedReconciliationSweep } from '@/lib/reconciliation/unattended-sweep'
import { eventBus } from '@/lib/events/bus'
import { INITIAL_SYNC_TIMEOUT } from '@/lib/bank-sync/initial-sync-error'
import { runConnectionSync, type ConnectionSyncInput } from '../run-connection-sync'

const mockSync = vi.mocked(syncAccountTransactions)
const mockPersist = vi.mocked(persistBankSyncResult)
const mockSweep = vi.mocked(runUnattendedReconciliationSweep)
const mockEmit = vi.mocked(eventBus.emit)

const ACCOUNTS = [
  { uid: 'acc-1', ledger_account: '1930' },
  { uid: 'acc-2', ledger_account: '1931' },
] as unknown as StoredAccount[]

function input(supabase: unknown, overrides: Partial<ConnectionSyncInput> = {}): ConnectionSyncInput {
  return {
    supabase: supabase as SupabaseClient,
    companyId: 'company-1',
    userId: 'user-1',
    connection: { id: 'conn-1', session_id: 'session-1' },
    accounts: ACCOUNTS,
    fromDate: '2026-07-01',
    toDate: '2026-10-01',
    lookbackDays: 92,
    startedAt: '2026-10-01T10:00:00.000Z',
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  }
}

const result = (overrides: Record<string, unknown> = {}) => ({
  imported: 2,
  duplicates: 1,
  errors: 0,
  requestedFromDate: '2026-07-01',
  historyNarrowed: false,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockSweep.mockResolvedValue({ applied: 3, skippedBelowThreshold: 1, accounts: [] } as never)
})

describe('runConnectionSync', () => {
  it('fetches every account with the deepest history for a long window and persists the result', async () => {
    const { supabase } = createTableMockSupabase({ sie_imports: { data: null } })
    mockSync
      .mockResolvedValueOnce(result({ returnedMinBookingDate: '2026-07-03', returnedMaxBookingDate: '2026-09-30' }) as never)
      .mockResolvedValueOnce(result({ imported: 5, returnedMinBookingDate: '2026-07-02', returnedMaxBookingDate: '2026-09-29' }) as never)

    const outcome = await runConnectionSync(input(supabase))

    expect(mockSync).toHaveBeenCalledTimes(2)
    expect(mockSync).toHaveBeenCalledWith(
      supabase, 'company-1', 'user-1', 'conn-1', ACCOUNTS[0], '2026-07-01', '2026-10-01', undefined,
      { strategy: 'longest' },
    )
    expect(outcome).toMatchObject({
      imported: 7,
      duplicates: 2,
      returnedMin: '2026-07-02',
      returnedMax: '2026-09-30',
      historyFrom: null,
      sieOverlap: false,
      autoMatched: 0,
    })
    expect(mockSweep).not.toHaveBeenCalled()
    expect(mockPersist).toHaveBeenCalledWith(supabase, expect.objectContaining({
      companyId: 'company-1',
      connectionId: 'conn-1',
      sessionId: 'session-1',
      startedAt: '2026-10-01T10:00:00.000Z',
      accounts: ACCOUNTS,
    }))
    expect(mockPersist.mock.calls[0][1]).not.toHaveProperty('initialSync')
  })

  it('keeps the default strategy for a short incremental window', async () => {
    const { supabase } = createTableMockSupabase({ sie_imports: { data: null } })
    mockSync.mockResolvedValue(result() as never)

    await runConnectionSync(input(supabase, { lookbackDays: 7 }))

    expect(mockSync.mock.calls[0][8]).toEqual({})
  })

  it('hands the person who asked to every account read, and nobody when none did', async () => {
    const { supabase } = createTableMockSupabase({ sie_imports: { data: null } })
    mockSync.mockResolvedValue(result() as never)
    const signer = { personalNumber: null, ipAddress: '203.0.113.7', userAgent: 'Mozilla/5.0 test' }

    await runConnectionSync(input(supabase, { lookbackDays: 7, signer }))
    expect(mockSync.mock.calls[0][8]).toEqual({ signer })
    expect(mockSync.mock.calls[1][8]).toEqual({ signer })

    mockSync.mockClear()
    await runConnectionSync(input(supabase, { lookbackDays: 7 }))
    expect(mockSync.mock.calls[0][8]).toEqual({})
  })

  it('records the window and what the bank returned on a first sync', async () => {
    const { supabase } = createTableMockSupabase({ sie_imports: { data: null } })
    mockSync.mockResolvedValue(result({ returnedMinBookingDate: '2026-07-05', returnedMaxBookingDate: '2026-09-30' }) as never)

    await runConnectionSync(input(supabase, { firstSync: true, lookbackDays: 7 }))

    expect(mockSync.mock.calls[0][8]).toEqual({ strategy: 'longest' })
    expect(mockPersist.mock.calls[0][1].initialSync).toEqual({
      requestedFrom: '2026-07-01',
      returnedMin: '2026-07-05',
      returnedMax: '2026-09-30',
      lookbackDays: 7,
    })
  })

  // PH 195: Enable Banking answered a Swedbank account's first import with
  // 100 pages of empty transactions, each with a continuation key. The read
  // stopped at the cap, and the first import was stamped complete with
  // nothing in it, so it was never asked for again.
  it('leaves a first sync the bank had not finished owed, storing what came', async () => {
    const { supabase } = createTableMockSupabase({ sie_imports: { data: null } })
    const log = { info: vi.fn(), warn: vi.fn() }
    mockSync
      .mockResolvedValueOnce(result({ imported: 0, duplicates: 0, truncated: true }) as never)
      .mockResolvedValueOnce(result({ returnedMinBookingDate: '2026-07-05', returnedMaxBookingDate: '2026-09-30' }) as never)

    const outcome = await runConnectionSync(input(supabase, { firstSync: true, log }))

    expect(outcome.truncated).toBe(true)
    expect(outcome.imported).toBe(2)
    // The rows and balances are persisted, the first import is not completed.
    expect(mockPersist).toHaveBeenCalledTimes(1)
    expect(mockPersist.mock.calls[0][1]).not.toHaveProperty('initialSync')
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('window is incomplete'),
      expect.objectContaining({ connectionId: 'conn-1', firstSync: true }),
    )
  })

  it('reports an incremental sync read to its end as not truncated', async () => {
    const { supabase } = createTableMockSupabase({ sie_imports: { data: null } })
    mockSync.mockResolvedValue(result() as never)

    const outcome = await runConnectionSync(input(supabase, { lookbackDays: 7 }))

    expect(outcome.truncated).toBe(false)
  })

  it('links instead of booking over a completed SIE import, sweeping from the oldest returned date', async () => {
    const { supabase, payloads } = createTableMockSupabase({
      sie_imports: { data: { id: 'sie-1' } },
      bank_connections: { data: null },
    })
    mockSync.mockResolvedValue(result({ returnedMinBookingDate: '2026-06-20' }) as never)

    const outcome = await runConnectionSync(input(supabase))

    expect(mockSync.mock.calls[0][8]).toEqual({ skipAutoCategorization: true, strategy: 'longest' })
    // The fetched accounts only, from the oldest date the bank returned.
    expect(mockSweep).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', {
      dateFrom: '2026-06-20',
      dateTo: '2026-10-01',
      ledgerAccounts: ['1930', '1931'],
    })
    expect(payloads('bank_connections', 'update')).toEqual([{ last_sie_sweep: { summary: true } }])
    expect(outcome).toMatchObject({ sieOverlap: true, autoMatched: 3 })
  })

  it('stores a viewer sync raw: no categorising and no sweep', async () => {
    const { supabase } = createTableMockSupabase({ sie_imports: { data: { id: 'sie-1' } } })
    mockSync.mockResolvedValue(result() as never)

    await runConnectionSync(input(supabase, { rawInsertOnly: true }))

    expect(mockSync.mock.calls[0][8]).toEqual({ skipAutoCategorization: true, rawInsertOnly: true, strategy: 'longest' })
    expect(mockSweep).not.toHaveBeenCalled()
  })

  it('still persists the sync when the sweep fails', async () => {
    const { supabase } = createTableMockSupabase({ sie_imports: { data: { id: 'sie-1' } } })
    mockSync.mockResolvedValue(result() as never)
    mockSweep.mockRejectedValue(new Error('sweep down'))

    const outcome = await runConnectionSync(input(supabase))

    expect(outcome.autoMatched).toBe(0)
    expect(mockPersist).toHaveBeenCalled()
  })

  it('names the date every account is complete from when a bank narrowed the window', async () => {
    const { supabase } = createTableMockSupabase({ sie_imports: { data: null } })
    mockSync
      .mockResolvedValueOnce(result({ historyNarrowed: true, effectiveFromDate: '2026-08-01' }) as never)
      .mockResolvedValueOnce(result({ historyNarrowed: true, effectiveFromDate: '2026-08-15' }) as never)

    const outcome = await runConnectionSync(input(supabase))

    expect(outcome.historyFrom).toBe('2026-08-15')
  })

  it('gives up on a slow bank with the initial-sync timeout and persists nothing', async () => {
    vi.useFakeTimers()
    try {
      const { supabase } = createTableMockSupabase({ sie_imports: { data: null } })
      mockSync.mockReturnValue(new Promise(() => {}) as never)

      const run = runConnectionSync(input(supabase, { fetchTimeoutMs: 60_000 }))
      const expectation = expect(run).rejects.toThrow(INITIAL_SYNC_TIMEOUT)
      await vi.advanceTimersByTimeAsync(60_000)
      await expectation
      expect(mockPersist).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws a fetch failure to the door, unpersisted', async () => {
    const { supabase } = createTableMockSupabase({ sie_imports: { data: null } })
    mockSync.mockRejectedValue(new Error('bank down'))

    await expect(runConnectionSync(input(supabase))).rejects.toThrow('bank down')
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockEmit).not.toHaveBeenCalled()
  })
})

/** The rows the mock database holds, answered for the ids a read asks for. */
function storedRows(rows: { id: string }[]) {
  return (chainCalls: { method: string; args: unknown[] }[]) => {
    const ids = chainCalls.find((c) => c.method === 'in')?.args[1] as string[] | undefined
    return { data: rows.filter((row) => ids?.includes(row.id)) }
  }
}

describe('runConnectionSync: transaction.synced', () => {
  const ROWS = [{ id: 'tx-1' }, { id: 'tx-2' }, { id: 'tx-3' }]

  it('announces the rows every account inserted, once, read by their ids after the persist', async () => {
    const { supabase, findCalls } = createTableMockSupabase({ sie_imports: { data: null }, transactions: storedRows(ROWS) })
    mockSync
      .mockResolvedValueOnce(result({ imported: 2, transactionIds: ['tx-1', 'tx-2'] }) as never)
      .mockResolvedValueOnce(result({ imported: 1, transactionIds: ['tx-3'] }) as never)
    mockEmit.mockImplementationOnce(async () => {
      // The rows are announced as the persisted sync left them.
      expect(mockPersist).toHaveBeenCalledTimes(1)
    })

    await runConnectionSync(input(supabase))

    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit).toHaveBeenCalledWith({
      type: 'transaction.synced',
      payload: { transactions: ROWS, userId: 'user-1', companyId: 'company-1' },
    })
    expect(findCalls('transactions', 'eq')).toEqual([['company_id', 'company-1']])
  })

  it('announces nothing when no account inserted a row', async () => {
    const { supabase, tables } = createTableMockSupabase({ sie_imports: { data: null } })
    mockSync.mockResolvedValue(result({ imported: 0, duplicates: 4, transactionIds: [] }) as never)

    await runConnectionSync(input(supabase))

    expect(mockEmit).not.toHaveBeenCalled()
    expect(tables()).not.toContain('transactions')
  })

  it('announces nothing for a viewer, whose rows are stored raw', async () => {
    const { supabase } = createTableMockSupabase({ sie_imports: { data: null }, transactions: storedRows(ROWS) })
    mockSync.mockResolvedValue(result({ transactionIds: ['tx-1'] }) as never)

    await runConnectionSync(input(supabase, { rawInsertOnly: true }))

    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('announces nothing when the persist refuses the result', async () => {
    const { supabase } = createTableMockSupabase({ sie_imports: { data: null }, transactions: storedRows(ROWS) })
    mockSync.mockResolvedValue(result({ transactionIds: ['tx-1'] }) as never)
    mockPersist.mockRejectedValueOnce(new Error('obsolete'))

    await expect(runConnectionSync(input(supabase))).rejects.toThrow('obsolete')
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('reads a large first import in chunks and still announces it once', async () => {
    const many = Array.from({ length: 450 }, (_, i) => ({ id: `tx-${i}` }))
    const { supabase, findCalls } = createTableMockSupabase({ sie_imports: { data: null }, transactions: storedRows(many) })
    mockSync.mockResolvedValue(result({ imported: 450, transactionIds: many.map((row) => row.id) }) as never)

    await runConnectionSync(input(supabase, { accounts: [ACCOUNTS[0]] }))

    expect(findCalls('transactions', 'in').map((args) => (args[1] as string[]).length)).toEqual([200, 200, 50])
    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit.mock.calls[0][0]).toMatchObject({ payload: { transactions: many } })
  })

  it('keeps the sync when the rows cannot be read back: logged, not announced, not thrown', async () => {
    const { supabase } = createTableMockSupabase({
      sie_imports: { data: null },
      transactions: { data: null, error: { message: 'read failed' } },
    })
    const log = { info: vi.fn(), warn: vi.fn() }
    mockSync.mockResolvedValue(result({ transactionIds: ['tx-1'] }) as never)

    const outcome = await runConnectionSync(input(supabase, { log }))

    expect(outcome.imported).toBe(4)
    expect(mockEmit).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('not announced'),
      expect.objectContaining({ connectionId: 'conn-1', message: 'read failed' }),
    )
  })
})
