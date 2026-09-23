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
  pickKeeper,
  sameCashAccount,
  normalizeIban,
  defaultLedgerForCurrency,
  getRevokedConnectionIds,
  upsertFromPsd2,
  updateBalancesFromSync,
  ensureManualCashAccount,
} from '../service'

type CashRow = {
  ledger_account: string
  bank_connection_id: string | null
  id?: string
  iban?: string | null
  currency?: string
  is_primary?: boolean
  created_at?: string
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
  /** Ledgers that carry lines on a posted verifikat (the keeper signal). */
  postedLedgers?: string[]
}

/**
 * Thenable query stub: PostgREST chains terminate on await, not on a fixed
 * method, so the same object has to answer .eq()/.not()/.like() and still
 * resolve when awaited. Without this a chain that ends in .not() (the IBAN
 * lookup) cannot share a mock with one that ends in .eq().
 */
function chainable(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'neq', 'not', 'is', 'like', 'in', 'order', 'limit', 'range']) {
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
      if (table === 'journal_entries') {
        return chainable({ data: opts.postedLedgers?.length ? [{ id: 'je-1' }] : [], error: null })
      }
      if (table === 'journal_entry_lines') {
        return chainable({
          data: (opts.postedLedgers ?? []).map((n, i) => ({
            id: `line-${i}`,
            journal_entry_id: 'je-1',
            account_number: n,
          })),
          error: null,
        })
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
    // The chart account gets a BAS-style name, never the bank-reported account
    // name: ASPSPs report the account HOLDER (the company) as the name, and
    // every failed reconnect used to persist another 19xx chart account named
    // after the company (issue #1643 problem 3).
    expect(mappings).toEqual([
      expect.objectContaining({
        sourceAccount: '1931',
        targetAccount: '1931',
        sourceName: 'Bankkonto SEK',
      }),
    ])
  })

  it('uses the BAS reference name when the allocated slot is a standard account', async () => {
    const supabase = makeSupabase([{ ledger_account: '1930', bank_connection_id: 'conn-1' }])
    // Every free-use slot below 1940 is already assigned earlier in the
    // caller's loop, so the allocator lands on 1940 Övriga bankkonton.
    const exclude = new Set(['1931', '1935', '1936', '1937', '1938', '1939'])

    const ledger = await allocatePsd2LedgerAccount(supabase, 'c1', 'u1', {
      currency: 'SEK',
      accountName: 'Arcim AB',
      exclude,
    })

    expect(ledger).toBe('1940')
    const [, , , mappings] = mockSyncMappedAccounts.mock.calls[0]
    expect(mappings).toEqual([
      expect.objectContaining({
        sourceAccount: '1940',
        targetAccount: '1940',
        sourceName: 'Övriga bankkonton',
        targetName: 'Övriga bankkonton',
      }),
    ])
  })

  it('names the chart account after the currency regardless of accountName', async () => {
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
      { id: 'row-1', ledger_account: '1930', bank_connection_id: 'conn-old', iban: IBAN, currency: 'SEK' },
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
        currency: 'eur',
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
      [{ id: 'row-1', ledger_account: '1930', bank_connection_id: 'conn-old', iban: IBAN, currency: 'SEK' }],
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
      { id: 'row-1', ledger_account: '1930', bank_connection_id: null, iban: IBAN, currency: 'SEK' },
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

  it('does not reuse a same-IBAN row in another currency (multi-currency pocket)', async () => {
    const supabase = makeSupabase([
      { id: 'row-sek', ledger_account: '1930', bank_connection_id: 'conn-1', iban: IBAN, currency: 'SEK' },
    ])

    const resolved = await resolvePsd2LedgerAccount(supabase, 'c1', 'u1', {
      iban: IBAN,
      currency: 'EUR',
    })

    expect(resolved?.source).toBe('allocated')
    expect(resolved?.reuseCashAccountId).toBeNull()
  })

  it('among twin rows, reuses the one whose ledger has posted lines', async () => {
    // The overflow twin comes back FIRST from PostgREST: the old first-hit
    // lookup would have kept feeding 1931.
    const supabase = makeSupabase(
      [
        { id: 'row-1931', ledger_account: '1931', bank_connection_id: 'conn-1', iban: IBAN, currency: 'SEK', is_primary: true, created_at: '2026-01-01T00:00:00Z' },
        { id: 'row-1930', ledger_account: '1930', bank_connection_id: 'conn-1', iban: IBAN, currency: 'SEK', is_primary: false, created_at: '2026-02-01T00:00:00Z' },
      ],
      { postedLedgers: ['1930'] },
    )

    const resolved = await resolvePsd2LedgerAccount(supabase, 'c1', 'u1', { iban: IBAN, currency: 'SEK' })

    expect(resolved).toEqual({ ledgerAccount: '1930', reuseCashAccountId: 'row-1930', source: 'iban' })
  })

  it('among twin rows split across two posted ledgers, falls back to the primary row', async () => {
    const supabase = makeSupabase(
      [
        { id: 'row-1931', ledger_account: '1931', bank_connection_id: 'conn-1', iban: IBAN, currency: 'SEK', is_primary: false, created_at: '2026-01-01T00:00:00Z' },
        { id: 'row-1930', ledger_account: '1930', bank_connection_id: 'conn-1', iban: IBAN, currency: 'SEK', is_primary: true, created_at: '2026-02-01T00:00:00Z' },
      ],
      { postedLedgers: ['1930', '1931'] },
    )

    const resolved = await resolvePsd2LedgerAccount(supabase, 'c1', 'u1', { iban: IBAN, currency: 'SEK' })

    expect(resolved?.reuseCashAccountId).toBe('row-1930')
  })
})

