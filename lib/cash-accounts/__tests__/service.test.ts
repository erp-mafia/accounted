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
  resolvePsd2LedgerAccount,
  normalizeIban,
  defaultLedgerForCurrency,
  getRevokedConnectionIds,
  upsertFromPsd2,
  ensureManualCashAccount,
} from '../service'

type CashRow = {
  ledger_account: string
  bank_connection_id: string | null
  id?: string
  iban?: string | null
}
type ConnRow = { id: string; status: string }

interface MakeSupabaseOpts {
  error?: { message: string } | null
  /** bank_connections rows for the status lookup. Missing ids = not revoked. */
  connections?: ConnRow[]
  connectionsError?: { message: string } | null
  /** 19xx account numbers already present in the company's chart. */
  chart?: string[]
  chartError?: { message: string } | null
}

/**
 * Thenable query stub: PostgREST chains terminate on await, not on a fixed
 * method, so the same object has to answer .eq()/.not()/.like() and still
 * resolve when awaited. Without this a chain that ends in .not() (the IBAN
 * lookup) cannot share a mock with one that ends in .eq().
 */
function chainable(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'neq', 'not', 'is', 'like', 'in', 'order', 'limit']) {
    chain[method] = vi.fn(() => chain)
  }
  chain.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled)
  chain.maybeSingle = vi.fn(() => Promise.resolve(result))
  return chain
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
      if (table === 'chart_of_accounts') {
        return chainable(
          opts.chartError
            ? { data: null, error: opts.chartError }
            : { data: (opts.chart ?? []).map(n => ({ account_number: n })), error: null },
        )
      }
      return chainable({
        data: opts.error ? null : rows,
        error: opts.error ?? null,
      })
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

describe('findFreeLedgerAccount: chart awareness', () => {
  it('skips an overflow slot that already names a bank account in the chart', async () => {
    // A chart imported from SIE carries the company's real bank accounts
    // ("1931 Nordnet") with no cash_accounts row behind them. Handing one out
    // as free is how a SEK företagskonto got proposed as someone else's
    // brokerage account.
    const supabase = makeSupabase([{ ledger_account: '1930', bank_connection_id: 'conn-1' }], {
      chart: ['1930', '1931', '1935'],
    })

    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1936')
  })

  it('still returns the currency default when the chart holds it', async () => {
    // 1930 exists in every chart; that must not push the SEK account into
    // overflow when no PSD2 row actually claims it.
    const supabase = makeSupabase([], { chart: ['1930'] })

    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1930')
  })

  it('falls back to a chart-occupied slot when nothing unnamed is left', async () => {
    const chart: string[] = []
    for (let n = 1931; n <= 1959; n++) chart.push(String(n))
    const supabase = makeSupabase([{ ledger_account: '1930', bank_connection_id: 'conn-1' }], {
      chart,
    })

    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1931')
  })

  it('allocates normally when the chart lookup fails', async () => {
    const supabase = makeSupabase([{ ledger_account: '1930', bank_connection_id: 'conn-1' }], {
      chartError: { message: 'boom' },
    })

    expect(await findFreeLedgerAccount(supabase, 'c1', 'SEK')).toBe('1931')
  })
})

describe('normalizeIban', () => {
  it('strips formatting so the same account compares equal', () => {
    expect(normalizeIban('SE45 5000 0000 0583 9825 7466')).toBe('SE4550000000058398257466')
    expect(normalizeIban('se4550000000058398257466')).toBe('SE4550000000058398257466')
    expect(normalizeIban(null)).toBeNull()
    expect(normalizeIban('   ')).toBeNull()
  })
})

