import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// syncMappedAccounts is exercised by its own suite — here it only needs to be
// observable so allocatePsd2LedgerAccount's chart-ensure call can be asserted.
const { mockSyncMappedAccounts } = vi.hoisted(() => ({
  mockSyncMappedAccounts: vi.fn(),
}))
vi.mock('@/lib/import/account-sync', () => ({
  syncMappedAccounts: (...args: unknown[]) => mockSyncMappedAccounts(...args),
}))

import {
  findFreeLedgerAccount,
  allocatePsd2LedgerAccount,
  defaultLedgerForCurrency,
  getRevokedConnectionIds,
  upsertFromPsd2,
} from '../service'

type CashRow = { ledger_account: string; bank_connection_id: string | null }
type ConnRow = { id: string; status: string }

interface MakeSupabaseOpts {
  error?: { message: string } | null
  /** bank_connections rows for the status lookup. Missing ids = not revoked. */
  connections?: ConnRow[]
  connectionsError?: { message: string } | null
}

function makeSupabase(rows: CashRow[], opts: MakeSupabaseOpts = {}) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'bank_connections') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn((_col: string, ids: string[]) =>
            Promise.resolve(
              opts.connectionsError
                ? { data: null, error: opts.connectionsError }
                : {
                    data: (opts.connections ?? []).filter(c => ids.includes(c.id)),
                    error: null,
                  },
            ),
          ),
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn(() =>
          Promise.resolve({ data: opts.error ? null : rows, error: opts.error ?? null }),
        ),
      }
    }),
  } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSyncMappedAccounts.mockResolvedValue({
    created: 1,
    renamed: 0,
    renamedAccounts: [],
    renameFailed: 0,
    error: null,
  })
})

describe('defaultLedgerForCurrency', () => {
  it('maps the four known currencies and falls back to 1930', () => {
    expect(defaultLedgerForCurrency('SEK')).toBe('1930')
    expect(defaultLedgerForCurrency('eur')).toBe('1932')
    expect(defaultLedgerForCurrency('USD')).toBe('1933')
    expect(defaultLedgerForCurrency('GBP')).toBe('1934')
    expect(defaultLedgerForCurrency('NOK')).toBe('1930')
  })
})

