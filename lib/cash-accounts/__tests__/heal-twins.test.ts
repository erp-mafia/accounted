import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mockLedgersWithPostedLines = vi.fn()
const mockFindMovable = vi.fn()
const mockRebind = vi.fn()
const mockSetPrimary = vi.fn()
const mockUpsertFromPsd2 = vi.fn()

vi.mock('@/lib/cash-accounts/service', async (importActual) => {
  const actual = await importActual<typeof import('../service')>()
  return {
    ...actual,
    ledgersWithPostedLines: (...args: unknown[]) => mockLedgersWithPostedLines(...args),
    findMovableTransactionIds: (...args: unknown[]) => mockFindMovable(...args),
    rebindMovableTransactions: (...args: unknown[]) => mockRebind(...args),
    setPrimary: (...args: unknown[]) => mockSetPrimary(...args),
    upsertFromPsd2: (...args: unknown[]) => mockUpsertFromPsd2(...args),
  }
})

const mockAppend = vi.fn()
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistoryWithClient: (...args: unknown[]) => mockAppend(...args),
}))

import { healTwinCashAccounts as heal } from '../heal-twins'

const ACTOR = { type: 'user' as const, id: 'user-1', label: 'test' }

/** A write run the way the script does it: dry run first, then echo its fingerprint. */
async function healTwinCashAccounts(
  supabase: SupabaseClient,
  companyId: string,
  options: { dryRun: boolean },
) {
  const plan = await heal(supabase, companyId, { dryRun: true })
  if (options.dryRun) return plan
  return heal(supabase, companyId, { dryRun: false, expectedFingerprint: plan.fingerprint, actor: ACTOR })
}

const COMPANY = 'company-1'
const IBAN = 'SE4550000000058398257466'

type Row = Record<string, unknown> & { id: string }

const cashRow = (overrides: Partial<Row> & { id: string; ledger_account: string }): Row => ({
  company_id: COMPANY,
  bank_connection_id: 'conn-1',
  external_uid: `uid-${overrides.id}`,
  iban: IBAN,
  bban: null,
  name: null,
  currency: 'SEK',
  balance: 100,
  available_balance: 100,
  balance_updated_at: '2026-09-01T00:00:00Z',
  enabled: true,
  is_primary: false,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
})

interface Stub {
  rows: Row[]
  connections: Array<{ id: string; status: string; accounts_data: Array<Record<string, unknown>> }>
  /** Transactions bound per cash account id (total, incl. movable). */
  txCount: Record<string, number>
  writes: Array<{ table: string; op: 'update' | 'delete'; payload?: unknown; filters: Record<string, unknown> }>
}

function makeSupabase(stub: Stub): SupabaseClient {
  return {
    from: vi.fn((table: string) => {
      const filters: Record<string, unknown> = {}
      let op: 'select' | 'update' | 'delete' = 'select'
      let payload: unknown
      let head = false
      const chain: Record<string, unknown> = {}
      chain.select = vi.fn((_cols: string, opts?: { head?: boolean }) => {
        head = opts?.head === true
        return chain
      })
      chain.update = vi.fn((p: unknown) => {
        op = 'update'
        payload = p
        return chain
      })
      chain.delete = vi.fn(() => {
        op = 'delete'
        return chain
      })
      chain.eq = vi.fn((col: string, value: unknown) => {
        filters[col] = value
        return chain
      })
      chain.then = (onFulfilled: (value: unknown) => unknown) => {
        if (op !== 'select') {
          stub.writes.push({ table, op, payload, filters })
          return Promise.resolve({ data: null, error: null }).then(onFulfilled)
        }
        if (table === 'cash_accounts') return Promise.resolve({ data: stub.rows, error: null }).then(onFulfilled)
        if (table === 'bank_connections') {
          return Promise.resolve({ data: stub.connections, error: null }).then(onFulfilled)
        }
        if (table === 'transactions' && head) {
          const count = stub.txCount[filters.cash_account_id as string] ?? 0
          return Promise.resolve({ count, error: null }).then(onFulfilled)
        }
        return Promise.resolve({ data: [], error: null }).then(onFulfilled)
      }
      return chain
    }),
  } as unknown as SupabaseClient
}