describe('resolvePsd2LedgerAccount', () => {
  const IBAN = 'SE4550000000058398257466'

  it('reuses the ledger of the row with the same IBAN instead of allocating', async () => {
    // The reconnect case: the bank minted a new account uid (and possibly a
    // whole new connection row), but it is the same physical account.
    const supabase = makeSupabase([
      { id: 'row-1', ledger_account: '1930', bank_connection_id: 'conn-old', iban: IBAN },
    ])

    const resolved = await resolvePsd2LedgerAccount(supabase, 'c1', 'u1', {
      iban: IBAN,
      currency: 'SEK',
    })

    expect(resolved).toEqual({
      ledgerAccount: '1930',
      reuseCashAccountId: 'row-1',
      source: 'iban',
    })
    // No chart write: we are adopting an account that already exists.
    expect(mockSyncMappedAccounts).not.toHaveBeenCalled()
  })

  it('matches on IBAN across formatting differences', async () => {
    const supabase = makeSupabase([
      {
        id: 'row-1',
        ledger_account: '1941',
        bank_connection_id: 'conn-old',
        iban: 'SE45 5000 0000 0583 9825 7466',
      },
    ])

    const resolved = await resolvePsd2LedgerAccount(supabase, 'c1', 'u1', {
      iban: 'se4550000000058398257466',
      currency: 'EUR',
    })

    expect(resolved?.ledgerAccount).toBe('1941')
    expect(resolved?.source).toBe('iban')
  })

  it('reuses even when the previous holder connection is still active', async () => {
    // The bank killed the old session without telling us, so the old row still
    // reads as a live claim. One IBAN is one account: the connection that just
    // authorized owns it.
    const supabase = makeSupabase(
      [{ id: 'row-1', ledger_account: '1930', bank_connection_id: 'conn-old', iban: IBAN }],
      { connections: [{ id: 'conn-old', status: 'active' }] },
    )

    const resolved = await resolvePsd2LedgerAccount(supabase, 'c1', 'u1', {
      iban: IBAN,
      currency: 'SEK',
    })

    expect(resolved?.ledgerAccount).toBe('1930')
    expect(resolved?.reuseCashAccountId).toBe('row-1')
  })

  it('allocates when the IBAN is unknown', async () => {
    const supabase = makeSupabase([
      { id: 'row-1', ledger_account: '1930', bank_connection_id: 'conn-1', iban: 'SE9999' },
    ])

    const resolved = await resolvePsd2LedgerAccount(supabase, 'c1', 'u1', {
      iban: IBAN,
      currency: 'SEK',
    })

    expect(resolved?.source).toBe('allocated')
    expect(resolved?.reuseCashAccountId).toBeNull()
    expect(resolved?.ledgerAccount).toBe('1931')
  })

  it('allocates when the IBAN match was already claimed earlier in the loop', async () => {
    // Two accounts cannot share a ledger: the UNIQUE (company_id,
    // ledger_account) constraint would reject the second write.
    const supabase = makeSupabase([
      { id: 'row-1', ledger_account: '1930', bank_connection_id: null, iban: IBAN },
    ])

    const resolved = await resolvePsd2LedgerAccount(supabase, 'c1', 'u1', {
      iban: IBAN,
      currency: 'SEK',
      exclude: new Set(['1930']),
    })

    expect(resolved?.source).toBe('allocated')
    expect(resolved?.ledgerAccount).not.toBe('1930')
  })

  it('allocates for an account the bank gave no IBAN for', async () => {
    const supabase = makeSupabase([])

    const resolved = await resolvePsd2LedgerAccount(supabase, 'c1', 'u1', {
      iban: null,
      currency: 'SEK',
    })

    expect(resolved).toEqual({
      ledgerAccount: '1930',
      reuseCashAccountId: null,
      source: 'allocated',
    })
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

  it('promotes an IBAN-matched holder even when a live connection still holds it', async () => {
    // The reconnect fix: resolvePsd2LedgerAccount matched this row by IBAN, so
    // it is this account under a stale owner. Promoting keeps the row id (and
    // its linked transactions) and re-points it at the new connection; without
    // this the INSERT would trip the (company_id, ledger_account) constraint
    // and the user's 1930 mapping would land on an overflow slot instead.
    const stub = makeUpsertStub({
      holder: { id: 'row-known', bank_connection_id: 'conn-old' },
      connections: [{ id: 'conn-old', status: 'active' }],
    })
    await upsertFromPsd2(makeUpsertSupabase(stub), 'c1', {
      ...UPSERT_INPUT,
      reuse_cash_account_id: 'row-known',
    })

    expect(stub.upserts).toHaveLength(0)
    expect(stub.updates).toHaveLength(1)
    expect(stub.updates[0].id).toBe('row-known')
    expect(stub.updates[0].payload).toMatchObject({
      bank_connection_id: 'conn-new',
      external_uid: 'uid-1',
      ledger_account: '1930',
    })
  })

  it('ignores a reuse id that does not match the row holding the ledger', async () => {
    const stub = makeUpsertStub({
      holder: { id: 'row-other', bank_connection_id: 'conn-other' },
      connections: [{ id: 'conn-other', status: 'active' }],
    })
    await upsertFromPsd2(makeUpsertSupabase(stub), 'c1', {
      ...UPSERT_INPUT,
      reuse_cash_account_id: 'row-stale',
    })

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

  it('promotes a SAME-connection holder under a retired uid when explicitly named via reuse_cash_account_id', async () => {
    // Issue #1709: in-place reconnect of a no-IBAN account whose ASPSP minted
    // a new uid. The callback pairs the account with the connection's own old
    // row and names it explicitly; the promote re-keys that row to the new uid
    // in place, so its id (and the transactions linked to it) survive. Without
    // the explicit name the plain upsert would INSERT and trip the
    // (company_id, ledger_account) UNIQUE constraint; the previous test pins
    // that an UNNAMED same-connection holder still routes through the plain
    // upsert (the general active-holder rejection is not loosened).
    const stub = makeUpsertStub({
      holder: { id: 'row-self', bank_connection_id: 'conn-new' },
    })
    await upsertFromPsd2(makeUpsertSupabase(stub), 'c1', {
      ...UPSERT_INPUT,
      external_uid: 'uid-2',
      reuse_cash_account_id: 'row-self',
    })

    expect(stub.upserts).toHaveLength(0)
    expect(stub.updates).toHaveLength(1)
    expect(stub.updates[0].id).toBe('row-self')
    expect(stub.updates[0].payload).toMatchObject({
      bank_connection_id: 'conn-new',
      external_uid: 'uid-2',
      ledger_account: '1930',
    })
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

// ── ensureManualCashAccount ──────────────────────────────────────────────

interface ManualStub {
  lookup: { data: { id: string; currency?: string } | null; error?: { message: string } | null }
  insert?: { data: { id: string } | null; error?: { message: string; code?: string } | null }
  reread?: { data: { id: string } | null; error?: { message: string } | null }
  inserted: Array<Record<string, unknown>>
  lookupCount: number
}

function makeManualSupabase(stub: ManualStub): SupabaseClient {
  return {
    from: vi.fn((table: string) => {
      expect(table).toBe('cash_accounts')
      return {
        // lookup / reread path: select().eq().eq().maybeSingle()
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(() => {
                stub.lookupCount += 1
                // First maybeSingle = initial lookup; a second = post-23505 reread.
                const r = stub.lookupCount === 1 ? stub.lookup : stub.reread ?? { data: null }
                return Promise.resolve({ data: r.data, error: r.error ?? null })
              }),
            })),
          })),
        })),
        // insert().select('id').single()
        insert: vi.fn((payload: Record<string, unknown>) => {
          stub.inserted.push(payload)
          return {
            select: vi.fn(() => ({
              single: vi.fn(() =>
                Promise.resolve({
                  data: stub.insert?.data ?? null,
                  error: stub.insert?.error ?? null,
                }),
              ),
            })),
          }
        }),
      }
    }),
  } as unknown as SupabaseClient
}