describe('pickKeeper', () => {
  const row = (id: string, ledger: string, isPrimary: boolean, createdAt: string) => ({
    id,
    ledger_account: ledger,
    is_primary: isPrimary,
    created_at: createdAt,
  })
  const a = row('a', '1930', false, '2026-02-01T00:00:00Z')
  const b = row('b', '1931', true, '2026-03-01T00:00:00Z')
  const c = row('c', '1932', false, '2026-01-01T00:00:00Z')

  it('keeps the row whose ledger has posted lines, over primary and age', () => {
    expect(pickKeeper([b, c, a], new Set(['1930']))?.id).toBe('a')
  })

  it('falls back to the primary row, then to the oldest', () => {
    expect(pickKeeper([a, b, c], new Set())?.id).toBe('b')
    expect(pickKeeper([a, c], new Set())?.id).toBe('c')
  })

  it('breaks a created_at tie by id, whatever order the rows arrive in', () => {
    const x = row('x', '1935', false, '2026-01-01T00:00:00Z')
    expect(pickKeeper([x, c], new Set())?.id).toBe('c')
    expect(pickKeeper([c, x], new Set())?.id).toBe('c')
  })

  it('returns null when more than one ledger has posted lines', () => {
    expect(pickKeeper([a, b], new Set(['1930', '1931']))).toBeNull()
  })
})

describe('sameCashAccount', () => {
  const keys = new Map([
    ['a', 'SE1|SEK'],
    ['b', 'SE1|SEK'],
    ['c', 'SE2|SEK'],
  ])

  it('matches the same row, IBAN twins, and a null on either side', () => {
    expect(sameCashAccount('a', 'a', keys)).toBe(true)
    expect(sameCashAccount('a', 'b', keys)).toBe(true)
    expect(sameCashAccount(null, 'c', keys)).toBe(true)
    expect(sameCashAccount('c', null, keys)).toBe(true)
  })

  it('never matches different accounts, or two rows without a physical key', () => {
    expect(sameCashAccount('a', 'c', keys)).toBe(false)
    expect(sameCashAccount('a', 'manual-1', keys)).toBe(false)
    expect(sameCashAccount('manual-1', 'manual-2', keys)).toBe(false)
  })
})