describe('getRevokedConnectionIds', () => {
  it('returns only the ids whose connection is revoked', async () => {
    const supabase = makeSupabase([], {
      connections: [
        { id: 'conn-a', status: 'revoked' },
        { id: 'conn-b', status: 'active' },
      ],
    })
    const revoked = await getRevokedConnectionIds(supabase, 'c1', ['conn-a', 'conn-b'])
    expect(revoked).toEqual(new Set(['conn-a']))
  })

  it('returns an empty set without querying when no ids are given', async () => {
    const supabase = makeSupabase([])
    const revoked = await getRevokedConnectionIds(supabase, 'c1', [])
    expect(revoked.size).toBe(0)
    expect((supabase as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled()
  })

  it('treats every connection as active when the lookup fails (conservative)', async () => {
    const supabase = makeSupabase([], { connectionsError: { message: 'boom' } })
    const revoked = await getRevokedConnectionIds(supabase, 'c1', ['conn-a'])
    expect(revoked.size).toBe(0)
  })
})

describe('findFreeLedgerAccount', () => {
  it('returns the currency default when nothing holds it', async () => {
    const supabase = makeSupabase([])
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1930')
    expect(await findFreeLedgerAccount(supabase, 'c1', 'EUR')).toBe('1932')
  })

  it('returns the default when only a MANUAL row holds it (seed promotion)', async () => {
    // The seeded 1930 row has no bank connection — upsertFromPsd2 promotes it
    // in place, so the slot counts as free.
    const supabase = makeSupabase([{ ledger_account: '1930', bank_connection_id: null }])
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1930')
  })

  it('returns the default when it is held only by a REVOKED connection (issue #916)', async () => {
    // Disconnecting a bank releases its ledger claims. Rows orphaned before
    // that fix still point at the revoked connection; they must count as
    // manual holders so a reconnect lands back on 1930, not 1939.
    const supabase = makeSupabase(
      [{ ledger_account: '1930', bank_connection_id: 'conn-revoked' }],
      { connections: [{ id: 'conn-revoked', status: 'revoked' }] },
    )
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1930')
  })

  it('overflows to 1931 when a CONNECTED row holds the default', async () => {
    const supabase = makeSupabase([{ ledger_account: '1930', bank_connection_id: 'conn-1' }], {
      connections: [{ id: 'conn-1', status: 'active' }],
    })
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1931')
  })

  it('still overflows when the revoked-status lookup fails (conservative)', async () => {
    const supabase = makeSupabase(
      [{ ledger_account: '1930', bank_connection_id: 'conn-revoked' }],
      { connectionsError: { message: 'boom' } },
    )
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1931')
  })

  it('keeps revoked-held rows blocking OVERFLOW slots (like manual rows)', async () => {
    // The revoked-held row on 1931 keeps its history on that slot; handing the
    // slot to a different account would steal it via promote-in-place.
    const supabase = makeSupabase(
      [
        { ledger_account: '1930', bank_connection_id: 'conn-active' },
        { ledger_account: '1931', bank_connection_id: 'conn-revoked' },
      ],
      {
        connections: [
          { id: 'conn-active', status: 'active' },
          { id: 'conn-revoked', status: 'revoked' },
        ],
      },
    )
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1935')
  })

  it('never hands out another currency default as an overflow slot', async () => {
    const supabase = makeSupabase([
      { ledger_account: '1930', bank_connection_id: 'conn-1' },
      { ledger_account: '1931', bank_connection_id: 'conn-1' },
    ])
    // 1932/1933/1934 are reserved for EUR/USD/GBP — next free is 1935.
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1935')
  })

  it('does not steal a manual account on an overflow slot', async () => {
    const supabase = makeSupabase([
      { ledger_account: '1930', bank_connection_id: 'conn-1' },
      // Manual (e.g. SIE-imported) account on 1931 — promoting it would
      // silently repoint an unrelated account.
      { ledger_account: '1931', bank_connection_id: null },
    ])
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1935')
  })

  it('honors the exclude set for slots assigned earlier in the caller loop', async () => {
    const supabase = makeSupabase([])
    const exclude = new Set(['1930', '1931'])
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK', exclude)).toBe('1935')
  })

  it('returns null when every slot in 1931–1959 is taken', async () => {
    const rows: CashRow[] = [{ ledger_account: '1930', bank_connection_id: 'conn-1' }]
    for (let n = 1931; n <= 1959; n++) {
      rows.push({ ledger_account: String(n), bank_connection_id: 'conn-1' })
    }
    const supabase = makeSupabase(rows)
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBeNull()
  })

  it('returns null when the lookup fails', async () => {
    const supabase = makeSupabase([], { error: { message: 'boom' } })
    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBeNull()
  })
})

describe('allocatePsd2LedgerAccount', () => {
  it('allocates a slot and ensures it exists in the chart of accounts', async () => {
    const supabase = makeSupabase([{ ledger_account: '1930', bank_connection_id: 'conn-1' }])

    const ledger = await allocatePsd2LedgerAccount(supabase, 'c1', 'u1', {
      currency: 'SEK',
      accountName: 'Sparkonto',
    })

    expect(ledger).toBe('1931')
    expect(mockSyncMappedAccounts).toHaveBeenCalledTimes(1)
    const [, companyId, userId, mappings] = mockSyncMappedAccounts.mock.calls[0]
    expect(companyId).toBe('c1')
    expect(userId).toBe('u1')
    expect(mappings).toEqual([
      expect.objectContaining({
        sourceAccount: '1931',
        targetAccount: '1931',
        sourceName: 'Sparkonto',
      }),
    ])
  })

  it('uses a currency fallback name when the bank account has none', async () => {
    const supabase = makeSupabase([])

    await allocatePsd2LedgerAccount(supabase, 'c1', 'u1', { currency: 'EUR' })

    const [, , , mappings] = mockSyncMappedAccounts.mock.calls[0]
    expect(mappings[0].sourceName).toBe('Bankkonto EUR')
  })

  it('returns null when the chart sync fails — a slot that cannot be booked against is useless', async () => {
    mockSyncMappedAccounts.mockResolvedValue({
      created: 0,
      renamed: 0,
      renamedAccounts: [],
      renameFailed: 0,
      error: 'chart unavailable',
    })
    const supabase = makeSupabase([])

    expect(
      await allocatePsd2LedgerAccount(supabase, 'c1', 'u1', { currency: 'SEK' }),
    ).toBeNull()
  })

  it('returns null when no slot is free', async () => {
    const rows: CashRow[] = [{ ledger_account: '1930', bank_connection_id: 'conn-1' }]
    for (let n = 1931; n <= 1959; n++) {
      rows.push({ ledger_account: String(n), bank_connection_id: 'conn-1' })
    }
    const supabase = makeSupabase(rows)

    expect(
      await allocatePsd2LedgerAccount(supabase, 'c1', 'u1', { currency: 'SEK' }),
    ).toBeNull()
    expect(mockSyncMappedAccounts).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// upsertFromPsd2: promote-in-place + duplicate merge (issue #916)
// ---------------------------------------------------------------------------

interface UpsertStub {
  /** Row currently holding (company_id, ledger_account), if any. */
  holder?: { id: string; bank_connection_id: string | null } | null
  /** bank_connections rows for the revoked-status lookup. */
  connections?: ConnRow[]
  /** Existing row for (company_id, bank_connection_id, external_uid) on another ledger. */
  ownRow?: { id: string; is_primary: boolean } | null
  /** Whether the duplicate ownRow has linked transactions. */
  ownHasTransactions?: boolean
  upsertError?: { message: string } | null
  // Captured writes:
  updates: Array<{ payload: Record<string, unknown>; id: unknown }>
  deletes: unknown[]
  upserts: Array<Record<string, unknown>>
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>
  /** .eq() filters applied to the linked-transactions probe. */
  transactionFilters: Array<{ col: string; value: unknown }>
}

function makeUpsertStub(partial: Partial<UpsertStub> = {}): UpsertStub {
  return {
    updates: [],
    deletes: [],
    upserts: [],
    rpcCalls: [],
    transactionFilters: [],
    ...partial,
  }
}

function makeUpsertSupabase(stub: UpsertStub) {
  return {
    rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
      stub.rpcCalls.push({ fn, args })
      return Promise.resolve({ error: null })
    }),
    from: vi.fn((table: string) => {
      if (table === 'bank_connections') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn((_col: string, ids: string[]) =>
            Promise.resolve({
              data: (stub.connections ?? []).filter(c => ids.includes(c.id)),
              error: null,
            }),
          ),
        }
      }
      if (table === 'transactions') {
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn((col: string, value: unknown) => {
            stub.transactionFilters.push({ col, value })
            return chain
          }),
          limit: vi.fn(() =>
            Promise.resolve({
              data: stub.ownHasTransactions ? [{ id: 'tx-1' }] : [],
              error: null,
            }),
          ),
        }
        return chain
      }
      // cash_accounts
      return {
        select: vi.fn((cols: string) => {
          const chain = {
            eq: vi.fn(() => chain),
            neq: vi.fn(() => chain),
            maybeSingle: vi.fn(() => {
              // Holder lookup selects bank_connection_id; duplicate lookup
              // selects is_primary. Route by the requested columns.
              if (cols.includes('bank_connection_id')) {
                return Promise.resolve({ data: stub.holder ?? null, error: null })
              }
              return Promise.resolve({ data: stub.ownRow ?? null, error: null })
            }),
          }
          return chain
        }),
        update: vi.fn((payload: Record<string, unknown>) => ({
          eq: vi.fn((_col: string, id: unknown) => {
            stub.updates.push({ payload, id })
            const result = Promise.resolve({ data: null, error: null })
            return {
              select: vi.fn(() => Promise.resolve({ data: [{ id }], error: null })),
              then: result.then.bind(result),
              catch: result.catch.bind(result),
            }
          }),
        })),
        delete: vi.fn(() => ({
          eq: vi.fn((_col: string, id: unknown) => {
            stub.deletes.push(id)
            return Promise.resolve({ error: null })
          }),
        })),
        upsert: vi.fn((payload: Record<string, unknown>) => {
          stub.upserts.push(payload)
          return Promise.resolve({ error: stub.upsertError ?? null })
        }),
      }
    }),
  } as unknown as SupabaseClient
}

const UPSERT_INPUT = {
  bank_connection_id: 'conn-new',
  external_uid: 'uid-1',
  currency: 'SEK',
  ledger_account: '1930',
}

describe('upsertFromPsd2', () => {
  it('plain-upserts when no row holds the target ledger', async () => {
    const stub = makeUpsertStub({ holder: null })
    await upsertFromPsd2(makeUpsertSupabase(stub), 'c1', UPSERT_INPUT)

    expect(stub.upserts).toHaveLength(1)
    expect(stub.upserts[0]).toMatchObject({
      company_id: 'c1',
      bank_connection_id: 'conn-new',
      external_uid: 'uid-1',
      ledger_account: '1930',
    })
    expect(stub.updates).toHaveLength(0)
  })

  it('promotes a MANUAL holder row in place (seed row or demoted-on-disconnect row)', async () => {
    const stub = makeUpsertStub({ holder: { id: 'row-manual', bank_connection_id: null } })
    await upsertFromPsd2(makeUpsertSupabase(stub), 'c1', UPSERT_INPUT)

    expect(stub.updates).toHaveLength(1)
    expect(stub.updates[0].id).toBe('row-manual')
    expect(stub.updates[0].payload).toMatchObject({
      bank_connection_id: 'conn-new',
      external_uid: 'uid-1',
      ledger_account: '1930',
    })
    expect(stub.upserts).toHaveLength(0)
  })

  it('promotes a holder owned by a REVOKED connection (orphan self-heal, issue #916)', async () => {
    const stub = makeUpsertStub({
      holder: { id: 'row-old', bank_connection_id: 'conn-old' },
      connections: [{ id: 'conn-old', status: 'revoked' }],
    })
    await upsertFromPsd2(makeUpsertSupabase(stub), 'c1', UPSERT_INPUT)

    // The orphaned row keeps its id (transaction links survive) and is
    // re-bound to the new connection on its original ledger account.
    expect(stub.updates).toHaveLength(1)
    expect(stub.updates[0].id).toBe('row-old')
    expect(stub.updates[0].payload).toMatchObject({
      bank_connection_id: 'conn-new',
      external_uid: 'uid-1',
      ledger_account: '1930',
    })
    expect(stub.upserts).toHaveLength(0)
    expect(stub.deletes).toHaveLength(0)
  })

  it('does NOT promote a holder owned by an ACTIVE foreign connection', async () => {
    const stub = makeUpsertStub({
      holder: { id: 'row-other', bank_connection_id: 'conn-other' },
      connections: [{ id: 'conn-other', status: 'active' }],
    })
    await upsertFromPsd2(makeUpsertSupabase(stub), 'c1', UPSERT_INPUT)

    // Falls through to the plain upsert; the DB unique constraint is the
    // final arbiter for a genuine conflict.
    expect(stub.updates).toHaveLength(0)
    expect(stub.upserts).toHaveLength(1)
  })

  it('routes a holder owned by the SAME connection through the plain upsert', async () => {
    const stub = makeUpsertStub({
      holder: { id: 'row-self', bank_connection_id: 'conn-new' },
    })
    await upsertFromPsd2(makeUpsertSupabase(stub), 'c1', UPSERT_INPUT)

    expect(stub.updates).toHaveLength(0)
    expect(stub.upserts).toHaveLength(1)
  })

  it('deletes an empty duplicate row for the same connection+uid before promoting', async () => {
    // Stuck-user recovery: the reconnect callback mirrored uid-1 onto 1939
    // while 1930 was wrongly blocked. On remap to 1930 the empty 1939
    // duplicate is removed and the orphaned holder is promoted, freeing 1939.
    const stub = makeUpsertStub({
      holder: { id: 'row-old', bank_connection_id: 'conn-old' },
      connections: [{ id: 'conn-old', status: 'revoked' }],
      ownRow: { id: 'row-dup', is_primary: false },
      ownHasTransactions: false,
    })
    await upsertFromPsd2(makeUpsertSupabase(stub), 'c1', UPSERT_INPUT)

    expect(stub.deletes).toEqual(['row-dup'])
    expect(stub.updates).toHaveLength(1)
    expect(stub.updates[0].id).toBe('row-old')
    expect(stub.rpcCalls).toHaveLength(0)
  })

  it('demotes (not deletes) a duplicate that has linked transactions', async () => {
    const stub = makeUpsertStub({
      holder: { id: 'row-old', bank_connection_id: 'conn-old' },
      connections: [{ id: 'conn-old', status: 'revoked' }],
      ownRow: { id: 'row-dup', is_primary: false },
      ownHasTransactions: true,
    })
    await upsertFromPsd2(makeUpsertSupabase(stub), 'c1', UPSERT_INPUT)

    expect(stub.deletes).toHaveLength(0)
    expect(stub.updates).toHaveLength(2)
    // First write releases the duplicate's PSD2 binding, preserving the row
    // (and its transactions.cash_account_id links) as a manual account.
    expect(stub.updates[0].id).toBe('row-dup')
    expect(stub.updates[0].payload).toEqual({ bank_connection_id: null, external_uid: null })
    // Second write promotes the holder.
    expect(stub.updates[1].id).toBe('row-old')
    expect(stub.updates[1].payload).toMatchObject({ bank_connection_id: 'conn-new' })
  })

  it('scopes the duplicate linked-transactions probe by company (service-role defense in depth)', async () => {
    const stub = makeUpsertStub({
      holder: { id: 'row-old', bank_connection_id: 'conn-old' },
      connections: [{ id: 'conn-old', status: 'revoked' }],
      ownRow: { id: 'row-dup', is_primary: false },
      ownHasTransactions: false,
    })
    await upsertFromPsd2(makeUpsertSupabase(stub), 'c1', UPSERT_INPUT)

    expect(stub.transactionFilters).toEqual(
      expect.arrayContaining([
        { col: 'company_id', value: 'c1' },
        { col: 'cash_account_id', value: 'row-dup' },
      ]),
    )
  })

  it('transfers the primary flag when the deleted duplicate was primary', async () => {
    const stub = makeUpsertStub({
      holder: { id: 'row-old', bank_connection_id: 'conn-old' },
      connections: [{ id: 'conn-old', status: 'revoked' }],
      ownRow: { id: 'row-dup', is_primary: true },
      ownHasTransactions: false,
    })
    await upsertFromPsd2(makeUpsertSupabase(stub), 'c1', UPSERT_INPUT)

    expect(stub.deletes).toEqual(['row-dup'])
    expect(stub.rpcCalls).toEqual([
      {
        fn: 'set_cash_account_primary',
        args: { p_company_id: 'c1', p_cash_account_id: 'row-old' },
      },
    ])
  })

  it('transfers the primary flag when the DEMOTED duplicate was primary', async () => {
    // Otherwise the stale manual row keeps is_primary=true and the
    // __PRIMARY_SEK__ sentinel resolves to the wrong row.
    const stub = makeUpsertStub({
      holder: { id: 'row-old', bank_connection_id: 'conn-old' },
      connections: [{ id: 'conn-old', status: 'revoked' }],
      ownRow: { id: 'row-dup', is_primary: true },
      ownHasTransactions: true,
    })
    await upsertFromPsd2(makeUpsertSupabase(stub), 'c1', UPSERT_INPUT)

    expect(stub.deletes).toHaveLength(0)
    expect(stub.updates[0].id).toBe('row-dup')
    expect(stub.updates[0].payload).toEqual({ bank_connection_id: null, external_uid: null })
    expect(stub.rpcCalls).toEqual([
      {
        fn: 'set_cash_account_primary',
        args: { p_company_id: 'c1', p_cash_account_id: 'row-old' },
      },
    ])
  })

  it('throws when the plain upsert fails', async () => {
    const stub = makeUpsertStub({ holder: null, upsertError: { message: 'duplicate key' } })
    await expect(
      upsertFromPsd2(makeUpsertSupabase(stub), 'c1', UPSERT_INPUT),
    ).rejects.toThrow(/duplicate key/)
  })
})
