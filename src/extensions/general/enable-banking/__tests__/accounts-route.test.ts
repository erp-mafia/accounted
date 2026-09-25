import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the sync module before importing the extension so the route handler picks up the spy.
vi.mock('../lib/sync', () => ({
  syncAccountTransactions: vi.fn(),
}))

// Keep ledger preparation deterministic. Selection writes use the real
// configuration wrapper and an RPC stub; pg-real tests verify atomicity.
const { mockAllocate, mockGetRevokedConnectionIds } = vi.hoisted(() => ({
  mockAllocate: vi.fn(),
  mockGetRevokedConnectionIds: vi.fn(),
}))
vi.mock('@/lib/cash-accounts/service', () => ({
  // See the callback route suite: mockAllocate stays the allocation stand-in
  // and the wrapper wraps it in the resolver's envelope.
  resolvePsd2LedgerAccount: async (...args: unknown[]) => {
    const ledgerAccount = await mockAllocate(...args)
    if (!ledgerAccount) return null
    if (typeof ledgerAccount === 'object') return ledgerAccount
    return { ledgerAccount, reuseCashAccountId: null, source: 'allocated' }
  },
  getRevokedConnectionIds: (...args: unknown[]) => mockGetRevokedConnectionIds(...args),
  normalizeIban: (iban: string | null | undefined) =>
    iban ? iban.replace(/\s+/g, '').toUpperCase() || null : null,
}))

// Mock the reconciliation modules so the renewal-guard sweep is deterministic
// and observable. The mocks must export every symbol index.ts imports.
const { mockRunReconciliation, mockResolveCashAccountScope } = vi.hoisted(() => ({
  mockRunReconciliation: vi.fn(),
  mockResolveCashAccountScope: vi.fn(),
}))
vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  runReconciliation: (...args: unknown[]) => mockRunReconciliation(...args),
  DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD: 0.9,
}))
vi.mock('@/lib/reconciliation/cash-account-scope', () => ({
  resolveCashAccountScope: (...args: unknown[]) => mockResolveCashAccountScope(...args),
}))

import { enableBankingExtension } from '../index'
import { syncAccountTransactions } from '../lib/sync'
import { eventBus } from '@/lib/events/bus'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { StoredAccount } from '../types'

const mockedSync = vi.mocked(syncAccountTransactions)

// Locate the PATCH /accounts handler once: schema doesn't change at runtime.
const accountsRoute = enableBankingExtension.apiRoutes?.find(
  r => r.method === 'PATCH' && r.path === '/accounts'
)

if (!accountsRoute) {
  throw new Error('PATCH /accounts route not registered on enable-banking extension')
}

interface SupabaseStub {
  authUser: { id: string } | null
  connectionRow: {
    id: string
    status: string
    accounts_data: StoredAccount[]
  } | null
  connectionError?: { message: string; code?: string } | null
  selectionError?: { message: string; code?: string } | null
  selectionCalls?: Array<Record<string, unknown>>
  selectionReceipts?: Array<{ status: string; accounts_data: StoredAccount[] }>
  returnedAccounts?: StoredAccount[]
  syncError?: { message: string }
  capturedSync?: Record<string, unknown>
  /** BAS account numbers that exist in the company's chart_of_accounts (PR 2 ledger validation). */
  chartAccountNumbers?: string[]
  /** Existing cash_accounts rows for the company (ledger collision validation). */
  cashAccountRows?: Array<{
    id?: string
    external_uid: string | null
    bank_connection_id: string | null
    ledger_account: string
    iban?: string | null
    currency?: string
    /** Mirrors the picker's checkbox in that row's connection; absent = live claim. */
    enabled?: boolean
  }>
  /** Completed SIE import overlapping the backfill window (renewal-flood guard). */
  sieImportRow?: { id: string } | null
  /** company_members row for the caller; role 'viewer' disables the sweep. */
  membershipRow?: { role: string } | null
}

function buildSupabase(stub: SupabaseStub) {
  return {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'read_bank_configuration') {
        if (stub.connectionError || !stub.connectionRow) return { data: null, error: stub.connectionError ?? { code: 'P0002', message: 'BANK_CONNECTION_NOT_FOUND' } }
        return { data: { token: 'configuration-token', connection: { session_id: 'current-session', bank_name: 'Test bank', ...stub.connectionRow } }, error: null }
      }
      if (name === 'save_bank_account_selection') {
        ;(stub.selectionCalls ??= []).push(args)
        if (stub.selectionError) return { data: null, error: stub.selectionError }
        const selections = args.p_selections as Array<{ uid: string; enabled: boolean; ledger_account?: string }>
        const accounts = stub.returnedAccounts ?? stub.connectionRow!.accounts_data.map(account => {
          const selected = selections.find(a => a.uid === account.uid)!
          const saved = { ...account, enabled: selected.enabled, ledger_account: selected.ledger_account }
          if (!saved.ledger_account) delete saved.ledger_account
          if (saved.enabled) {
            delete saved.mirror_card_account
            delete saved.claimed_by_company_id
            delete saved.claimed_by_company_name
            delete saved.deselected_elsewhere
          }
          return saved
        })
        const status = stub.connectionRow!.status === 'pending_selection' ? 'active' : stub.connectionRow!.status
        ;(stub.selectionReceipts ??= []).push({ status, accounts_data: accounts })
        return { data: { status, accounts }, error: null }
      }
      if (name === 'persist_bank_sync_result') {
        stub.capturedSync = args
        return { data: { applied: true }, error: stub.syncError ?? null }
      }
      throw new Error(`Unexpected RPC: ${name}`)
    }),
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: stub.authUser }, error: null }),
    },
    from: vi.fn((table: string) => {
      // The chart_of_accounts query is used for ledger_account validation
      // (PR 487). It chains select().eq().in() and is awaited as a thenable.
      if (table === 'chart_of_accounts') {
        const numbers = stub.chartAccountNumbers ?? []
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn((_col: string, vals: string[]) => {
            const data = vals
              .filter(v => numbers.includes(v))
              .map(v => ({ account_number: v }))
            return Promise.resolve({ data, error: null })
          }),
        }
      }
      // Company-wide cash_accounts read for ledger collision validation:
      // select().eq() awaited as a thenable.
      if (table === 'cash_accounts') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(() => Promise.resolve({ data: stub.cashAccountRows ?? [], error: null })),
          update: vi.fn(() => { throw new Error('Selection must not write cash rows outside its RPC') }),
        }
      }
      // Renewal-flood guard: SIE-overlap probe before the inline backfill.
      if (table === 'sie_imports') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          gte: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: stub.sieImportRow ?? null, error: null }),
        }
      }
      // Role probe for the reconciliation sweep (viewers cannot write links).
      if (table === 'company_members') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: stub.membershipRow ?? null, error: null }),
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: stub.connectionRow,
          error: stub.connectionError ?? null,
        }),
        update: vi.fn(() => { throw new Error('Selection must not write connections outside its RPC') }),
      }
    }),
  }
}