// Database promotion invariants and races live in cash-account-promotion.pg.test.ts.
describe('upsertFromPsd2', () => {
  const input = {
    bank_connection_id: 'conn-new', external_uid: 'uid-1', currency: 'SEK', ledger_account: '1930',
    reuse_cash_account_id: 'keeper', expected_session_id: 'current-session',
  }

  it('uses the atomic promotion boundary for the company and reviewed identity', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { cashAccountId: 'keeper' }, error: null })
    const from = vi.fn()
    await upsertFromPsd2({ rpc, from } as unknown as SupabaseClient, 'company', input)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('promote_psd2_cash_account', {
      p_company_id: 'company', p_input: input,
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('propagates a conflict without falling back to independent writes', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: 'PT409', message: 'session changed' } })
    const from = vi.fn()
    await expect(upsertFromPsd2({ rpc, from } as unknown as SupabaseClient, 'company', input))
      .rejects.toMatchObject({ code: 'PT409', message: 'cash_accounts upsert failed: session changed' })
    expect(from).not.toHaveBeenCalled()
  })

  it.each([null, {}, { cashAccountId: '' }])('rejects a missing acknowledgement: %j', async data => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null })
    await expect(upsertFromPsd2({ rpc } as unknown as SupabaseClient, 'company', input))
      .rejects.toThrow('missing promotion acknowledgement')
  })
})

// ── ensureManualCashAccount ──────────────────────────────────────────────