describe('ensureManualCashAccount', () => {
  it('returns the existing row id without inserting when the currency matches', async () => {
    const stub: ManualStub = { lookup: { data: { id: 'ca-1', currency: 'SEK' } }, inserted: [], lookupCount: 0 }
    const id = await ensureManualCashAccount(makeManualSupabase(stub), 'c1', '1935', 'sek')
    expect(id).toBe('ca-1')
    expect(stub.inserted).toHaveLength(0)
  })

  it('throws when the existing row is a different currency (UNIQUE ledger conflict)', async () => {
    const stub: ManualStub = { lookup: { data: { id: 'ca-usd', currency: 'USD' } }, inserted: [], lookupCount: 0 }
    await expect(
      ensureManualCashAccount(makeManualSupabase(stub), 'c1', '1935', 'SEK'),
    ).rejects.toThrow(/denominated in USD, not SEK/)
    expect(stub.inserted).toHaveLength(0)
  })

  it('creates a manual row (source=manual, uppercased currency) when none exists', async () => {
    const stub: ManualStub = {
      lookup: { data: null },
      insert: { data: { id: 'ca-new' } },
      inserted: [],
      lookupCount: 0,
    }
    const id = await ensureManualCashAccount(makeManualSupabase(stub), 'c1', '1935', 'sek')
    expect(id).toBe('ca-new')
    expect(stub.inserted[0]).toMatchObject({
      company_id: 'c1',
      ledger_account: '1935',
      currency: 'SEK',
      source: 'manual',
      is_primary: false,
      enabled: true,
    })
  })

  it('re-reads the winner on a 23505 race instead of throwing', async () => {
    const stub: ManualStub = {
      lookup: { data: null },
      insert: { data: null, error: { message: 'duplicate key', code: '23505' } },
      reread: { data: { id: 'ca-winner' } },
      inserted: [],
      lookupCount: 0,
    }
    const id = await ensureManualCashAccount(makeManualSupabase(stub), 'c1', '1935', 'SEK')
    expect(id).toBe('ca-winner')
  })

  it('throws on a non-race insert failure', async () => {
    const stub: ManualStub = {
      lookup: { data: null },
      insert: { data: null, error: { message: 'boom' } },
      inserted: [],
      lookupCount: 0,
    }
    await expect(
      ensureManualCashAccount(makeManualSupabase(stub), 'c1', '1935', 'SEK'),
    ).rejects.toThrow(/boom/)
  })
})