function makeContext(supabase: ReturnType<typeof buildSupabase>): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'enable-banking',
    requestId: 'req_test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    emit: vi.fn().mockResolvedValue(undefined),
    settings: { get: vi.fn(), set: vi.fn(), getAll: vi.fn() } as never,
    storage: {} as never,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
    services: {} as never,
  }
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/extensions/ext/enable-banking/accounts', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ALLOCATOR_DEFAULTS: Record<string, string> = {
  SEK: '1930',
  EUR: '1932',
  USD: '1933',
  GBP: '1934',
}

describe('PATCH /accounts (enable-banking)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mockRunReconciliation.mockResolvedValue({
      matches: [],
      applied: 0,
      errors: 0,
      skippedBelowThreshold: 0,
    })
    // Scope stand-in: echo the requested account (or the '1930' default) so
    // tests can assert the sweep runs once per ledger account, correctly scoped.
    mockResolveCashAccountScope.mockImplementation(
      async (_supabase: unknown, _companyId: unknown, accountNumber?: string) => ({
        accountNumber: accountNumber ?? '1930',
        currency: 'SEK',
        cashAccountId: `ca-${accountNumber ?? '1930'}`,
        includeUnassigned: accountNumber === undefined,
        found: true,
      }),
    )
    // Default: no revoked connections; individual tests override to exercise
    // the self-heal path.
    mockGetRevokedConnectionIds.mockResolvedValue(new Set<string>())
    // Allocator stand-in mirroring the real behavior: currency default first,
    // then the next free 1931–1959 slot (skipping other currency defaults).
    mockAllocate.mockImplementation(
      async (
        _supabase: unknown,
        _companyId: unknown,
        _userId: unknown,
        input: { currency: string; exclude?: ReadonlySet<string> },
      ) => {
        const preferred = ALLOCATOR_DEFAULTS[input.currency.toUpperCase()] ?? '1930'
        const exclude = input.exclude ?? new Set<string>()
        if (!exclude.has(preferred)) return preferred
        const reserved = new Set(Object.values(ALLOCATOR_DEFAULTS))
        for (let n = 1931; n <= 1959; n++) {
          const candidate = String(n)
          if (!reserved.has(candidate) && !exclude.has(candidate)) return candidate
        }
        return null
      },
    )
  })

  it('returns 401 when unauthenticated', async () => {
    const supabase = buildSupabase({ authUser: null, connectionRow: null })
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
      ctx
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 when connection_id missing', async () => {
    const supabase = buildSupabase({ authUser: { id: 'user-1' }, connectionRow: null })
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ enabled_uids: ['acc-1'] }),
      ctx
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when enabled_uids is empty', async () => {
    const supabase = buildSupabase({ authUser: { id: 'user-1' }, connectionRow: null })
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: [] }),
      ctx
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Välj minst ett konto/i)
  })

  it('returns 400 when enabled_uids contains unknown uid', async () => {
    const supabase = buildSupabase({
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'pending_selection',
        accounts_data: [
          { uid: 'acc-1', currency: 'SEK', enabled: true },
          { uid: 'acc-2', currency: 'SEK', enabled: true },
        ],
      },
    })
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1', 'acc-bogus'] }),
      ctx
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.unknown_uids).toEqual(['acc-bogus'])
  })

  it('returns 404 when connection not found', async () => {
    const supabase = buildSupabase({
      authUser: { id: 'user-1' },
      connectionRow: null,
      connectionError: { message: 'BANK_CONNECTION_NOT_FOUND', code: 'P0002' },
    })
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
      ctx
    )
    expect(res.status).toBe(404)
  })

  it('returns 409 for an obsolete configuration without emitting an event or starting sync', async () => {
    const stub: SupabaseStub = { authUser: { id: 'user-1' }, selectionError: { code: 'PT409', message: 'BANK_CONFIGURATION_CHANGED' },
      connectionRow: { id: 'conn-1', status: 'pending_selection', accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }] } }
    const ctx = makeContext(buildSupabase(stub))
    const res = await accountsRoute.handler(makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }), ctx)
    expect(res.status).toBe(409)
    expect(stub.selectionCalls).toHaveLength(1)
    expect(ctx.emit).not.toHaveBeenCalled()
    expect(mockedSync).not.toHaveBeenCalled()
  })

  it.each([
    [{ code: 'PT409', message: 'BANK_CONFIGURATION_CHANGED' }, 409, /ändrades medan du valde konton/],
    [{ code: '23514', message: 'CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT' }, 409, /annat bankkonto/],
    [{ code: '23514', message: 'BANK_SELECTION_LEDGER_CONFLICT' }, 400, /samma bokföringskonto/],
    [{ code: '23505', message: 'CASH_ACCOUNT_LEDGER_CLAIMED' }, 409, /annan bankanslutning/],
  ])('answers a refused save (%o) with its own code and a readable Swedish message', async (selectionError, status, message) => {
    const stub: SupabaseStub = { authUser: { id: 'user-1' }, selectionError,
      connectionRow: { id: 'conn-1', status: 'active', accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true, ledger_account: '1930' }] } }
    const ctx = makeContext(buildSupabase(stub))
    const res = await accountsRoute.handler(makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }), ctx)
    expect(res.status).toBe(status)
    const body = await res.json()
    expect(body.error).toMatchObject({ code: selectionError.message })
    expect(body.error.message).toMatch(message)
    expect(ctx.emit).not.toHaveBeenCalled()
    expect(mockedSync).not.toHaveBeenCalled()
  })

  it.each(['exhausted', 'failed'])('does not save or sync when ledger preparation is %s', async failure => {
    if (failure === 'exhausted') mockAllocate.mockResolvedValue(null)
    else mockAllocate.mockRejectedValue(new Error('Lookup unavailable'))
    const stub: SupabaseStub = { authUser: { id: 'user-1' },
      connectionRow: { id: 'conn-1', status: 'pending_selection', accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }] } }
    const ctx = makeContext(buildSupabase(stub))
    const res = await accountsRoute.handler(makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }), ctx)
    expect(res.status).toBe(failure === 'exhausted' ? 409 : 500)
    expect(mockAllocate).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', expect.objectContaining({ prepareOnly: true }))
    expect(stub.selectionCalls).toBeUndefined()
    expect(ctx.emit).not.toHaveBeenCalled()
    expect(mockedSync).not.toHaveBeenCalled()
  })

  it('starts backfill using the current accounts returned by the atomic save', async () => {
    mockedSync.mockResolvedValue({ requestedFromDate: '2026-01-01', historyNarrowed: false, imported: 0, duplicates: 0, errors: 0 })
    const fresh = { uid: 'acc-1', currency: 'SEK', enabled: true, ledger_account: '1930', balance: 987, dedup_scope: 'fresh-scope' }
    const stub: SupabaseStub = { authUser: { id: 'user-1' }, returnedAccounts: [fresh],
      connectionRow: { id: 'conn-1', status: 'pending_selection', accounts_data: [{ ...fresh, balance: 1, dedup_scope: 'old-scope' }] } }
    const res = await accountsRoute.handler(makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }), makeContext(buildSupabase(stub)))
    expect(res.status).toBe(200)
    expect(mockedSync.mock.calls[0]).toContainEqual(expect.objectContaining({ balance: 987, dedup_scope: 'fresh-scope' }))
  })

  it('does not reuse another currency cash row sharing an IBAN', async () => {
    const stub: SupabaseStub = { authUser: { id: 'user-1' },
      cashAccountRows: [{ id: 'eur-row', iban: 'SE1234', currency: 'EUR', ledger_account: '1932', bank_connection_id: 'old-connection', external_uid: 'old-uid' }],
      connectionRow: { id: 'conn-1', status: 'active', accounts_data: [{ uid: 'acc-1', currency: 'SEK', iban: 'SE1234', enabled: true }] } }
    const res = await accountsRoute.handler(makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }), makeContext(buildSupabase(stub)))
    expect(res.status).toBe(200)
    expect(stub.selectionCalls?.[0]?.p_selections).toEqual([expect.objectContaining({ uid: 'acc-1', ledger_account: '1930', reuse_cash_account_id: null })])
  })

  it('returns 400 when connection is in an invalid status (e.g. expired)', async () => {
    const supabase = buildSupabase({
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'expired',
        accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
      },
    })
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
      ctx
    )
    expect(res.status).toBe(400)
  })

  it('flips status to active and writes per-account enabled flags', async () => {
    const stub: SupabaseStub = {
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'pending_selection',
        accounts_data: [
          { uid: 'acc-1', currency: 'SEK', enabled: true, name: 'Företag' },
          { uid: 'acc-2', currency: 'SEK', enabled: true, name: 'Privat' },
          { uid: 'acc-3', currency: 'SEK', enabled: true, name: 'Spar' },
        ],
      },
    }
    const supabase = buildSupabase(stub)
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1', 'acc-3'] }),
      ctx
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, enabled_count: 2, total_count: 3 })

    // The atomic save returns the selected accounts before initial backfill.
    const firstUpdate = stub.selectionReceipts?.[0]
    expect(firstUpdate).toBeDefined()
    expect(firstUpdate?.status).toBe('active')
    const written = firstUpdate?.accounts_data as StoredAccount[]
    expect(written).toHaveLength(3)
    expect(written.find(a => a.uid === 'acc-1')?.enabled).toBe(true)
    expect(written.find(a => a.uid === 'acc-2')?.enabled).toBe(false)
    expect(written.find(a => a.uid === 'acc-3')?.enabled).toBe(true)
    // Disabled accounts are kept in the row so the user can re-enable later.
    expect(written.find(a => a.uid === 'acc-2')?.name).toBe('Privat')
  })

  it('clears the mirror-card note when the user turns that account on, keeps it when left off', async () => {
    // Issue #2565: the callback stores Svea's BOKIO_Debit_Business off and
    // flagged. Enabling it is the user's call; once made, the note is stale.
    const stub: SupabaseStub = {
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'active',
        accounts_data: [
          { uid: 'acc-main', currency: 'SEK', enabled: true, name: 'Testbrand AB', iban: 'SE1234' },
          { uid: 'acc-card', currency: 'SEK', enabled: false, name: 'BOKIO_Debit_Business', mirror_card_account: true },
        ],
      },
    }
    const supabase = buildSupabase(stub)
    const ctx = makeContext(supabase)

    const keptOff = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-main'] }),
      ctx
    )
    expect(keptOff.status).toBe(200)
    const keptOffWritten = stub.selectionReceipts?.[0]?.accounts_data as StoredAccount[]
    expect(keptOffWritten.find(a => a.uid === 'acc-card')).toMatchObject({
      enabled: false,
      mirror_card_account: true,
    })

    stub.selectionReceipts = []
    const turnedOn = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-main', 'acc-card'] }),
      ctx
    )
    expect(turnedOn.status).toBe(200)
    const turnedOnWritten = stub.selectionReceipts?.[0]?.accounts_data as StoredAccount[]
    const card = turnedOnWritten.find(a => a.uid === 'acc-card')
    expect(card?.enabled).toBe(true)
    expect(card?.mirror_card_account).toBeUndefined()
  })

  it('allows re-selection on an already-active connection', async () => {
    const stub: SupabaseStub = {
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'active',
        accounts_data: [
          { uid: 'acc-1', currency: 'SEK', enabled: true },
          { uid: 'acc-2', currency: 'SEK', enabled: false },
        ],
      },
    }
    const supabase = buildSupabase(stub)
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-2'] }),
      ctx
    )

    expect(res.status).toBe(200)
    const written = stub.selectionReceipts?.at(-1)?.accounts_data as StoredAccount[]
    expect(written.find(a => a.uid === 'acc-1')?.enabled).toBe(false)
    expect(written.find(a => a.uid === 'acc-2')?.enabled).toBe(true)
  })

  it('submits the snapshot token and selection without a caller-controlled status', async () => {
    const stub: SupabaseStub = {
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'active',
        accounts_data: [
          { uid: 'acc-1', currency: 'SEK', enabled: true },
          { uid: 'acc-2', currency: 'SEK', enabled: false },
        ],
      },
    }
    const supabase = buildSupabase(stub)
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-2'] }),
      ctx
    )

    expect(res.status).toBe(200)
    expect(stub.selectionCalls).toHaveLength(1)
    expect(stub.selectionCalls?.[0]).toMatchObject({ p_expected_token: 'configuration-token', p_company_id: 'company-1', p_connection_id: 'conn-1' })
    expect(stub.selectionCalls?.[0]).not.toHaveProperty('status')
  })

  it('returns 400 when ctx.companyId is absent (no user.id fallback)', async () => {
    const supabase = buildSupabase({ authUser: { id: 'user-1' }, connectionRow: null })
    const ctx = makeContext(supabase)
    // Simulate a missing company context: should not fall back to user.id.
    const ctxWithoutCompany = { ...ctx, companyId: undefined as unknown as string }

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
      ctxWithoutCompany
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Company context required/i)
  })

  it('returns 400 when enabled_uids exceeds the per-connection cap', async () => {
    const supabase = buildSupabase({
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'pending_selection',
        accounts_data: [],
      },
    })
    const ctx = makeContext(supabase)

    const tooMany = Array.from({ length: 51 }, (_, i) => `acc-${i}`)
    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: tooMany }),
      ctx
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Max 50 konton/i)
  })

  it('emits bank_connection.account_selection_changed after a successful update', async () => {
    const stub: SupabaseStub = {
      authUser: { id: 'user-1' },
      connectionRow: {
        id: 'conn-1',
        status: 'pending_selection',
        accounts_data: [
          { uid: 'acc-1', currency: 'SEK', enabled: true },
          { uid: 'acc-2', currency: 'SEK', enabled: true },
        ],
      },
    }
    const supabase = buildSupabase(stub)
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
      ctx
    )

    expect(res.status).toBe(200)
    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bank_connection.account_selection_changed',
        payload: expect.objectContaining({
          connectionId: 'conn-1',
          previousStatus: 'pending_selection',
          newStatus: 'active',
          enabledCount: 1,
          totalCount: 2,
          userId: 'user-1',
          companyId: 'company-1',
        }),
      })
    )
  })

  describe('inline initial backfill', () => {
    it('runs inline sync on pending_selection→active and writes initial-sync metadata', async () => {
      mockedSync.mockResolvedValue({
        requestedFromDate: '2026-01-01',
        historyNarrowed: false,
        imported: 47,
        duplicates: 3,
        errors: 0,
        returnedMinBookingDate: '2026-02-15',
        returnedMaxBookingDate: '2026-05-13',
      })

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [
            { uid: 'acc-1', currency: 'SEK', enabled: true },
            { uid: 'acc-2', currency: 'EUR', enabled: true },
          ],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-1', 'acc-2'],
          initial_lookback_days: 90,
        }),
        ctx
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      // Backfill summary surfaced to the UI so the user can see what the bank returned.
      expect(body.initial_sync).toMatchObject({
        imported: 94, // 2 accounts × 47
        duplicates: 6,
        returned_min_date: '2026-02-15',
        returned_max_date: '2026-05-13',
      })
      expect(body.initial_sync.requested_from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(body.initial_sync_error).toBeUndefined()

      // syncAccountTransactions called once per enabled account with strategy=longest.
      expect(mockedSync).toHaveBeenCalledTimes(2)
      expect(mockedSync).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'user-1',
        'conn-1',
        expect.objectContaining({ uid: 'acc-1' }),
        expect.any(String),
        expect.any(String),
        undefined,
        { strategy: 'longest' }
      )

      // Configuration is written once; results go through the shared RPC.
      expect(stub.selectionReceipts).toHaveLength(1)
      expect(stub.selectionReceipts?.[0]?.status).toBe('active')
      expect(stub.capturedSync).toMatchObject({
        p_company_id: 'company-1', p_connection_id: 'conn-1',
        p_completed_at: expect.any(String),
        p_initial_sync: { returned_min: '2026-02-15', returned_max: '2026-05-13', lookback_days: 90 },
      })
    })

    it('suppresses auto-categorization and reconciles per ledger account when the window overlaps an SIE import (renewal-flood guard)', async () => {
      mockedSync.mockResolvedValue({
        requestedFromDate: '2026-01-01',
        historyNarrowed: false,
        imported: 22,
        duplicates: 0,
        errors: 0,
        returnedMinBookingDate: '2026-01-05',
        returnedMaxBookingDate: '2026-05-06',
      })
      mockRunReconciliation
        .mockResolvedValueOnce({ matches: [{}, {}, {}, {}], applied: 3, errors: 0, skippedBelowThreshold: 1 })
        .mockResolvedValueOnce({ matches: [{}, {}], applied: 2, errors: 0, skippedBelowThreshold: 0 })

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [
            // ledger_account preset on the stored account: no account_mappings
            // in the request, so the chart/collision validation stays out of scope.
            { uid: 'acc-1', currency: 'SEK', enabled: true, ledger_account: '1930' },
            { uid: 'acc-2', currency: 'EUR', enabled: true },
          ] as StoredAccount[],
        },
        sieImportRow: { id: 'sie-1' },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-1', 'acc-2'],
          initial_lookback_days: 90,
        }),
        ctx
      )

      expect(res.status).toBe(200)
      const body = await res.json()

      // Auto-categorization is suppressed: booking these rows through mapping
      // rules would double-book the already-imported period.
      expect(mockedSync).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'user-1',
        'conn-1',
        expect.objectContaining({ uid: 'acc-1' }),
        expect.any(String),
        expect.any(String),
        undefined,
        { strategy: 'longest', skipAutoCategorization: true }
      )

      // One scoped sweep per distinct ledger account: pooled unscoped runs can
      // cross-link accounts (#1290/#1298). The EUR account had no stored
      // ledger_account, but the PATCH allocator assigns one ('1932') before the
      // backfill, so both sweeps run with a concrete account.
      expect(mockResolveCashAccountScope).toHaveBeenCalledTimes(2)
      expect(mockResolveCashAccountScope).toHaveBeenCalledWith(expect.anything(), 'company-1', '1930')
      expect(mockResolveCashAccountScope).toHaveBeenCalledWith(expect.anything(), 'company-1', '1932')
      expect(mockRunReconciliation).toHaveBeenCalledTimes(2)
      expect(mockRunReconciliation).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'user-1',
        expect.objectContaining({
          accountNumber: '1930',
          currency: 'SEK',
          cashAccountId: 'ca-1930',
          includeUnassigned: false,
          confidenceThreshold: 0.9,
          // The bank over-returned history: the sweep window opens at the
          // oldest returned booking date, not the requested 90-day fromDate,
          // so over-returned rows are swept too.
          dateFrom: '2026-01-05',
          dateTo: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        })
      )

      // Applied links surface to the UI so the user sees the period was
      // recognized, not re-imported as work.
      expect(body.initial_sync.auto_matched).toBe(5)
    })

    it('runs no reconciliation sweep and keeps categorization on without SIE overlap', async () => {
      mockedSync.mockResolvedValue({
        requestedFromDate: '2026-01-01',
        historyNarrowed: false,
        imported: 10,
        duplicates: 0,
        errors: 0,
        returnedMinBookingDate: '2026-05-01',
        returnedMaxBookingDate: '2026-05-13',
      })

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'], initial_lookback_days: 90 }),
        ctx
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(mockedSync).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'user-1',
        'conn-1',
        expect.anything(),
        expect.any(String),
        expect.any(String),
        undefined,
        { strategy: 'longest' }
      )
      expect(mockRunReconciliation).not.toHaveBeenCalled()
      expect(body.initial_sync.auto_matched).toBe(0)
    })

    it('gives viewers rawInsertOnly and no sweep even with SIE overlap (viewers cannot write links)', async () => {
      mockedSync.mockResolvedValue({
        requestedFromDate: '2026-01-01',
        historyNarrowed: false,
        imported: 5,
        duplicates: 0,
        errors: 0,
        returnedMinBookingDate: '2026-05-01',
        returnedMaxBookingDate: '2026-05-13',
      })

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
        },
        sieImportRow: { id: 'sie-1' },
        membershipRow: { role: 'viewer' },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'], initial_lookback_days: 90 }),
        ctx
      )

      expect(res.status).toBe(200)
      expect(mockedSync).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'user-1',
        'conn-1',
        expect.anything(),
        expect.any(String),
        expect.any(String),
        undefined,
        { strategy: 'longest', skipAutoCategorization: true, rawInsertOnly: true }
      )
      expect(mockRunReconciliation).not.toHaveBeenCalled()
    })

    it('skips the sweep for an account whose cash_accounts row did not resolve instead of widening to the pooled form', async () => {
      mockedSync.mockResolvedValue({
        requestedFromDate: '2026-01-01',
        historyNarrowed: false,
        imported: 6,
        duplicates: 0,
        errors: 0,
        returnedMinBookingDate: '2026-05-01',
        returnedMaxBookingDate: '2026-05-13',
      })
      // found: false = no cash_accounts row (e.g. the mirror upsert failed
      // earlier in the request). Running anyway would sweep currency-only
      // across every same-currency account (#1290 write shape).
      mockResolveCashAccountScope.mockResolvedValue({
        accountNumber: '1930',
        currency: 'SEK',
        cashAccountId: undefined,
        includeUnassigned: true,
        found: false,
      })

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true, ledger_account: '1930' }] as StoredAccount[],
        },
        sieImportRow: { id: 'sie-1' },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'], initial_lookback_days: 90 }),
        ctx
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(mockResolveCashAccountScope).toHaveBeenCalled()
      expect(mockRunReconciliation).not.toHaveBeenCalled()
      expect(body.initial_sync.auto_matched).toBe(0)
    })

    it('keeps the backfill successful when the reconciliation sweep throws (non-critical)', async () => {
      mockedSync.mockResolvedValue({
        requestedFromDate: '2026-01-01',
        historyNarrowed: false,
        imported: 8,
        duplicates: 0,
        errors: 0,
        returnedMinBookingDate: '2026-05-01',
        returnedMaxBookingDate: '2026-05-13',
      })
      mockRunReconciliation.mockRejectedValue(new Error('recon exploded'))

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
        },
        sieImportRow: { id: 'sie-1' },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'], initial_lookback_days: 90 }),
        ctx
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.initial_sync).toMatchObject({ imported: 8, auto_matched: 0 })
      expect(body.initial_sync_error).toBeUndefined()
    })

    it('does NOT run inline sync when connection is already active (selection edit)', async () => {
      mockedSync.mockResolvedValue({
        requestedFromDate: '2026-01-01',
        historyNarrowed: false,
        imported: 99,
        duplicates: 0,
        errors: 0,
        returnedMinBookingDate: '2026-01-01',
        returnedMaxBookingDate: '2026-05-13',
      })

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        connectionRow: {
          id: 'conn-1',
          status: 'active',
          accounts_data: [
            { uid: 'acc-1', currency: 'SEK', enabled: true },
            { uid: 'acc-2', currency: 'SEK', enabled: false },
          ],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-2'] }),
        ctx
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.initial_sync).toBeUndefined()
      expect(body.initial_sync_error).toBeUndefined()

      expect(mockedSync).not.toHaveBeenCalled()
      // Only one update: the original selection edit, no metadata follow-up.
      expect(stub.selectionReceipts).toHaveLength(1)
    })

    it('still flips status to active when inline sync fails, surfacing initial_sync_error', async () => {
      mockedSync.mockRejectedValue(new Error('ASPSP_DOWN'))

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-1'],
          initial_lookback_days: 180,
        }),
        ctx
      )

      // PATCH still succeeds: the cron will retry the backfill on its next run.
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.initial_sync).toBeUndefined()
      expect(body.initial_sync_error).toBe('ASPSP_DOWN')

      // Status flip happened; no metadata follow-up because sync threw.
      expect(stub.selectionReceipts).toHaveLength(1)
      expect(stub.selectionReceipts?.[0]?.status).toBe('active')
    })

    it('clamps initial_lookback_days to [30, 365]', async () => {
      mockedSync.mockResolvedValue({
        requestedFromDate: '2026-01-01',
        historyNarrowed: false,
        imported: 0,
        duplicates: 0,
        errors: 0,
      })

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      // 9999 days → clamped to 365
      await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-1'],
          initial_lookback_days: 9999,
        }),
        ctx
      )

      expect(stub.capturedSync?.p_initial_sync).toMatchObject({ lookback_days: 365 })
    })

    it('surfaces persistence failure after a successful sync', async () => {
      // Sync runs and ingests transactions, but persisting initial_sync_completed_at
      // fails. The client must see the failure (not a fake success) so the UI can
      // show a retry warning; the cron will gate on initial_sync_completed_at IS NULL
      // and self-heal on its next run.
      mockedSync.mockResolvedValue({
        requestedFromDate: '2026-01-01',
        historyNarrowed: false,
        imported: 12,
        duplicates: 0,
        errors: 0,
        returnedMinBookingDate: '2026-03-01',
        returnedMaxBookingDate: '2026-05-13',
      })

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
        },
        // First update (status flip) succeeds; second (metadata) fails.
        syncError: { message: 'connection lost' },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-1'],
          initial_lookback_days: 90,
        }),
        ctx
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      // No fake success: initial_sync must NOT be populated.
      expect(body.initial_sync).toBeUndefined()
      // The error code surfaces the metadata-update failure mode so the UI
      // and audit log can distinguish it from an ingest-side failure.
      expect(body.initial_sync_error).toContain('connection lost')
      // Status flip still happened: connection is active, cron will retry backfill.
      expect(stub.selectionReceipts?.[0]?.status).toBe('active')
      expect(stub.selectionReceipts).toHaveLength(1)
    })
  })

  describe('per-account ledger mapping (account_mappings)', () => {
    it('persists ledger_account from account_mappings into accounts_data JSONB', async () => {
      mockedSync.mockResolvedValue({ requestedFromDate: '2026-01-01', historyNarrowed: false, imported: 0, duplicates: 0, errors: 0 })

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        chartAccountNumbers: ['1930', '1932', '1933'],
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [
            { uid: 'acc-sek', currency: 'SEK', enabled: true },
            { uid: 'acc-eur', currency: 'EUR', enabled: true },
            { uid: 'acc-usd', currency: 'USD', enabled: true },
          ],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-sek', 'acc-eur', 'acc-usd'],
          account_mappings: [
            { uid: 'acc-sek', ledger_account: '1930' },
            { uid: 'acc-eur', ledger_account: '1932' },
            { uid: 'acc-usd', ledger_account: '1933' },
          ],
        }),
        ctx
      )

      expect(res.status).toBe(200)
      const written = stub.selectionReceipts?.[0]?.accounts_data as StoredAccount[]
      expect(written.find(a => a.uid === 'acc-sek')?.ledger_account).toBe('1930')
      expect(written.find(a => a.uid === 'acc-eur')?.ledger_account).toBe('1932')
      expect(written.find(a => a.uid === 'acc-usd')?.ledger_account).toBe('1933')
    })

    it('rejects ledger_account not in BAS class 19 (e.g. 3001 revenue)', async () => {
      // Even though 3001 might exist in the chart, routing the bank-side leg
      // there would silently misroute every transaction into a revenue account.
      // The class-19 restriction must be enforced at the API layer regardless of
      // whether the chart contains the supplied account number.
      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        chartAccountNumbers: ['1930', '3001'],
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-1'],
          account_mappings: [{ uid: 'acc-1', ledger_account: '3001' }],
        }),
        ctx
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/klass 19/)
    })

    it('rejects ledger_account that is malformed (not 4 digits)', async () => {
      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        chartAccountNumbers: ['1930'],
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-1'],
          account_mappings: [{ uid: 'acc-1', ledger_account: '19' }],
        }),
        ctx
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/klass 19/)
    })

    it('rejects ledger_account that does not exist in chart_of_accounts', async () => {
      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        chartAccountNumbers: ['1930'], // 1932 not in chart
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-eur', currency: 'EUR', enabled: true }],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-eur'],
          account_mappings: [{ uid: 'acc-eur', ledger_account: '1932' }],
        }),
        ctx
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/finns inte i kontoplanen/)
      expect(body.invalid_accounts).toEqual(['1932'])
    })

    it('preserves existing ledger_account when account_mappings is omitted (selection edit)', async () => {
      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        connectionRow: {
          id: 'conn-1',
          status: 'active',
          accounts_data: [
            { uid: 'acc-1', currency: 'SEK', enabled: true, ledger_account: '1930' },
            { uid: 'acc-2', currency: 'EUR', enabled: true, ledger_account: '1932' },
          ],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        // No account_mappings: pure selection edit (disable acc-2)
        makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
        ctx
      )

      expect(res.status).toBe(200)
      const written = stub.selectionReceipts?.[0]?.accounts_data as StoredAccount[]
      // Both ledger_account values stay intact even though acc-2 is now disabled.
      expect(written.find(a => a.uid === 'acc-1')?.ledger_account).toBe('1930')
      expect(written.find(a => a.uid === 'acc-2')?.ledger_account).toBe('1932')
    })

    it('re-allocates ledger_account when account_mappings entry sets it to null', async () => {
      // Explicit null means "reset to auto". accounts_data must always mirror
      // the effective cash_accounts assignment, so the cleared account gets a
      // fresh allocation instead of an undefined that silently falls back to
      // 1930 at mirror time.
      mockedSync.mockResolvedValue({ requestedFromDate: '2026-01-01', historyNarrowed: false, imported: 0, duplicates: 0, errors: 0 })

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        chartAccountNumbers: ['1930'],
        connectionRow: {
          id: 'conn-1',
          status: 'active',
          accounts_data: [
            { uid: 'acc-1', currency: 'SEK', enabled: true, ledger_account: '1930' },
          ],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-1'],
          account_mappings: [{ uid: 'acc-1', ledger_account: null }],
        }),
        ctx
      )

      expect(res.status).toBe(200)
      expect(mockAllocate).toHaveBeenCalledTimes(1)
      const written = stub.selectionReceipts?.[0]?.accounts_data as StoredAccount[]
      expect(written.find(a => a.uid === 'acc-1')?.ledger_account).toBe('1930')
    })

    it('returns 400 when two accounts map to the same ledger_account', async () => {
      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        chartAccountNumbers: ['1930'],
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [
            { uid: 'acc-1', currency: 'SEK', enabled: true },
            { uid: 'acc-2', currency: 'SEK', enabled: true },
          ],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-1', 'acc-2'],
          account_mappings: [
            { uid: 'acc-1', ledger_account: '1930' },
            { uid: 'acc-2', ledger_account: '1930' },
          ],
        }),
        ctx
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/samma konto/i)
      expect(body.duplicate_accounts).toEqual(['1930'])
      // Nothing written — the collision is rejected before any update.
      expect(stub.selectionReceipts).toBeUndefined()
      expect(stub.selectionCalls).toBeUndefined()
    })

    it('returns 400 when a mapping targets a ledger held by another connection', async () => {
      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        chartAccountNumbers: ['1935'],
        cashAccountRows: [
          { external_uid: 'other-acc', bank_connection_id: 'conn-OTHER', ledger_account: '1935' },
        ],
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-1'],
          account_mappings: [{ uid: 'acc-1', ledger_account: '1935' }],
        }),
        ctx
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/annan bankanslutning/i)
      expect(body.conflicting_accounts).toEqual(['1935'])
    })

    it('allows a mapping onto a ledger held only by a REVOKED connection (self-heal after disconnect)', async () => {
      // Issue #916: rows orphaned by a disconnect that predates the ledger
      // claim release still point at the revoked connection. They must not
      // count as foreign claims: the save goes through and upsertFromPsd2
      // promotes the orphaned row in place.
      mockedSync.mockResolvedValue({ requestedFromDate: '2026-01-01', historyNarrowed: false, imported: 0, duplicates: 0, errors: 0 })
      mockGetRevokedConnectionIds.mockResolvedValue(new Set(['conn-REVOKED']))

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        chartAccountNumbers: ['1930'],
        cashAccountRows: [
          { external_uid: 'old-acc', bank_connection_id: 'conn-REVOKED', ledger_account: '1930' },
        ],
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-1'],
          account_mappings: [{ uid: 'acc-1', ledger_account: '1930' }],
        }),
        ctx
      )

      expect(res.status).toBe(200)
      // The revoked-status lookup was scoped to the foreign connection ids.
      expect(mockGetRevokedConnectionIds).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        ['conn-REVOKED']
      )
      // The mirror received the user's pick, not an overflow slot.
      expect(stub.selectionCalls?.[0]?.p_selections).toEqual(expect.arrayContaining([expect.objectContaining({
          uid: 'acc-1',
          ledger_account: '1930',
        })]))
    })

    it('allocates distinct ledgers for legacy accounts with no mapping at all', async () => {
      mockedSync.mockResolvedValue({ requestedFromDate: '2026-01-01', historyNarrowed: false, imported: 0, duplicates: 0, errors: 0 })

      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [
            { uid: 'acc-1', currency: 'SEK', enabled: true },
            { uid: 'acc-2', currency: 'SEK', enabled: true },
          ],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1', 'acc-2'] }),
        ctx
      )

      expect(res.status).toBe(200)
      const written = stub.selectionReceipts?.[0]?.accounts_data as StoredAccount[]
      expect(written.find(a => a.uid === 'acc-1')?.ledger_account).toBe('1930')
      expect(written.find(a => a.uid === 'acc-2')?.ledger_account).toBe('1931')
      // The mirror received the same distinct assignments.
      const mirrorLedgers = (stub.selectionCalls?.[0]?.p_selections as StoredAccount[]).map(a => a.ledger_account)
      expect(mirrorLedgers.sort()).toEqual(['1930', '1931'])
    })

    it('preserves the mirrored cash_accounts ledger for accounts without a stored value', async () => {
      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        cashAccountRows: [
          { external_uid: 'acc-1', bank_connection_id: 'conn-1', ledger_account: '1940' },
        ],
        connectionRow: {
          id: 'conn-1',
          status: 'active',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
        ctx
      )

      expect(res.status).toBe(200)
      // No allocation — the existing mirrored assignment wins.
      expect(mockAllocate).not.toHaveBeenCalled()
      const written = stub.selectionReceipts?.[0]?.accounts_data as StoredAccount[]
      expect(written.find(a => a.uid === 'acc-1')?.ledger_account).toBe('1940')
    })

    describe('unchecked accounts hold their ledger only as a soft claim', () => {
      // The reported dead end (support case 2026-09-09): the wrong bank
      // account had been synced onto 1930, the user unchecked it and put the
      // right one on 1930, and the save answered 400 because the unchecked
      // account still counted as a claim. The picker hides the ledger
      // dropdown for unchecked rows and disconnect + reconnect re-claims the
      // same rows by IBAN, so no route led out of it.

      it('lets a checked account take 1930 from an unchecked one on the same connection', async () => {
        mockedSync.mockResolvedValue({ requestedFromDate: '2026-01-01', historyNarrowed: false, imported: 0, duplicates: 0, errors: 0 })
        const stub: SupabaseStub = {
          authUser: { id: 'user-1' },
          chartAccountNumbers: ['1930'],
          cashAccountRows: [
            { id: 'row-1930', external_uid: 'acc-wrong', bank_connection_id: 'conn-1', ledger_account: '1930' },
            { id: 'row-1935', external_uid: 'acc-right', bank_connection_id: 'conn-1', ledger_account: '1935' },
          ],
          connectionRow: {
            id: 'conn-1',
            status: 'pending_selection',
            accounts_data: [
              { uid: 'acc-wrong', currency: 'SEK', enabled: true, ledger_account: '1930' },
              { uid: 'acc-right', currency: 'SEK', enabled: true, ledger_account: '1935' },
            ],
          },
        }
        const supabase = buildSupabase(stub)
        const ctx = makeContext(supabase)

        const res = await accountsRoute.handler(
          makeRequest({
            connection_id: 'conn-1',
            enabled_uids: ['acc-right'],
            account_mappings: [{ uid: 'acc-right', ledger_account: '1930' }],
          }),
          ctx
        )

        expect(res.status).toBe(200)
        // accounts_data: the unchecked account no longer pre-fills 1930, the checked one holds it.
        const written = stub.selectionReceipts?.[0]?.accounts_data as StoredAccount[]
        const wrong = written.find(a => a.uid === 'acc-wrong')
        expect(wrong?.enabled).toBe(false)
        expect(wrong).not.toHaveProperty('ledger_account')
        expect(written.find(a => a.uid === 'acc-right')?.ledger_account).toBe('1930')
        // The mirror only touches the checked account; the yielded one has no row to write.
        expect((stub.selectionCalls?.[0]?.p_selections as StoredAccount[]).filter(a => a.ledger_account)).toHaveLength(1)
        expect(stub.selectionCalls?.[0]?.p_selections).toEqual(expect.arrayContaining([expect.objectContaining({ uid: 'acc-right', ledger_account: '1930', enabled: true })]))
        expect(mockAllocate).not.toHaveBeenCalled()
      })

      it('keeps an unchecked account on its ledger when nobody claims it, mirrored as disabled', async () => {
        const stub: SupabaseStub = {
          authUser: { id: 'user-1' },
          cashAccountRows: [
            { id: 'row-1930', external_uid: 'acc-1', bank_connection_id: 'conn-1', ledger_account: '1930' },
            { id: 'row-1935', external_uid: 'acc-2', bank_connection_id: 'conn-1', ledger_account: '1935' },
          ],
          connectionRow: {
            id: 'conn-1',
            status: 'active',
            accounts_data: [
              { uid: 'acc-1', currency: 'SEK', enabled: true, ledger_account: '1930' },
              { uid: 'acc-2', currency: 'SEK', enabled: true, ledger_account: '1935' },
            ],
          },
        }
        const supabase = buildSupabase(stub)
        const ctx = makeContext(supabase)

        const res = await accountsRoute.handler(
          makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
          ctx
        )

        expect(res.status).toBe(200)
        const written = stub.selectionReceipts?.[0]?.accounts_data as StoredAccount[]
        expect(written.find(a => a.uid === 'acc-2')).toMatchObject({ enabled: false, ledger_account: '1935' })
        // Re-checking later lands back on 1935: the row stays, its enabled flag flips off.
        expect(stub.selectionCalls?.[0]?.p_selections).toHaveLength(2)
        expect(stub.selectionCalls?.[0]?.p_selections).toEqual(expect.arrayContaining([expect.objectContaining({ uid: 'acc-2', ledger_account: '1935', enabled: false })]))
      })

      it('submits both requested ledger changes in one checked save', async () => {
        const stub: SupabaseStub = {
          authUser: { id: 'user-1' },
          chartAccountNumbers: ['1930', '1935'],
          cashAccountRows: [
            { id: 'row-1930', external_uid: 'acc-1', bank_connection_id: 'conn-1', ledger_account: '1930' },
            { id: 'row-1935', external_uid: 'acc-2', bank_connection_id: 'conn-1', ledger_account: '1935' },
          ],
          connectionRow: {
            id: 'conn-1',
            status: 'active',
            accounts_data: [
              { uid: 'acc-1', currency: 'SEK', enabled: true, ledger_account: '1930' },
              { uid: 'acc-2', currency: 'SEK', enabled: true, ledger_account: '1935' },
            ],
          },
        }
        const supabase = buildSupabase(stub)
        const ctx = makeContext(supabase)

        const res = await accountsRoute.handler(
          makeRequest({
            connection_id: 'conn-1',
            enabled_uids: ['acc-1', 'acc-2'],
            account_mappings: [
              { uid: 'acc-1', ledger_account: '1935' },
              { uid: 'acc-2', ledger_account: '1930' },
            ],
          }),
          ctx
        )

        expect(res.status).toBe(200)
        // Both assignments are submitted together; the database validates their physical identity.
        const written = stub.selectionReceipts?.[0]?.accounts_data as StoredAccount[]
        expect(written.find(a => a.uid === 'acc-1')?.ledger_account).toBe('1935')
        expect(written.find(a => a.uid === 'acc-2')?.ledger_account).toBe('1930')
        const mirrored = (stub.selectionCalls?.[0]?.p_selections as StoredAccount[]).map(a => [a.uid, a.ledger_account])
        expect(mirrored.sort()).toEqual([
          ['acc-1', '1935'],
          ['acc-2', '1930'],
        ])
      })

      it('lets a mapping take a ledger held by an account that is unchecked in another connection', async () => {
        mockedSync.mockResolvedValue({ requestedFromDate: '2026-01-01', historyNarrowed: false, imported: 0, duplicates: 0, errors: 0 })
        const stub: SupabaseStub = {
          authUser: { id: 'user-1' },
          chartAccountNumbers: ['1935'],
          cashAccountRows: [
            {
              id: 'row-other',
              external_uid: 'other-acc',
              bank_connection_id: 'conn-OTHER',
              ledger_account: '1935',
              enabled: false,
            },
          ],
          connectionRow: {
            id: 'conn-1',
            status: 'pending_selection',
            accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
          },
        }
        const supabase = buildSupabase(stub)
        const ctx = makeContext(supabase)

        const res = await accountsRoute.handler(
          makeRequest({
            connection_id: 'conn-1',
            enabled_uids: ['acc-1'],
            account_mappings: [{ uid: 'acc-1', ledger_account: '1935' }],
          }),
          ctx
        )

        // Contrast with the synced-elsewhere case above, which stays a 400.
        expect(res.status).toBe(200)
        expect(stub.selectionCalls?.[0]?.p_selections).toEqual(expect.arrayContaining([expect.objectContaining({ uid: 'acc-1', ledger_account: '1935' })]))
      })

      it('returns 500 without starting sync when the atomic selection fails', async () => {
        const stub: SupabaseStub = {
          authUser: { id: 'user-1' },
          chartAccountNumbers: ['1930'],
          selectionError: { message: 'boom' },
          cashAccountRows: [
            { id: 'row-1930', external_uid: 'acc-wrong', bank_connection_id: 'conn-1', ledger_account: '1930' },
            { id: 'row-1935', external_uid: 'acc-right', bank_connection_id: 'conn-1', ledger_account: '1935' },
          ],
          connectionRow: {
            id: 'conn-1',
            status: 'active',
            accounts_data: [
              { uid: 'acc-wrong', currency: 'SEK', enabled: true, ledger_account: '1930' },
              { uid: 'acc-right', currency: 'SEK', enabled: true, ledger_account: '1935' },
            ],
          },
        }
        const supabase = buildSupabase(stub)
        const ctx = makeContext(supabase)

        const res = await accountsRoute.handler(
          makeRequest({
            connection_id: 'conn-1',
            enabled_uids: ['acc-right'],
            account_mappings: [{ uid: 'acc-right', ledger_account: '1930' }],
          }),
          ctx
        )

        expect(res.status).toBe(500)
        expect(stub.selectionReceipts).toBeUndefined()
        expect(stub.selectionCalls).toHaveLength(1)
        expect(mockedSync).not.toHaveBeenCalled()
      })
    })

    it('rejects account_mappings that is not an array', async () => {
      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-1'],
          account_mappings: 'not-an-array',
        }),
        ctx
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/account_mappings/)
    })

    it('rejects account_mappings with UIDs not in the connection accounts_data', async () => {
      // Mirrors the enabled_uids guard. Without this, a typo'd UID is silently
      // dropped (the entry never lands in accounts_data) while the response is
      // still 200, leaving the client to believe the mapping was applied.
      const stub: SupabaseStub = {
        authUser: { id: 'user-1' },
        chartAccountNumbers: ['1930', '1932'],
        connectionRow: {
          id: 'conn-1',
          status: 'pending_selection',
          accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
        },
      }
      const supabase = buildSupabase(stub)
      const ctx = makeContext(supabase)

      const res = await accountsRoute.handler(
        makeRequest({
          connection_id: 'conn-1',
          enabled_uids: ['acc-1'],
          account_mappings: [
            { uid: 'acc-1', ledger_account: '1930' },
            { uid: 'acc-typo', ledger_account: '1932' }, // not in accounts_data
          ],
        }),
        ctx
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/account_mappings/)
      expect(body.unknown_uids).toEqual(['acc-typo'])
    })
  })
})