const activeConn = (uids: Array<[uid: string, ledger: string]>) => ({
  id: 'conn-1',
  status: 'active',
  accounts_data: uids.map(([uid, ledger_account]) => ({ uid, ledger_account, name: 'Företagskonto' })),
})

beforeEach(() => {
  vi.clearAllMocks()
  mockLedgersWithPostedLines.mockResolvedValue(new Set<string>())
  mockFindMovable.mockResolvedValue([])
  mockRebind.mockResolvedValue(0)
  mockSetPrimary.mockResolvedValue(undefined)
  mockUpsertFromPsd2.mockResolvedValue(undefined)
  mockAppend.mockResolvedValue('event-1')
})

describe('healTwinCashAccounts', () => {
  // The classic shape: 1930 has the history, the renewal minted 1931 with the
  // live uid, and accounts_data routes every sync onto 1931.
  const classic = (): Stub => ({
    rows: [
      cashRow({ id: 'r1930', ledger_account: '1930', is_primary: true }),
      cashRow({ id: 'r1931', ledger_account: '1931', created_at: '2026-05-01T00:00:00Z' }),
    ],
    connections: [activeConn([['uid-r1931', '1931']])],
    txCount: { r1931: 6 },
    writes: [],
  })

  it('returns no groups for a company without twins', async () => {
    const stub = classic()
    stub.rows = [stub.rows[0]]
    const result = await healTwinCashAccounts(makeSupabase(stub), COMPANY, { dryRun: false })
    expect(result.groups).toEqual([])
    expect(mockLedgersWithPostedLines).not.toHaveBeenCalled()
  })

  it('does not treat a same-IBAN row in another currency as a twin', async () => {
    const stub = classic()
    stub.rows[1].currency = 'EUR'
    const result = await healTwinCashAccounts(makeSupabase(stub), COMPANY, { dryRun: false })
    expect(result.groups).toEqual([])
  })

  it('dry run reports the plan and writes nothing', async () => {
    const stub = classic()
    mockLedgersWithPostedLines.mockResolvedValue(new Set(['1930']))
    mockFindMovable.mockResolvedValue(['t1', 't2', 't3', 't4', 't5'])

    const result = await healTwinCashAccounts(makeSupabase(stub), COMPANY, { dryRun: true })

    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({
      skipped: null,
      keeper: { id: 'r1930', ledger_account: '1930' },
      liveRowId: 'r1931',
      accountsDataLedgerFrom: '1931',
      retired: [{ id: 'r1931', movable: 5, staying: 1, outcome: 'rekeyed-into-keeper' }],
    })
    expect(stub.writes).toEqual([])
    expect(mockUpsertFromPsd2).not.toHaveBeenCalled()
    expect(mockRebind).not.toHaveBeenCalled()
    expect(mockSetPrimary).not.toHaveBeenCalled()
  })

  it('re-points accounts_data at the keeper ledger, then re-keys the keeper to the live uid', async () => {
    const stub = classic()
    mockLedgersWithPostedLines.mockResolvedValue(new Set(['1930']))

    await healTwinCashAccounts(makeSupabase(stub), COMPANY, { dryRun: false })

    expect(stub.writes).toEqual([
      {
        table: 'bank_connections',
        op: 'update',
        // Every other field of the entry survives the rewrite.
        payload: { accounts_data: [{ uid: 'uid-r1931', ledger_account: '1930', name: 'Företagskonto' }] },
        filters: { id: 'conn-1', company_id: COMPANY },
      },
    ])
    expect(mockUpsertFromPsd2).toHaveBeenCalledTimes(1)
    expect(mockUpsertFromPsd2.mock.calls[0][2]).toMatchObject({
      bank_connection_id: 'conn-1',
      external_uid: 'uid-r1931',
      ledger_account: '1930',
      reuse_cash_account_id: 'r1930',
      iban: IBAN,
      balance: 100,
    })
    // accounts_data first: from that write on, the next sync lands on 1930.
    expect(stub.writes[0].table).toBe('bank_connections')
  })

  it('skips a group whose posted lines sit on both ledgers', async () => {
    const stub = classic()
    mockLedgersWithPostedLines.mockResolvedValue(new Set(['1930', '1931']))

    const result = await healTwinCashAccounts(makeSupabase(stub), COMPANY, { dryRun: false })

    expect(result.groups[0]).toMatchObject({ skipped: 'split-ledgers', keeper: null, postedLedgers: ['1930', '1931'] })
    expect(stub.writes).toEqual([])
    expect(mockUpsertFromPsd2).not.toHaveBeenCalled()
  })

  it('skips a group with no row on an active connection', async () => {
    const stub = classic()
    stub.connections[0].status = 'expired'

    const result = await healTwinCashAccounts(makeSupabase(stub), COMPANY, { dryRun: false })

    expect(result.groups[0].skipped).toBe('no-live-row')
    expect(stub.writes).toEqual([])
  })

  it('skips a group where accounts_data lists both uids', async () => {
    const stub = classic()
    stub.connections = [activeConn([['uid-r1930', '1930'], ['uid-r1931', '1931']])]

    const result = await healTwinCashAccounts(makeSupabase(stub), COMPANY, { dryRun: false })

    expect(result.groups[0].skipped).toBe('several-live-rows')
    expect(stub.writes).toEqual([])
  })

  it('skips a group whose sync routing points at a ledger outside the group', async () => {
    const stub = classic()
    stub.connections = [activeConn([['uid-r1931', '1940']])]
    mockLedgersWithPostedLines.mockResolvedValue(new Set(['1930']))

    const result = await healTwinCashAccounts(makeSupabase(stub), COMPANY, { dryRun: false })

    expect(result.groups[0]).toMatchObject({ skipped: 'routing-outside-group', accountsDataLedgerFrom: '1940' })
    expect(stub.writes).toEqual([])
    expect(mockUpsertFromPsd2).not.toHaveBeenCalled()
  })

  it('keeps the live row when it already has the history and retires the stale twin', async () => {
    const stub: Stub = {
      rows: [
        cashRow({ id: 'r1930', ledger_account: '1930' }),
        cashRow({ id: 'r1931', ledger_account: '1931', is_primary: true }),
      ],
      connections: [activeConn([['uid-r1930', '1930']])],
      txCount: {},
      writes: [],
    }
    mockLedgersWithPostedLines.mockResolvedValue(new Set(['1930']))

    const result = await healTwinCashAccounts(makeSupabase(stub), COMPANY, { dryRun: false })

    expect(result.groups[0].retired).toEqual([
      { id: 'r1931', ledger_account: '1931', movable: 0, staying: 0, outcome: 'deleted' },
    ])
    expect(mockUpsertFromPsd2).not.toHaveBeenCalled()
    expect(mockRebind).toHaveBeenCalledWith(expect.anything(), COMPANY, 'r1931', 'r1930')
    expect(stub.writes).toEqual([
      { table: 'cash_accounts', op: 'delete', payload: undefined, filters: { id: 'r1931', company_id: COMPANY } },
    ])
    // The retired twin was primary: the flag moves to the keeper.
    expect(mockSetPrimary).toHaveBeenCalledWith(expect.anything(), COMPANY, 'r1930')
  })

  it('demotes a stale connection-held twin that still holds booked transactions', async () => {
    const stub: Stub = {
      rows: [cashRow({ id: 'r1930', ledger_account: '1930' }), cashRow({ id: 'r1931', ledger_account: '1931' })],
      connections: [activeConn([['uid-r1930', '1930']])],
      txCount: { r1931: 2 },
      writes: [],
    }
    mockLedgersWithPostedLines.mockResolvedValue(new Set(['1930']))

    const result = await healTwinCashAccounts(makeSupabase(stub), COMPANY, { dryRun: false })

    expect(result.groups[0].retired[0]).toMatchObject({ staying: 2, outcome: 'demoted-to-manual' })
    expect(stub.writes).toEqual([
      {
        table: 'cash_accounts',
        op: 'update',
        payload: { bank_connection_id: null, external_uid: null },
        filters: { id: 'r1931', company_id: COMPANY },
      },
    ])
    expect(mockSetPrimary).not.toHaveBeenCalled()
  })

  it('never deletes a twin that is already a manual row', async () => {
    const stub: Stub = {
      rows: [
        cashRow({ id: 'r1930', ledger_account: '1930' }),
        cashRow({ id: 'r1940', ledger_account: '1940', bank_connection_id: null, external_uid: null }),
      ],
      connections: [activeConn([['uid-r1930', '1930']])],
      txCount: {},
      writes: [],
    }
    mockLedgersWithPostedLines.mockResolvedValue(new Set(['1930']))

    const result = await healTwinCashAccounts(makeSupabase(stub), COMPANY, { dryRun: false })

    expect(result.groups[0].retired[0].outcome).toBe('kept-manual')
    expect(mockRebind).toHaveBeenCalledWith(expect.anything(), COMPANY, 'r1940', 'r1930')
    expect(stub.writes).toEqual([])
  })

  it('aborts before any write when the plan changed since the reviewed dry run', async () => {
    const stub = classic()
    mockLedgersWithPostedLines.mockResolvedValue(new Set(['1930']))
    const supabase = makeSupabase(stub)
    const reviewed = await heal(supabase, COMPANY, { dryRun: true })
    // A sync lands one more movable transaction on the twin in between.
    mockFindMovable.mockResolvedValue(['t-new'])

    await expect(
      heal(supabase, COMPANY, { dryRun: false, expectedFingerprint: reviewed.fingerprint, actor: ACTOR }),
    ).rejects.toThrow(/plan changed/)

    expect(stub.writes).toEqual([])
    expect(mockUpsertFromPsd2).not.toHaveBeenCalled()
    expect(mockSetPrimary).not.toHaveBeenCalled()
    expect(mockAppend).not.toHaveBeenCalled()
  })

  it('records one behandlingshistorik event per merged group, without the IBAN', async () => {
    const stub = classic()
    mockLedgersWithPostedLines.mockResolvedValue(new Set(['1930']))

    await healTwinCashAccounts(makeSupabase(stub), COMPANY, { dryRun: false })

    expect(mockAppend).toHaveBeenCalledTimes(1)
    const event = mockAppend.mock.calls[0][1]
    expect(event).toMatchObject({
      companyId: COMPANY,
      aggregateId: 'r1930',
      eventType: 'CashAccountTwinsMerged',
      actor: ACTOR,
      payload: {
        keeper: { id: 'r1930', ledger_account: '1930' },
        sync_ledger_before: '1931',
        sync_ledger_after: '1930',
        bank_connection_id: 'conn-1',
      },
    })
    expect(JSON.stringify(event.payload)).not.toContain(IBAN)
  })

  it('hands the primary flag over before it retires a stale primary row', async () => {
    const stub: Stub = {
      rows: [
        cashRow({ id: 'r1930', ledger_account: '1930' }),
        cashRow({ id: 'r1931', ledger_account: '1931', is_primary: true }),
      ],
      connections: [activeConn([['uid-r1930', '1930']])],
      txCount: {},
      writes: [],
    }
    mockLedgersWithPostedLines.mockResolvedValue(new Set(['1930']))
    mockSetPrimary.mockImplementation(async () => {
      // Nothing has been retired yet when the flag moves.
      expect(stub.writes).toEqual([])
    })

    await healTwinCashAccounts(makeSupabase(stub), COMPANY, { dryRun: false })

    expect(mockSetPrimary).toHaveBeenCalledTimes(1)
    expect(stub.writes.map((w) => w.op)).toEqual(['delete'])
  })
})