interface ManualStub {
  lookup: {
    data: {
      id: string
      currency?: string
      enabled?: boolean
      bank_connection_id?: string | null
      invoice_payee?: boolean | null
    } | null
    error?: { message: string } | null
  }
  /** Result of the re-enable UPDATE; every payload it was called with lands in `updated`. */
  reenable?: { error?: { message: string } | null; rows?: Array<{ id: string }> }
  updated?: Array<Record<string, unknown>>
  insert?: { data: { id: string } | null; error?: { message: string; code?: string } | null }
  reread?: { data: { id: string; currency?: string } | null; error?: { message: string } | null }
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
        // re-enable path: update().eq().eq().is()
        update: vi.fn((payload: Record<string, unknown>) => {
          ;(stub.updated ??= []).push(payload)
          return {
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                is: vi.fn(() => ({
                  select: vi.fn(() =>
                    Promise.resolve({
                      data: stub.reenable?.error ? null : (stub.reenable?.rows ?? [{ id: 'ca-1' }]),
                      error: stub.reenable?.error ?? null,
                    }),
                  ),
                })),
              })),
            })),
          }
        }),
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
  // A company that disabled an account as unused and then puts transactions on
  // its ledger again (bank-file import, create_transactions, Stripe sync) is
  // using it: binding the rows to a hidden account would recreate the state
  // the disable guard refuses, so the account comes back on (desk crm#59).
  describe('a disabled account on the ledger', () => {
    it('re-enables a disabled account no bank connection holds and binds to it', async () => {
      const stub: ManualStub = {
        lookup: { data: { id: 'ca-1', currency: 'SEK', enabled: false, bank_connection_id: null } },
        inserted: [],
        lookupCount: 0,
      }
      const id = await ensureManualCashAccount(makeManualSupabase(stub), 'c1', '1930', 'SEK')
      expect(id).toBe('ca-1')
      expect(stub.updated).toEqual([{ enabled: true }])
      expect(stub.inserted).toHaveLength(0)
    })

    it('leaves a disabled account a bank connection holds alone: that flag is the connection\'s', async () => {
      const stub: ManualStub = {
        lookup: { data: { id: 'ca-1', currency: 'SEK', enabled: false, bank_connection_id: 'conn-1' } },
        inserted: [],
        lookupCount: 0,
      }
      const id = await ensureManualCashAccount(makeManualSupabase(stub), 'c1', '1930', 'SEK')
      expect(id).toBe('ca-1')
      expect(stub.updated ?? []).toHaveLength(0)
    })

    it('does not write to an account that is already enabled', async () => {
      const stub: ManualStub = {
        lookup: { data: { id: 'ca-1', currency: 'SEK', enabled: true, bank_connection_id: null } },
        inserted: [],
        lookupCount: 0,
      }
      await ensureManualCashAccount(makeManualSupabase(stub), 'c1', '1930', 'SEK')
      expect(stub.updated ?? []).toHaveLength(0)
    })

    it('refuses a currency mismatch before re-enabling anything', async () => {
      const stub: ManualStub = {
        lookup: { data: { id: 'ca-1', currency: 'USD', enabled: false, bank_connection_id: null } },
        inserted: [],
        lookupCount: 0,
      }
      await expect(
        ensureManualCashAccount(makeManualSupabase(stub), 'c1', '1930', 'SEK'),
      ).rejects.toThrow(/denominated in USD/)
      expect(stub.updated ?? []).toHaveLength(0)
    })

    // Swedish compliance review: enabled is one of isUsableInvoicePayee's
    // conditions and the toggle is owner/admin. A payee may have been turned
    // off because its printed details are stale; an import must not put them
    // back on customer invoices.
    it('refuses to turn an invoice payee back on, and writes nothing', async () => {
      const stub: ManualStub = {
        lookup: {
          data: { id: 'ca-1', currency: 'SEK', enabled: false, bank_connection_id: null, invoice_payee: true },
        },
        inserted: [],
        lookupCount: 0,
      }
      await expect(
        ensureManualCashAccount(makeManualSupabase(stub), 'c1', '1930', 'SEK'),
      ).rejects.toMatchObject({ code: 'CASH_ACCOUNT_DISABLED_PAYEE' })
      expect(stub.updated ?? []).toHaveLength(0)
      expect(stub.inserted).toHaveLength(0)
    })

    // Superagent P2: the guarded UPDATE can match nothing when a bank connection
    // claims the row between the read and the write. That is not a success.
    it('fails closed when the re-enable matches no row', async () => {
      const stub: ManualStub = {
        lookup: { data: { id: 'ca-1', currency: 'SEK', enabled: false, bank_connection_id: null } },
        reenable: { rows: [] },
        inserted: [],
        lookupCount: 0,
      }
      await expect(
        ensureManualCashAccount(makeManualSupabase(stub), 'c1', '1930', 'SEK'),
      ).rejects.toThrow(/account changed while it was being turned back on/)
    })

    it('fails loudly when the re-enable write fails, instead of binding to a hidden account', async () => {
      const stub: ManualStub = {
        lookup: { data: { id: 'ca-1', currency: 'SEK', enabled: false, bank_connection_id: null } },
        reenable: { error: { message: 'rls denied' } },
        inserted: [],
        lookupCount: 0,
      }
      await expect(
        ensureManualCashAccount(makeManualSupabase(stub), 'c1', '1930', 'SEK'),
      ).rejects.toThrow(/re-enable failed: rls denied/)
    })
  })

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

  it('applies the currency check to the winner of a 23505 race too', async () => {
    const stub: ManualStub = {
      lookup: { data: null },
      insert: { data: null, error: { message: 'duplicate key', code: '23505' } },
      reread: { data: { id: 'ca-winner', currency: 'EUR' } },
      inserted: [],
      lookupCount: 0,
    }
    await expect(
      ensureManualCashAccount(makeManualSupabase(stub), 'c1', '1935', 'SEK'),
    ).rejects.toThrow('denominated in EUR, not SEK')
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

// ---------------------------------------------------------------------------
// updateBalancesFromSync: balance mirror from the PSD2 sync loop
// ---------------------------------------------------------------------------
describe('updateBalancesFromSync', () => {
  interface BalanceUpdate {
    payload: Record<string, unknown>
    filters: Array<[string, unknown]>
  }

  function makeBalanceStub(updateError: { message: string } | null = null) {
    const updates: BalanceUpdate[] = []
    const supabase = {
      from: vi.fn((table: string) => {
        if (table !== 'cash_accounts') throw new Error(`unexpected table ${table}`)
        return {
          update: vi.fn((payload: Record<string, unknown>) => {
            const entry: BalanceUpdate = { payload, filters: [] }
            updates.push(entry)
            const chain = {
              eq: vi.fn((col: string, val: unknown) => {
                entry.filters.push([col, val])
                return chain
              }),
              lt: vi.fn((col: string, val: unknown) => {
                entry.filters.push([`lt:${col}`, val])
                return chain
              }),
              is: vi.fn((col: string, val: unknown) => {
                entry.filters.push([`is:${col}`, val])
                return chain
              }),
              then: (onFulfilled: (value: unknown) => unknown) =>
                Promise.resolve({ error: updateError }).then(onFulfilled),
            }
            return chain
          }),
        }
      }),
    } as unknown as SupabaseClient
    return { supabase, updates }
  }

  it('updates only balance fields, keyed on company + connection + uid', async () => {
    const { supabase, updates } = makeBalanceStub()
    await updateBalancesFromSync(supabase, 'c1', 'conn-1', [
      {
        external_uid: 'uid-1',
        balance: 1000.5,
        available_balance: 950.25,
        balance_updated_at: '2026-09-01T05:00:00.000Z',
      },
    ])

    // Two writes per account: one for rows with an OLDER timestamp, one for
    // rows with NO timestamp. Together they are the stale-writer guard: an
    // older sync run finishing later must not move the mirror backwards.
    expect(updates).toHaveLength(2)
    for (const u of updates) {
      expect(u.payload).toEqual({
        balance: 1000.5,
        available_balance: 950.25,
        balance_updated_at: '2026-09-01T05:00:00.000Z',
      })
    }
    expect(updates[0].filters).toEqual([
      ['company_id', 'c1'],
      ['bank_connection_id', 'conn-1'],
      ['external_uid', 'uid-1'],
      ['lt:balance_updated_at', '2026-09-01T05:00:00.000Z'],
    ])
    expect(updates[1].filters).toEqual([
      ['company_id', 'c1'],
      ['bank_connection_id', 'conn-1'],
      ['external_uid', 'uid-1'],
      ['is:balance_updated_at', null],
    ])
  })

  it('skips accounts without a timestamped balance (never nulls a stored one)', async () => {
    const { supabase, updates } = makeBalanceStub()
    await updateBalancesFromSync(supabase, 'c1', 'conn-1', [
      { external_uid: 'uid-no-balance', balance: null, balance_updated_at: '2026-09-01T05:00:00.000Z' },
      { external_uid: 'uid-no-timestamp', balance: 100 },
      { external_uid: 'uid-ok', balance: 200, balance_updated_at: '2026-09-01T05:00:00.000Z' },
    ])

    expect(updates).toHaveLength(2)
    expect(updates[0].filters).toContainEqual(['external_uid', 'uid-ok'])
    // A refresh without an available type writes null: a stale available
    // figure next to a fresh booked figure would misstate what can be spent.
    expect(updates[0].payload.available_balance).toBeNull()
  })

  it('logs update failures instead of throwing (mirror must not fail the sync)', async () => {
    const { supabase } = makeBalanceStub({ message: 'boom' })
    await expect(
      updateBalancesFromSync(supabase, 'c1', 'conn-1', [
        { external_uid: 'uid-1', balance: 1, balance_updated_at: '2026-09-01T05:00:00.000Z' },
      ]),
    ).resolves.toBeUndefined()
  })
})
