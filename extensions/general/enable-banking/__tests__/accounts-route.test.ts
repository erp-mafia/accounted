import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the sync module before importing the extension so the route handler picks up the spy.
vi.mock('../lib/sync', () => ({
  syncAccountTransactions: vi.fn(),
}))

// Mock the cash-accounts service (dynamically imported by the route) so the
// mirror + allocation passes are deterministic and observable.
const { mockUpsertFromPsd2, mockAllocate, mockGetRevokedConnectionIds } = vi.hoisted(() => ({
  mockUpsertFromPsd2: vi.fn(),
  mockAllocate: vi.fn(),
  mockGetRevokedConnectionIds: vi.fn(),
}))
vi.mock('@/lib/cash-accounts/service', () => ({
  upsertFromPsd2: (...args: unknown[]) => mockUpsertFromPsd2(...args),
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
  connectionError?: { message: string } | null
  /** Error returned for every update. Use updateErrorByCall for per-call control. */
  updateError?: { message: string } | null
  /**
   * Per-call update errors. Indexed by 0-based call number. Lets a test
   * succeed the first update (status flip) and fail the second (metadata).
   * Falls back to updateError when the index isn't present.
   */
  updateErrorByCall?: Array<{ message: string } | null>
  /** BAS account numbers that exist in the company's chart_of_accounts (PR 2 ledger validation). */
  chartAccountNumbers?: string[]
  /** Existing cash_accounts rows for the company (ledger collision validation). */
  cashAccountRows?: Array<{
    external_uid: string | null
    bank_connection_id: string | null
    ledger_account: string
  }>
  /** Completed SIE import overlapping the backfill window (renewal-flood guard). */
  sieImportRow?: { id: string } | null
  /** company_members row for the caller; role 'viewer' disables the sweep. */
  membershipRow?: { role: string } | null
  /** Last update payload (may be overwritten by a follow-up metadata update). */
  capturedUpdate?: Record<string, unknown>
  /** All update payloads in order: first is the status flip, second the initial-sync metadata. */
  capturedUpdates?: Record<string, unknown>[]
}

function buildSupabase(stub: SupabaseStub) {
  let updateCallCount = 0
  return {
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
        update: vi.fn((payload: Record<string, unknown>) => {
          const callIndex = updateCallCount++
          stub.capturedUpdate = payload
          ;(stub.capturedUpdates ??= []).push(payload)
          // Per-call error overrides win when set; fall back to updateError otherwise.
          const error =
            stub.updateErrorByCall && callIndex < stub.updateErrorByCall.length
              ? stub.updateErrorByCall[callIndex]
              : stub.updateError ?? null
          return {
            eq: vi.fn().mockResolvedValue({ error }),
          }
        }),
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
    mockUpsertFromPsd2.mockResolvedValue(undefined)
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
      connectionError: { message: 'not found' },
    })
    const ctx = makeContext(supabase)

    const res = await accountsRoute.handler(
      makeRequest({ connection_id: 'conn-1', enabled_uids: ['acc-1'] }),
      ctx
    )
    expect(res.status).toBe(404)
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

    // The first update (before inline backfill) is the status flip + accounts_data.
    // A second metadata update only follows if backfill succeeds; assert against
    // the first explicitly so this test is robust to both paths.
    const firstUpdate = stub.capturedUpdates?.[0]
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
    const written = stub.capturedUpdate?.accounts_data as StoredAccount[]
    expect(written.find(a => a.uid === 'acc-1')?.enabled).toBe(false)
    expect(written.find(a => a.uid === 'acc-2')?.enabled).toBe(true)
  })

  it('omits status from update payload when connection is already active (state machine)', async () => {
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
    // Status field is NOT present in the update: already-active connections
    // don't re-assert the transition, which keeps the state machine explicit.
    expect(stub.capturedUpdate).toBeDefined()
    expect('status' in (stub.capturedUpdate ?? {})).toBe(false)
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

      // Two updates: status flip first, then initial_sync metadata.
      expect(stub.capturedUpdates).toHaveLength(2)
      expect(stub.capturedUpdates?.[0]?.status).toBe('active')
      const meta = stub.capturedUpdates?.[1]
      expect(meta?.initial_sync_completed_at).toBeDefined()
      expect(meta?.initial_sync_returned_min_date).toBe('2026-02-15')
      expect(meta?.initial_sync_returned_max_date).toBe('2026-05-13')
      expect(meta?.initial_sync_lookback_days).toBe(90)
      expect(meta?.last_synced_at).toBeDefined()
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
      expect(stub.capturedUpdates).toHaveLength(1)
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
      expect(stub.capturedUpdates).toHaveLength(1)
      expect(stub.capturedUpdates?.[0]?.status).toBe('active')
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

      expect(stub.capturedUpdates?.[1]?.initial_sync_lookback_days).toBe(365)
    })

    it('surfaces metadata_update_failed when the second update errors after a successful sync', async () => {
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
        updateErrorByCall: [null, { message: 'connection lost' }],
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
      expect(body.initial_sync_error).toMatch(/^metadata_update_failed:/)
      // Status flip still happened: connection is active, cron will retry backfill.
      expect(stub.capturedUpdates?.[0]?.status).toBe('active')
      expect(stub.capturedUpdates).toHaveLength(2)
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
      const written = stub.capturedUpdates?.[0]?.accounts_data as StoredAccount[]
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
      const written = stub.capturedUpdates?.[0]?.accounts_data as StoredAccount[]
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
      const written = stub.capturedUpdates?.[0]?.accounts_data as StoredAccount[]
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
      expect(stub.capturedUpdates).toBeUndefined()
      expect(mockUpsertFromPsd2).not.toHaveBeenCalled()
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
      expect(mockUpsertFromPsd2).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        expect.objectContaining({
          bank_connection_id: 'conn-1',
          external_uid: 'acc-1',
          ledger_account: '1930',
        })
      )
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
      const written = stub.capturedUpdates?.[0]?.accounts_data as StoredAccount[]
      expect(written.find(a => a.uid === 'acc-1')?.ledger_account).toBe('1930')
      expect(written.find(a => a.uid === 'acc-2')?.ledger_account).toBe('1931')
      // The mirror received the same distinct assignments.
      const mirrorLedgers = mockUpsertFromPsd2.mock.calls.map(
        (c) => (c[2] as { ledger_account: string }).ledger_account,
      )
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
      const written = stub.capturedUpdates?.[0]?.accounts_data as StoredAccount[]
      expect(written.find(a => a.uid === 'acc-1')?.ledger_account).toBe('1940')
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
