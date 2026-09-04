import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies: factory must not reference outer variables
const mockCreateSession = vi.fn()
const mockGetAccountBalance = vi.fn()
vi.mock('@/extensions/general/enable-banking/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/extensions/general/enable-banking/lib/api-client')>()
  return {
    // Pure identifier extraction: keep the real implementation so the stored
    // accounts carry what the bank actually sent.
    extractBban: actual.extractBban,
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    getAccountBalance: (...args: unknown[]) => mockGetAccountBalance(...args),
  }
})

// Use hoisted to safely create mock objects referenced in vi.mock factories
const {
  mockFrom,
  mockUpsertFromPsd2,
  mockAllocate,
  mockSupersede,
  mockCrossCompanyContext,
  mockGetUser,
} = vi.hoisted(() => {
  const mockFrom = vi.fn()
  const mockUpsertFromPsd2 = vi.fn()
  const mockAllocate = vi.fn()
  const mockSupersede = vi.fn()
  const mockCrossCompanyContext = vi.fn()
  // The cookie session the callback binds the completion to. Every pending
  // row in this suite belongs to 'user-1', so that is the default session.
  const mockGetUser = vi.fn()
  return {
    mockFrom,
    mockUpsertFromPsd2,
    mockAllocate,
    mockSupersede,
    mockCrossCompanyContext,
    mockGetUser,
  }
})

// The supersede pass has its own unit tests (extensions/general/enable-banking/
// __tests__/supersede.test.ts); here it is mocked so these tests assert the
// callback WIRES it correctly without scripting its internal queries.
vi.mock('@/extensions/general/enable-banking/lib/supersede', () => ({
  supersedeSiblingConnections: (...args: unknown[]) => mockSupersede(...args),
}))

// The cross-company claim lookup has its own unit tests (extensions/general/
// enable-banking/lib/__tests__/session-sharing.test.ts); mocked here so the
// per-test mockFrom scripts don't have to answer its queries too. Everything
// else in session-sharing stays real.
vi.mock('@/extensions/general/enable-banking/lib/session-sharing', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/extensions/general/enable-banking/lib/session-sharing')>()
  return {
    ...actual,
    fetchCrossCompanyAccountContext: (...args: unknown[]) => mockCrossCompanyContext(...args),
  }
})

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn().mockResolvedValue({
    from: mockFrom,
  }),
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
  }),
}))

const CURRENCY_DEFAULTS: Record<string, string> = {
  SEK: '1930',
  EUR: '1932',
  USD: '1933',
  GBP: '1934',
}

vi.mock('@/lib/cash-accounts/service', () => ({
  upsertFromPsd2: (...args: unknown[]) => mockUpsertFromPsd2(...args),
  // The route resolves ledgers through resolvePsd2LedgerAccount (IBAN match
  // first, allocation second). mockAllocate remains the allocation stand-in;
  // the wrapper puts its answer in the resolver's envelope so the existing
  // "did we allocate?" assertions keep their meaning. Tests that exercise the
  // IBAN path override resolvePsd2LedgerAccount's outcome via mockAllocate's
  // own implementation.
  resolvePsd2LedgerAccount: async (...args: unknown[]) => {
    const ledgerAccount = await mockAllocate(...args)
    if (!ledgerAccount) return null
    if (typeof ledgerAccount === 'object') return ledgerAccount
    return { ledgerAccount, reuseCashAccountId: null, source: 'allocated' }
  },
  defaultLedgerForCurrency: (currency: string) =>
    CURRENCY_DEFAULTS[currency.toUpperCase()] ?? '1930',
  // Real (trivial) implementation: the route normalizes IBANs when stamping
  // dedup scopes onto accounts_data.
  normalizeIban: (iban?: string | null) => {
    if (!iban) return null
    const normalized = iban.replace(/\s+/g, '').toUpperCase()
    return normalized || null
  },
}))

vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')

import { GET } from '../route'
import { eventBus } from '@/lib/events/bus'

function makeRequest(params: Record<string, string>) {
  const url = new URL('http://localhost:3000/api/extensions/enable-banking/callback')
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return new Request(url.toString())
}

function mockChain(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'is', 'single', 'update', 'delete', 'order', 'limit']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  chain.single = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  // For chains ending without .single()
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: result.data ?? null, error: result.error ?? null })
  return chain
}

describe('GET /api/extensions/enable-banking/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockUpsertFromPsd2.mockResolvedValue(undefined)
    mockSupersede.mockResolvedValue({ supersededIds: [], dedupScopeByIban: new Map() })
    // No sibling company claims anything by default; individual tests override.
    mockCrossCompanyContext.mockResolvedValue({
      claims: new Map(),
      deselectedIbans: new Set(),
      activeCompanyIbans: new Set(),
    })
    // Allocator stand-in mirroring the real behavior: currency default first,
    // then the next free 1931–1959 slot (skipping other currency defaults).
    mockAllocate.mockImplementation(
      async (
        _supabase: unknown,
        _companyId: unknown,
        _userId: unknown,
        input: { currency: string; exclude?: ReadonlySet<string> },
      ) => {
        const preferred = CURRENCY_DEFAULTS[input.currency.toUpperCase()] ?? '1930'
        const exclude = input.exclude ?? new Set<string>()
        if (!exclude.has(preferred)) return preferred
        const reserved = new Set(Object.values(CURRENCY_DEFAULTS))
        for (let n = 1931; n <= 1959; n++) {
          const candidate = String(n)
          if (!reserved.has(candidate) && !exclude.has(candidate)) return candidate
        }
        return null
      },
    )
  })

  it('rejects when state does not match any pending connection', async () => {
    mockFrom.mockImplementation(() =>
      mockChain({ data: null, error: { message: 'not found' } })
    )

    const response = await GET(makeRequest({ code: 'auth-code', state: 'unknown-state' }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    expect(location).toContain('/settings/banking?')
    // The raw 'invalid_state' token used to be shown verbatim: the banner now
    // carries the Swedish explanation instead (issue #1716).
    expect(decodeURIComponent(location)).toContain('Starta bankkopplingen på nytt')
  })

  // The state token proves the callback belongs to a flow WE started, not that
  // the browser completing it is the initiator's. A victim lured into
  // approving a consent someone else started must not have their bank
  // attached to that someone's company.
  describe('initiator binding', () => {
    const PENDING_ROW = {
      id: 'conn-1',
      user_id: 'user-1',
      company_id: 'company-1',
      bank_name: 'TestBank',
      status: 'pending',
      session_id: null,
      accounts_data: null,
    }

    it('refuses a consent completed by a different user and leaves the row untouched', async () => {
      const chain = mockChain({ data: PENDING_ROW, error: null })
      mockFrom.mockReturnValue(chain)
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-2' } }, error: null })

      const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))

      expect(response.status).toBe(307)
      const location = new URL(response.headers.get('location') || '')
      expect(location.pathname).toBe('/settings/banking')
      expect(location.searchParams.get('bank_error')).toContain('annat användarkonto')
      expect(location.searchParams.get('bank_name')).toBe('TestBank')
      expect(location.searchParams.has('select_accounts')).toBe(false)

      // The code was never exchanged and nothing was written: the row keeps
      // waiting for its initiator (only the lookup touched the table).
      expect(mockCreateSession).not.toHaveBeenCalled()
      expect(mockFrom).toHaveBeenCalledTimes(1)
      expect(chain.update).not.toHaveBeenCalled()
      expect(chain.delete).not.toHaveBeenCalled()
      expect(mockUpsertFromPsd2).not.toHaveBeenCalled()
    })

    it('sends an anonymous browser to /login with the callback URL preserved', async () => {
      const chain = mockChain({ data: PENDING_ROW, error: null })
      mockFrom.mockReturnValue(chain)
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

      const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))

      expect(response.status).toBe(307)
      const location = new URL(response.headers.get('location') || '')
      expect(location.origin).toBe('http://localhost:3000')
      expect(location.pathname).toBe('/login')
      expect(location.searchParams.get('next')).toBe(
        '/api/extensions/enable-banking/callback?code=auth-code&state=valid-state',
      )

      expect(mockCreateSession).not.toHaveBeenCalled()
      expect(chain.update).not.toHaveBeenCalled()
      expect(chain.delete).not.toHaveBeenCalled()
    })

    it('finalizes as before when the session belongs to the initiator', async () => {
      // mockConnectionFlow is the suite's standard script for the finalize
      // path (function declaration below, hoisted into this scope).
      mockConnectionFlow(PENDING_ROW)
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
      mockCreateSession.mockResolvedValue({
        session_id: 'sess-1',
        accounts: [],
        access: { valid_until: '2027-12-31T00:00:00Z' },
        aspsp: { name: 'TestBank', country: 'SE' },
      })

      const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))

      expect(response.status).toBe(200)
      expect(mockGetUser).toHaveBeenCalledTimes(1)
      expect(mockCreateSession).toHaveBeenCalledWith('auth-code', undefined)
      expect(await response.text()).toContain('select_accounts=conn-1')
    })

    it('does not consult the session for an unknown state (nothing to bind to)', async () => {
      mockFrom.mockImplementation(() => mockChain({ data: null, error: { message: 'not found' } }))

      await GET(makeRequest({ code: 'auth-code', state: 'unknown-state' }))

      expect(mockGetUser).not.toHaveBeenCalled()
    })

    it('leaves the hosted connector bounce alone (server-to-server, HMAC-verified)', async () => {
      // The hosted proxy callback never finalizes anything: it verifies the
      // signed connector state and bounces the browser to the instance, whose
      // own callback then runs the binding against ITS session.
      vi.stubEnv('CONNECTOR_STATE_SECRET', 'test-connector-secret')
      const { signConnectorState } = await import('@/lib/connect/hosted/state')
      const connectorState = signConnectorState({
        kid: 'key-1',
        svc: 'bank',
        ret: 'https://instance.example.se/api/extensions/enable-banking/callback',
        st: 'instance-state',
        cref: 'company-ref',
      })

      const response = await GET(makeRequest({ code: 'auth-code', state: connectorState }))

      expect(response.status).toBe(307)
      const location = new URL(response.headers.get('location') || '')
      expect(location.origin).toBe('https://instance.example.se')
      expect(location.searchParams.get('state')).toBe('instance-state')
      expect(location.searchParams.get('code')).toBe('auth-code')
      expect(mockGetUser).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
      vi.unstubAllEnvs()
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    })
  })

  it('threads connector_state from the query into createSession (connector mode)', async () => {
    // In connector mode the hosted callback bounces the browser back here with
    // the signed connector_state echoed alongside code + the instance's own
    // oauth_state. createSession must forward it so the bank proxy binds the
    // /sessions exchange to the pending ledger row it signed at /auth time.
    mockFrom.mockImplementation(() =>
      mockChain({
        data: { id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'TestBank', status: 'pending' },
        error: null,
      }),
    )
    mockCreateSession.mockResolvedValue({
      session_id: 'sess-1',
      accounts: [],
      access: { valid_until: '2027-12-31T00:00:00Z' },
      aspsp: { name: 'TestBank', country: 'SE' },
    })

    await GET(makeRequest({ code: 'auth-code', state: 'valid-state', connector_state: 'signed-connector-state' }))

    expect(mockCreateSession).toHaveBeenCalledWith('auth-code', 'signed-connector-state')
  })

  it('passes undefined connector_state on the direct path (no connector_state in the query)', async () => {
    mockFrom.mockImplementation(() =>
      mockChain({
        data: { id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'TestBank', status: 'pending' },
        error: null,
      }),
    )
    mockCreateSession.mockResolvedValue({
      session_id: 'sess-1',
      accounts: [],
      access: { valid_until: '2027-12-31T00:00:00Z' },
      aspsp: { name: 'TestBank', country: 'SE' },
    })

    await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))

    expect(mockCreateSession).toHaveBeenCalledWith('auth-code', undefined)
  })

  it('writes pending_selection and streams a finalizing page that redirects to the picker', async () => {
    const capturedUpdates: Record<string, unknown>[] = []
    let callIndex = 0
    mockFrom.mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // Find pending connection by oauth_state
        return mockChain({
          data: { id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'TestBank', status: 'pending' },
          error: null,
        })
      }
      // Update connection: capture the payload, then chain returns the
      // updated row via .select().single() for the audit event emission.
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        capturedUpdates.push(payload)
        return chain
      })
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: {
          id: 'conn-1',
          bank_name: 'TestBank',
          company_id: 'company-1',
          user_id: 'user-1',
        },
        error: null,
      })
      // Back-compat fallthrough for chains that aren't terminated by .single()
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })

    mockCreateSession.mockResolvedValue({
      session_id: 'sess-1',
      accounts: [
        {
          uid: 'acc-1',
          account_id: { iban: 'SE1234' },
          // Swedish ASPSPs list the BBAN (clearing + account) alongside the
          // IBAN; it must land on the stored account for payee prefill.
          all_account_ids: [
            { identification: 'SE1234', scheme_name: 'IBAN' },
            { identification: '5000 1234567', scheme_name: 'BBAN' },
          ],
          name: 'Företagskonto',
          currency: 'SEK',
        },
        { uid: 'acc-2', account_id: { iban: 'SE5678' }, name: 'Privatkonto', currency: 'SEK' },
      ],
      access: { valid_until: '2024-12-31T00:00:00Z' },
      aspsp: { name: 'TestBank', country: 'SE' },
    })
    mockGetAccountBalance.mockRejectedValue(new Error('skip balance fetch'))

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))

    // Success streams an interim page (instant feedback during the session
    // exchange) that ends with a client-side redirect to the account picker.
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    // Shell flushed with the bank name, then the redirect to the picker.
    expect(body).toContain('TestBank')
    expect(body).toContain('window.location.replace')
    expect(body).toContain('select_accounts=conn-1')
    expect(body).not.toContain('bank_error')

    // ASVS V3.3: inline scripts are nonce-bound. The response-level CSP
    // declares the nonce and BOTH chunks (shell watchdog + redirect) carry
    // it; no un-nonced inline script may exist on this page.
    const csp = response.headers.get('content-security-policy') ?? ''
    const nonceMatch = /script-src 'nonce-([^']+)'/.exec(csp)
    expect(nonceMatch).not.toBeNull()
    const nonce = nonceMatch![1]
    expect(body.split(`<script nonce="${nonce}">`).length - 1).toBe(2)
    expect(body).not.toContain('<script>')

    // Verify the update payload: status=pending_selection, no last_synced_at,
    // and every account defaults to enabled=true so the picker can simply
    // mirror current state without back-filling.
    // Two updates: the connection write, then the accounts_data follow-up
    // persisting the allocated ledgers.
    expect(capturedUpdates).toHaveLength(2)
    const payload = capturedUpdates[0]
    expect(payload.status).toBe('pending_selection')
    expect(payload).not.toHaveProperty('last_synced_at')
    const accountsData = payload.accounts_data as Array<{ uid: string; enabled: boolean; bban?: string }>
    expect(accountsData).toHaveLength(2)
    expect(accountsData.every(a => a.enabled === true)).toBe(true)
    expect(accountsData.find(a => a.uid === 'acc-1')?.bban).toBe('50001234567')
    expect(accountsData.find(a => a.uid === 'acc-2')?.bban).toBeUndefined()

    // Two same-currency accounts must NOT collide on the same BAS slot — the
    // second SEK account gets the next free 19xx sub-account, and the
    // assignment is persisted to accounts_data for the picker to pre-fill.
    const persisted = capturedUpdates[1].accounts_data as Array<{
      uid: string
      ledger_account?: string
    }>
    expect(persisted.find(a => a.uid === 'acc-1')?.ledger_account).toBe('1930')
    expect(persisted.find(a => a.uid === 'acc-2')?.ledger_account).toBe('1931')

    // The mirror wrote the same distinct assignments into cash_accounts.
    expect(mockUpsertFromPsd2).toHaveBeenCalledTimes(2)
    const mirrorLedgers = mockUpsertFromPsd2.mock.calls.map(
      (c) => (c[2] as { ledger_account: string }).ledger_account,
    )
    expect(mirrorLedgers).toEqual(['1930', '1931'])
  })

  // The F1 scenario: at a one-session bank the PSU's single consent covers
  // accounts another of the user's companies books (and, before this guard,
  // stored them pre-enabled in the wrong company and mirrored them into its
  // cash_accounts, one save away from cross-company bookkeeping).
  function mockConnectionFlow(pendingRow: Record<string, unknown>) {
    const capturedUpdates: Record<string, unknown>[] = []
    let callIndex = 0
    mockFrom.mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        return mockChain({ data: pendingRow, error: null })
      }
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        capturedUpdates.push(payload)
        return chain
      })
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: { id: 'conn-1', bank_name: 'SEB', company_id: 'company-1', user_id: 'user-1' },
        error: null,
      })
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })
    return capturedUpdates
  }

  it('stores accounts claimed by a sibling company disabled + flagged and never mirrors them', async () => {
    const capturedUpdates = mockConnectionFlow({
      id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'SEB', status: 'pending',
    })
    mockCrossCompanyContext.mockResolvedValue({
      claims: new Map([
        ['SE9999', { companyId: 'company-2', companyName: 'Other Energy AB' }],
      ]),
      deselectedIbans: new Set(),
      activeCompanyIbans: new Set(),
    })
    mockCreateSession.mockResolvedValue({
      session_id: 'sess-1',
      accounts: [
        { uid: 'acc-own', account_id: { iban: 'SE1234' }, name: 'Företagskonto', currency: 'SEK' },
        { uid: 'acc-foreign', account_id: { iban: 'SE9999' }, name: 'Annat bolags konto', currency: 'SEK' },
      ],
      access: { valid_until: '2027-12-31T00:00:00Z' },
      aspsp: { name: 'SEB', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))

    expect(response.status).toBe(200)
    // Drain the stream: the finalize work completes behind the interim page.
    await response.text()
    const accountsData = capturedUpdates[0].accounts_data as Array<{
      uid: string
      enabled: boolean
      claimed_by_company_id?: string
      claimed_by_company_name?: string
    }>
    const own = accountsData.find(a => a.uid === 'acc-own')
    const foreign = accountsData.find(a => a.uid === 'acc-foreign')
    expect(own?.enabled).toBe(true)
    expect(own?.claimed_by_company_id).toBeUndefined()
    expect(foreign?.enabled).toBe(false)
    expect(foreign?.claimed_by_company_id).toBe('company-2')
    expect(foreign?.claimed_by_company_name).toBe('Other Energy AB')

    // The claimed account gets NO cash_accounts row and NO 19xx slot in this
    // company's chart: only the own account is mirrored.
    expect(mockUpsertFromPsd2).toHaveBeenCalledTimes(1)
    expect((mockUpsertFromPsd2.mock.calls[0][2] as { external_uid: string }).external_uid).toBe('acc-own')
    expect(mockAllocate).toHaveBeenCalledTimes(1)
  })

  it('keeps an account this row already carried enabled even when a sibling claims its IBAN', async () => {
    // A standing feed in the active company outranks a sibling's claim: a
    // renewal must never switch a working account off. (Legacy double-claims
    // from the pre-session-sharing era make this overlap real.)
    const capturedUpdates = mockConnectionFlow({
      id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'SEB', status: 'expired',
      accounts_data: [
        { uid: 'acc-old', iban: 'SE1234', name: 'Företagskonto', currency: 'SEK', enabled: true },
      ],
    })
    mockCrossCompanyContext.mockResolvedValue({
      claims: new Map([['SE1234', { companyId: 'company-2', companyName: 'Other AB' }]]),
      deselectedIbans: new Set(),
      activeCompanyIbans: new Set(),
    })
    mockCreateSession.mockResolvedValue({
      session_id: 'sess-2',
      accounts: [
        { uid: 'acc-new', account_id: { iban: 'SE1234' }, name: 'Företagskonto', currency: 'SEK' },
      ],
      access: { valid_until: '2027-12-31T00:00:00Z' },
      aspsp: { name: 'SEB', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))
    // Drain the stream: the finalize work completes behind the interim page.
    await response.text()

    const accountsData = capturedUpdates[0].accounts_data as Array<{
      uid: string
      enabled: boolean
      claimed_by_company_id?: string
    }>
    expect(accountsData[0].enabled).toBe(true)
    expect(accountsData[0].claimed_by_company_id).toBeUndefined()
    expect(mockUpsertFromPsd2).toHaveBeenCalledTimes(1)
  })

  it('carries a deselection made on another connection row onto a fresh connect', async () => {
    // C2: "Synkas ej" chosen under one company must not come back pre-checked
    // when a new connection row (any company) sees the same IBAN.
    const capturedUpdates = mockConnectionFlow({
      id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'SEB', status: 'pending',
    })
    mockCrossCompanyContext.mockResolvedValue({
      claims: new Map(),
      deselectedIbans: new Set(['SE5555']),
      activeCompanyIbans: new Set(),
    })
    mockCreateSession.mockResolvedValue({
      session_id: 'sess-1',
      accounts: [
        { uid: 'acc-card', account_id: { iban: 'SE5555' }, name: 'Privat kreditkort', currency: 'SEK' },
      ],
      access: { valid_until: '2027-12-31T00:00:00Z' },
      aspsp: { name: 'SEB', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))
    // Drain the stream: the finalize work completes behind the interim page.
    await response.text()

    const accountsData = capturedUpdates[0].accounts_data as Array<{
      uid: string
      enabled: boolean
      claimed_by_company_id?: string
      deselected_elsewhere?: boolean
    }>
    expect(accountsData[0].enabled).toBe(false)
    // Not a claim (no company books it), but flagged so the picker can say
    // WHY the box is unchecked instead of leaving a silent gap.
    expect(accountsData[0].claimed_by_company_id).toBeUndefined()
    expect(accountsData[0].deselected_elsewhere).toBe(true)
    // Guard-disabled accounts are never mirrored from the callback: writing
    // enabled:false for a new-to-row account can promote an existing manual
    // holder (the seeded primary 1930) and flip it to disabled.
    expect(mockUpsertFromPsd2).not.toHaveBeenCalled()
  })

  it('fails closed when the claim lookup errors: new accounts stored deselected, unflagged', async () => {
    const capturedUpdates = mockConnectionFlow({
      id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'SEB', status: 'pending',
    })
    mockCrossCompanyContext.mockResolvedValue(null)
    mockCreateSession.mockResolvedValue({
      session_id: 'sess-1',
      accounts: [
        { uid: 'acc-1', account_id: { iban: 'SE1234' }, name: 'Företagskonto', currency: 'SEK' },
      ],
      access: { valid_until: '2027-12-31T00:00:00Z' },
      aspsp: { name: 'SEB', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))

    // The connect itself still succeeds: fail-closed costs a checkbox, not
    // the connection.
    expect(response.status).toBe(200)
    // Drain the stream: the finalize work completes behind the interim page.
    await response.text()
    const accountsData = capturedUpdates[0].accounts_data as Array<{
      uid: string
      enabled: boolean
      claimed_by_company_id?: string
    }>
    expect(accountsData[0].enabled).toBe(false)
    expect(accountsData[0].claimed_by_company_id).toBeUndefined()
    // Fail-closed accounts are not mirrored either: enabled:false for a
    // new-to-row account can promote and disable an existing manual holder.
    // The selection save mirrors whatever the user enables.
    expect(mockUpsertFromPsd2).not.toHaveBeenCalled()
  })

  it('preserves existing mirrored ledgers on reconnect instead of re-deriving them', async () => {
    let callIndex = 0
    mockFrom.mockImplementation((table: string) => {
      callIndex++
      if (callIndex === 1) {
        return mockChain({
          data: { id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'TestBank', status: 'expired' },
          error: null,
        })
      }
      if (table === 'cash_accounts') {
        // Already mirrored on a previous connect — acc-1 was remapped to 1935
        // by the user; a reconnect must not clobber it back to 1930.
        return mockChain({
          data: [{ external_uid: 'acc-1', ledger_account: '1935' }],
          error: null,
        })
      }
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn(() => chain)
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: { id: 'conn-1', bank_name: 'TestBank', company_id: 'company-1', user_id: 'user-1' },
        error: null,
      })
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })

    mockCreateSession.mockResolvedValue({
      session_id: 'sess-2',
      accounts: [
        { uid: 'acc-1', account_id: { iban: 'SE1234' }, name: 'Företagskonto', currency: 'SEK' },
      ],
      access: { valid_until: '2024-12-31T00:00:00Z' },
      aspsp: { name: 'TestBank', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('select_accounts=conn-1')
    // No allocation for an already-mirrored account; the upsert reuses 1935.
    expect(mockAllocate).not.toHaveBeenCalled()
    expect(mockUpsertFromPsd2).toHaveBeenCalledTimes(1)
    expect(
      (mockUpsertFromPsd2.mock.calls[0][2] as { ledger_account: string }).ledger_account,
    ).toBe('1935')
  })

  it('reuses the mapping of a known IBAN when the bank returns a new account uid', async () => {
    // The reconnect case behind the reported bug: the ASPSP minted a fresh
    // account uid, so the (connection, uid) lookup finds nothing and the old
    // behavior allocated an overflow slot, silently moving the user's 1930
    // mapping. Matching on IBAN has to bring both the ledger and the existing
    // row along.
    mockFrom.mockImplementation((table: string) => {
      if (table === 'cash_accounts') {
        // Nothing mirrored under the NEW uid.
        return mockChain({ data: [], error: null })
      }
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn(() => chain)
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.in = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: {
          id: 'conn-1',
          bank_name: 'TestBank',
          company_id: 'company-1',
          user_id: 'user-1',
          status: 'expired',
        },
        error: null,
      })
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })

    mockAllocate.mockResolvedValue({
      ledgerAccount: '1930',
      reuseCashAccountId: 'cash-row-1',
      source: 'iban',
    })

    mockCreateSession.mockResolvedValue({
      session_id: 'sess-2',
      accounts: [
        { uid: 'acc-new', account_id: { iban: 'SE1234' }, name: 'Företagskonto', currency: 'SEK' },
      ],
      access: { valid_until: '2024-12-31T00:00:00Z' },
      aspsp: { name: 'TestBank', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))
    expect(response.status).toBe(200)
    // Reading the body drives the stream, which is what awaits the finalize
    // work the assertions below inspect.
    await response.text()

    expect(mockUpsertFromPsd2).toHaveBeenCalledTimes(1)
    const mirrored = mockUpsertFromPsd2.mock.calls[0][2] as {
      ledger_account: string
      reuse_cash_account_id: string | null
      external_uid: string
    }
    expect(mirrored.ledger_account).toBe('1930')
    // The existing row is promoted, not duplicated: it keeps its linked
    // transactions and picks up the new uid.
    expect(mirrored.reuse_cash_account_id).toBe('cash-row-1')
    expect(mirrored.external_uid).toBe('acc-new')
  })

  it('does not let a stale-uid mirrored row block the IBAN reuse of its own ledger on renewal', async () => {
    // In-place renewal ("Förnya") of a connection whose ASPSP mints new uids
    // on every re-auth. The connection already mirrors 1930/1940 under the OLD
    // uids. Those ledgers must NOT be pre-seeded into the resolver's exclude
    // set: the IBAN match on the stale row is the mapping to promote, and
    // excluding it made every renewal allocate a fresh 19xx sub-account.
    let callIndex = 0
    mockFrom.mockImplementation((table: string) => {
      callIndex++
      if (callIndex === 1) {
        return mockChain({
          data: {
            id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'SEB', status: 'expired',
            accounts_data: [
              { uid: 'acc-old-1', iban: 'SE1234', name: 'Företagskonto', currency: 'SEK', enabled: true },
              { uid: 'acc-old-2', iban: 'SE5678', name: 'Sparkonto', currency: 'SEK', enabled: true },
            ],
          },
          error: null,
        })
      }
      if (table === 'cash_accounts') {
        return mockChain({
          data: [
            { external_uid: 'acc-old-1', ledger_account: '1930' },
            { external_uid: 'acc-old-2', ledger_account: '1940' },
          ],
          error: null,
        })
      }
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn(() => chain)
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.in = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: { id: 'conn-1', bank_name: 'SEB', company_id: 'company-1', user_id: 'user-1', status: 'expired' },
        error: null,
      })
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })

    // Resolver stand-in: answer the IBAN hit only when the caller did NOT
    // exclude that ledger (mirrors resolvePsd2LedgerAccount's guard), else
    // fall back to the allocator.
    const ibanLedgers: Record<string, { ledger: string; rowId: string }> = {
      SE1234: { ledger: '1930', rowId: 'row-1' },
      SE5678: { ledger: '1940', rowId: 'row-2' },
    }
    const seenExcludes: string[][] = []
    mockAllocate.mockImplementation(
      async (_s: unknown, _c: unknown, _u: unknown, input: { iban?: string; currency: string; exclude?: ReadonlySet<string> }) => {
        const exclude = input.exclude ?? new Set<string>()
        seenExcludes.push([...exclude].sort())
        const hit = input.iban ? ibanLedgers[input.iban] : undefined
        if (hit && !exclude.has(hit.ledger)) {
          return { ledgerAccount: hit.ledger, reuseCashAccountId: hit.rowId, source: 'iban' }
        }
        for (let n = 1931; n <= 1959; n++) {
          const candidate = String(n)
          if (!exclude.has(candidate) && !['1932', '1933', '1934'].includes(candidate)) return candidate
        }
        return null
      },
    )

    mockCreateSession.mockResolvedValue({
      session_id: 'sess-3',
      accounts: [
        { uid: 'acc-new-1', account_id: { iban: 'SE1234' }, name: 'Företagskonto', currency: 'SEK' },
        { uid: 'acc-new-2', account_id: { iban: 'SE5678' }, name: 'Sparkonto', currency: 'SEK' },
      ],
      access: { valid_until: '2024-12-31T00:00:00Z' },
      aspsp: { name: 'SEB', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))
    expect(response.status).toBe(200)
    await response.text()

    // The first resolver call saw no pre-seeded excludes (no new-session uid
    // matched a mirrored row), the second saw only the ledger just claimed.
    expect(seenExcludes).toEqual([[], ['1930']])
    // Both accounts land back on their own ledgers and promote their rows.
    const mirrored = mockUpsertFromPsd2.mock.calls.map(
      (c) => c[2] as { ledger_account: string; reuse_cash_account_id: string | null; external_uid: string },
    )
    expect(mirrored.map((m) => [m.external_uid, m.ledger_account, m.reuse_cash_account_id])).toEqual([
      ['acc-new-1', '1930', 'row-1'],
      ['acc-new-2', '1940', 'row-2'],
    ])
  })

  it('keeps a previously deselected account deselected on renewal, by IBAN or uid', async () => {
    // "SEB Credit" was set to "Synkas ej" (enabled:false) in the old
    // connection. On renewal it comes back under a NEW uid (same IBAN) and a
    // no-IBAN card comes back under the SAME uid. Both must stay deselected;
    // only the genuinely new account defaults to enabled.
    const capturedUpdates: Record<string, unknown>[] = []
    let callIndex = 0
    mockFrom.mockImplementation((table: string) => {
      callIndex++
      if (callIndex === 1) {
        return mockChain({
          data: {
            id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'SEB', status: 'expired',
            accounts_data: [
              { uid: 'acc-old-1', iban: 'SE1234', name: 'Företagskonto', currency: 'SEK', enabled: true },
              { uid: 'card-old', iban: 'SE9999', name: 'SEB Credit', currency: 'SEK', enabled: false },
              { uid: 'card-noiban', name: 'Privatkort', currency: 'SEK', enabled: false },
              // Same IBAN listed twice (one resource per balance type): the
              // user unticked the duplicate and kept the main one. Exact uid
              // identity must win over the IBAN fallback in both directions.
              { uid: 'dup-resource', iban: 'SE7777', name: 'Lönekonto (saldo)', currency: 'SEK', enabled: false },
              { uid: 'main-resource', iban: 'SE7777', name: 'Lönekonto', currency: 'SEK', enabled: true },
            ],
          },
          error: null,
        })
      }
      if (table === 'cash_accounts') return mockChain({ data: [], error: null })
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        capturedUpdates.push(payload)
        return chain
      })
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.in = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: { id: 'conn-1', bank_name: 'SEB', company_id: 'company-1', user_id: 'user-1', status: 'expired' },
        error: null,
      })
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })

    mockCreateSession.mockResolvedValue({
      session_id: 'sess-4',
      accounts: [
        { uid: 'acc-new-1', account_id: { iban: 'SE1234' }, name: 'Företagskonto', currency: 'SEK' },
        { uid: 'card-new', account_id: { iban: 'SE 9999' }, name: 'SEB Credit', currency: 'SEK' },
        { uid: 'card-noiban', name: 'Privatkort', currency: 'SEK' },
        { uid: 'acc-brand-new', account_id: { iban: 'SE4444' }, name: 'Nytt konto', currency: 'SEK' },
        { uid: 'dup-resource', account_id: { iban: 'SE7777' }, name: 'Lönekonto (saldo)', currency: 'SEK' },
        { uid: 'main-resource', account_id: { iban: 'SE7777' }, name: 'Lönekonto', currency: 'SEK' },
      ],
      access: { valid_until: '2024-12-31T00:00:00Z' },
      aspsp: { name: 'SEB', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))
    expect(response.status).toBe(200)
    await response.text()

    const accountsData = capturedUpdates[0].accounts_data as Array<{ uid: string; enabled: boolean }>
    expect(Object.fromEntries(accountsData.map((a) => [a.uid, a.enabled]))).toEqual({
      'acc-new-1': true,
      'card-new': false,
      'card-noiban': false,
      'acc-brand-new': true,
      'dup-resource': false,
      'main-resource': true,
    })
    // The mirror carries the same flag, so cash_accounts.enabled is not
    // flipped back to true by the renewal.
    const mirroredEnabled = Object.fromEntries(
      mockUpsertFromPsd2.mock.calls.map((c) => {
        const input = c[2] as { external_uid: string; enabled: boolean }
        return [input.external_uid, input.enabled]
      }),
    )
    expect(mirroredEnabled).toEqual({
      'acc-new-1': true,
      'card-new': false,
      'card-noiban': false,
      'acc-brand-new': true,
      'dup-resource': false,
      'main-resource': true,
    })
  })

  it('runs the same-bank supersede pass with the new session, accounts, and connection identity', async () => {
    // Fresh connect while an EXPIRED sibling to the same bank exists: the
    // supersede pass (unit-tested separately) must be handed everything it
    // needs to park the sibling and re-point its transactions.
    let callIndex = 0
    mockFrom.mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        return mockChain({
          data: { id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'TestBank', status: 'pending' },
          error: null,
        })
      }
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn(() => chain)
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: { id: 'conn-1', bank_name: 'TestBank', company_id: 'company-1', user_id: 'user-1' },
        error: null,
      })
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })

    mockCreateSession.mockResolvedValue({
      session_id: 'sess-1',
      accounts: [
        { uid: 'acc-1', account_id: { iban: 'SE1234' }, name: 'Företagskonto', currency: 'SEK' },
      ],
      access: { valid_until: '2024-12-31T00:00:00Z' },
      aspsp: { name: 'TestBank', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))
    expect(response.status).toBe(200)
    // Reading the body drives the stream, which awaits the finalize work.
    await response.text()

    expect(mockSupersede).toHaveBeenCalledTimes(1)
    const [, input] = mockSupersede.mock.calls[0] as [unknown, {
      companyId: string
      userId: string
      newConnectionId: string
      bankName: string | null
      newSessionId: string | null
      newAccounts: Array<{ uid: string; dedup_scope?: string }>
    }]
    expect(input.companyId).toBe('company-1')
    expect(input.userId).toBe('user-1')
    expect(input.newConnectionId).toBe('conn-1')
    expect(input.bankName).toBe('TestBank')
    expect(input.newSessionId).toBe('sess-1')
    expect(input.newAccounts).toHaveLength(1)
    // First-connect accounts get their dedup scope pinned to the normalized
    // IBAN (byte-identical to what lib/sync.ts derives).
    expect(input.newAccounts[0].dedup_scope).toBe('SE1234')
  })

  it('applies dedup scopes carried from superseded siblings to accounts_data', async () => {
    mockSupersede.mockResolvedValue({
      supersededIds: ['old-1'],
      // The sibling's account was first ingested under its old provider uid.
      dedupScopeByIban: new Map([['SE1234', 'legacy-uid']]),
    })

    const capturedUpdates: Record<string, unknown>[] = []
    let callIndex = 0
    mockFrom.mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        return mockChain({
          data: { id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'TestBank', status: 'pending' },
          error: null,
        })
      }
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        capturedUpdates.push(payload)
        return chain
      })
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: { id: 'conn-1', bank_name: 'TestBank', company_id: 'company-1', user_id: 'user-1' },
        error: null,
      })
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })

    mockCreateSession.mockResolvedValue({
      session_id: 'sess-1',
      accounts: [
        { uid: 'acc-1', account_id: { iban: 'SE1234' }, name: 'Företagskonto', currency: 'SEK' },
      ],
      access: { valid_until: '2024-12-31T00:00:00Z' },
      aspsp: { name: 'TestBank', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))
    expect(response.status).toBe(200)
    await response.text()

    // The follow-up accounts_data write persists the carried scope so the
    // renewal keeps minting the sibling's external_ids.
    const followUp = capturedUpdates[capturedUpdates.length - 1]
    const persisted = followUp.accounts_data as Array<{ uid: string; dedup_scope?: string }>
    expect(persisted.find((a) => a.uid === 'acc-1')?.dedup_scope).toBe('legacy-uid')
  })

  it('carries the prior accounts_data dedup scope across an in-place reconnect', async () => {
    const capturedUpdates: Record<string, unknown>[] = []
    let callIndex = 0
    mockFrom.mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // The established row being reconnected in place: its account was
        // first ingested under the uid the ASPSP has since replaced.
        return mockChain({
          data: {
            id: 'conn-1',
            user_id: 'user-1',
            company_id: 'company-1',
            bank_name: 'TestBank',
            status: 'expired',
            session_id: null,
            accounts_data: [
              { uid: 'uid-old', iban: 'SE1234', currency: 'SEK', dedup_scope: 'uid-first' },
            ],
          },
          error: null,
        })
      }
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        capturedUpdates.push(payload)
        return chain
      })
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: { id: 'conn-1', bank_name: 'TestBank', company_id: 'company-1', user_id: 'user-1' },
        error: null,
      })
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })

    mockCreateSession.mockResolvedValue({
      session_id: 'sess-2',
      accounts: [
        // Same IBAN, freshly minted uid.
        { uid: 'uid-new', account_id: { iban: 'SE1234' }, name: 'Företagskonto', currency: 'SEK' },
      ],
      access: { valid_until: '2024-12-31T00:00:00Z' },
      aspsp: { name: 'TestBank', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))
    expect(response.status).toBe(200)
    await response.text()

    const connectionWrite = capturedUpdates[0]
    const accountsData = connectionWrite.accounts_data as Array<{
      uid: string
      dedup_scope?: string
    }>
    expect(accountsData).toHaveLength(1)
    expect(accountsData[0].uid).toBe('uid-new')
    // The scope pinned at first ingest survives the uid change.
    expect(accountsData[0].dedup_scope).toBe('uid-first')
  })

  it('pairs a no-IBAN account across a uid change: carries the scope and reuses the cash account row', async () => {
    // Issue #1709: an in-place reconnect where the ASPSP minted a NEW uid for
    // an account WITHOUT an IBAN. Neither the IBAN nor the uid map can match,
    // so before the pairing fallback the scope regenerated (full history
    // re-imported unbooked) and the mirror allocated a fresh 19xx slot + a new
    // cash_accounts row. With exactly one unclaimed prior and one fresh new
    // account in the currency, the pairing must carry the scope, the enabled
    // flag, the old ledger, and promote the old row in place.
    const capturedUpdates: Record<string, unknown>[] = []
    let callIndex = 0
    mockFrom.mockImplementation((table: string) => {
      callIndex++
      if (callIndex === 1) {
        return mockChain({
          data: {
            id: 'conn-1',
            user_id: 'user-1',
            company_id: 'company-1',
            bank_name: 'TestBank',
            status: 'expired',
            session_id: null,
            accounts_data: [
              { uid: 'uid-old', name: 'Sparkonto', currency: 'SEK', dedup_scope: 'scope-first', enabled: false },
            ],
          },
          error: null,
        })
      }
      if (table === 'cash_accounts') {
        return mockChain({
          data: [{ id: 'row-old', external_uid: 'uid-old', ledger_account: '1935' }],
          error: null,
        })
      }
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        capturedUpdates.push(payload)
        return chain
      })
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.in = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: { id: 'conn-1', bank_name: 'TestBank', company_id: 'company-1', user_id: 'user-1' },
        error: null,
      })
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })

    mockCreateSession.mockResolvedValue({
      session_id: 'sess-2',
      accounts: [
        // Same account, no IBAN, freshly minted uid.
        { uid: 'uid-new', name: 'Sparkonto', currency: 'SEK' },
      ],
      access: { valid_until: '2024-12-31T00:00:00Z' },
      aspsp: { name: 'TestBank', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))
    expect(response.status).toBe(200)
    await response.text()

    // The scope pinned at first ingest survives the uid change, so every
    // historical external_id keeps minting byte-identically and Layer-1 dedup
    // swallows the re-import. The user's "Synkas ej" choice travels too.
    const accountsData = capturedUpdates[0].accounts_data as Array<{
      uid: string
      dedup_scope?: string
      enabled?: boolean
    }>
    expect(accountsData).toHaveLength(1)
    expect(accountsData[0].uid).toBe('uid-new')
    expect(accountsData[0].dedup_scope).toBe('scope-first')
    expect(accountsData[0].enabled).toBe(false)

    // The mirror reuses the connection's own old row instead of allocating a
    // new slot: same ledger, promoted in place under the new uid.
    expect(mockAllocate).not.toHaveBeenCalled()
    expect(mockUpsertFromPsd2).toHaveBeenCalledTimes(1)
    const mirrored = mockUpsertFromPsd2.mock.calls[0][2] as {
      external_uid: string
      ledger_account: string
      reuse_cash_account_id: string | null
      enabled: boolean
    }
    expect(mirrored.external_uid).toBe('uid-new')
    expect(mirrored.ledger_account).toBe('1935')
    expect(mirrored.reuse_cash_account_id).toBe('row-old')
    expect(mirrored.enabled).toBe(false)
  })

  it('keeps fresh scopes when the no-IBAN pairing is ambiguous', async () => {
    // Two unclaimed no-IBAN prior accounts and two fresh new uids in the same
    // currency: any pairing would be a guess, so none is made. Both new
    // accounts keep the pre-fix behavior: scope = own uid, freshly resolved
    // ledger, no row reuse.
    const capturedUpdates: Record<string, unknown>[] = []
    let callIndex = 0
    mockFrom.mockImplementation((table: string) => {
      callIndex++
      if (callIndex === 1) {
        return mockChain({
          data: {
            id: 'conn-1',
            user_id: 'user-1',
            company_id: 'company-1',
            bank_name: 'TestBank',
            status: 'expired',
            session_id: null,
            accounts_data: [
              { uid: 'old-1', name: 'Konto A', currency: 'SEK', dedup_scope: 'scope-a', enabled: true },
              { uid: 'old-2', name: 'Konto B', currency: 'SEK', dedup_scope: 'scope-b', enabled: true },
            ],
          },
          error: null,
        })
      }
      if (table === 'cash_accounts') {
        return mockChain({
          data: [
            { id: 'row-1', external_uid: 'old-1', ledger_account: '1930' },
            { id: 'row-2', external_uid: 'old-2', ledger_account: '1940' },
          ],
          error: null,
        })
      }
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        capturedUpdates.push(payload)
        return chain
      })
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.in = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: { id: 'conn-1', bank_name: 'TestBank', company_id: 'company-1', user_id: 'user-1' },
        error: null,
      })
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })

    mockCreateSession.mockResolvedValue({
      session_id: 'sess-2',
      accounts: [
        { uid: 'new-1', name: 'Konto A', currency: 'SEK' },
        { uid: 'new-2', name: 'Konto B', currency: 'SEK' },
      ],
      access: { valid_until: '2024-12-31T00:00:00Z' },
      aspsp: { name: 'TestBank', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))
    expect(response.status).toBe(200)
    await response.text()

    const accountsData = capturedUpdates[0].accounts_data as Array<{
      uid: string
      dedup_scope?: string
    }>
    expect(Object.fromEntries(accountsData.map((a) => [a.uid, a.dedup_scope]))).toEqual({
      'new-1': 'new-1',
      'new-2': 'new-2',
    })
    expect(mockAllocate).toHaveBeenCalledTimes(2)
    for (const call of mockUpsertFromPsd2.mock.calls) {
      expect((call[2] as { reuse_cash_account_id: string | null }).reuse_cash_account_id).toBeNull()
    }
  })

  it('does not pair when the unclaimed prior account carries an IBAN', async () => {
    // Exactly one unclaimed prior and one fresh new account, but the prior has
    // an IBAN: the bank dropping an IBAN it used to report is not the no-IBAN
    // uid-mint pattern, so the elimination pairing must stand down.
    const capturedUpdates: Record<string, unknown>[] = []
    let callIndex = 0
    mockFrom.mockImplementation((table: string) => {
      callIndex++
      if (callIndex === 1) {
        return mockChain({
          data: {
            id: 'conn-1',
            user_id: 'user-1',
            company_id: 'company-1',
            bank_name: 'TestBank',
            status: 'expired',
            session_id: null,
            accounts_data: [
              { uid: 'old-1', iban: 'SE1111', name: 'Konto A', currency: 'SEK', dedup_scope: 'SE1111', enabled: true },
            ],
          },
          error: null,
        })
      }
      if (table === 'cash_accounts') {
        return mockChain({
          data: [{ id: 'row-1', external_uid: 'old-1', ledger_account: '1930' }],
          error: null,
        })
      }
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        capturedUpdates.push(payload)
        return chain
      })
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.in = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: { id: 'conn-1', bank_name: 'TestBank', company_id: 'company-1', user_id: 'user-1' },
        error: null,
      })
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })

    mockCreateSession.mockResolvedValue({
      session_id: 'sess-2',
      accounts: [{ uid: 'new-1', name: 'Konto A', currency: 'SEK' }],
      access: { valid_until: '2024-12-31T00:00:00Z' },
      aspsp: { name: 'TestBank', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))
    expect(response.status).toBe(200)
    await response.text()

    const accountsData = capturedUpdates[0].accounts_data as Array<{
      uid: string
      dedup_scope?: string
    }>
    expect(accountsData[0].dedup_scope).toBe('new-1')
    expect(mockAllocate).toHaveBeenCalledTimes(1)
    expect(
      (mockUpsertFromPsd2.mock.calls[0][2] as { reuse_cash_account_id: string | null })
        .reuse_cash_account_id,
    ).toBeNull()
  })

  it('prefers the survivor account explicit dedup scope over a carried sibling scope', async () => {
    // A superseded sibling shares the IBAN but was ingested under a different
    // scope. The survivor's own row already pinned an explicit scope for this
    // account: that is what its external_ids were minted under, so the
    // sibling's scope must NOT clobber it.
    mockSupersede.mockResolvedValue({
      supersededIds: ['old-1'],
      dedupScopeByIban: new Map([['SE1234', 'sibling-scope']]),
    })

    const capturedUpdates: Record<string, unknown>[] = []
    let callIndex = 0
    mockFrom.mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        return mockChain({
          data: {
            id: 'conn-1',
            user_id: 'user-1',
            company_id: 'company-1',
            bank_name: 'TestBank',
            status: 'expired',
            session_id: null,
            accounts_data: [
              { uid: 'uid-old', iban: 'SE1234', currency: 'SEK', dedup_scope: 'survivor-scope' },
            ],
          },
          error: null,
        })
      }
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        capturedUpdates.push(payload)
        return chain
      })
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: { id: 'conn-1', bank_name: 'TestBank', company_id: 'company-1', user_id: 'user-1' },
        error: null,
      })
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })

    mockCreateSession.mockResolvedValue({
      session_id: 'sess-2',
      accounts: [
        { uid: 'uid-new', account_id: { iban: 'SE1234' }, name: 'Företagskonto', currency: 'SEK' },
      ],
      access: { valid_until: '2024-12-31T00:00:00Z' },
      aspsp: { name: 'TestBank', country: 'SE' },
    })

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))
    expect(response.status).toBe(200)
    await response.text()

    // Every accounts_data write keeps the survivor's explicit scope: neither
    // the connection write nor any carried-scope follow-up flips it.
    const accountsWrites = capturedUpdates.filter((u) => Array.isArray(u.accounts_data))
    expect(accountsWrites.length).toBeGreaterThan(0)
    for (const write of accountsWrites) {
      const accountsData = write.accounts_data as Array<{ uid: string; dedup_scope?: string }>
      expect(accountsData.find((a) => a.uid === 'uid-new')?.dedup_scope).toBe('survivor-scope')
    }
  })

  it('deletes the fresh row and streams an error redirect when the session exchange fails', async () => {
    const deleteCalls: unknown[] = []
    const updateCalls: unknown[] = []
    mockFrom.mockImplementation(() => {
      const chain = mockChain({
        data: { id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'TestBank', status: 'pending' },
        error: null,
      })
      chain.delete = vi.fn(() => {
        deleteCalls.push('delete')
        return chain
      })
      chain.update = vi.fn((payload: unknown) => {
        updateCalls.push(payload)
        return chain
      })
      return chain
    })

    mockCreateSession.mockRejectedValue(new Error('upstream timeout'))

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))

    expect(response.status).toBe(200)
    const body = await response.text()
    // The streamed redirect carries the failure to the settings banner.
    expect(body).toContain('window.location.replace')
    expect(body).toContain('bank_error=')
    expect(body).not.toContain('select_accounts=')

    // A never-activated attempt is deleted, not parked as a zombie 'error'
    // row that would render next to a successful retry as a duplicate.
    expect(deleteCalls).toHaveLength(1)
    expect(updateCalls).toHaveLength(0)
  })

  it('marks a reconnect row as error (not deleted) when the session exchange fails', async () => {
    const deleteCalls: unknown[] = []
    const updateCalls: Record<string, unknown>[] = []
    mockFrom.mockImplementation(() => {
      const chain = mockChain({
        data: { id: 'conn-1', user_id: 'user-1', company_id: 'company-1', bank_name: 'TestBank', status: 'expired' },
        error: null,
      })
      chain.delete = vi.fn(() => {
        deleteCalls.push('delete')
        return chain
      })
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        updateCalls.push(payload)
        return chain
      })
      return chain
    })

    mockCreateSession.mockRejectedValue(new Error('upstream timeout'))

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('bank_error=')

    // An established connection keeps its row (history, accounts) and gets
    // the error surfaced on it instead.
    expect(deleteCalls).toHaveLength(0)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].status).toBe('error')
    expect(updateCalls[0].oauth_state).toBeNull()
  })

  it('redirects with error when bank returns error param (no state)', async () => {
    const response = await GET(makeRequest({ error: 'access_denied', error_description: 'User cancelled' }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    expect(location).toContain('/settings/banking?')
    // The user-facing message is Swedish; a cancel is an expected outcome, so
    // the raw provider text is not echoed back.
    expect(decodeURIComponent(location)).toContain('Anslutningen avbröts hos banken')
    // No state → no DB cleanup attempted
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('cleans up pending connection when bank returns error with state', async () => {
    mockFrom.mockImplementation(() =>
      mockChain({ data: null, error: null })
    )

    const response = await GET(makeRequest({
      error: 'access_denied',
      error_description: 'Denied data sharing consent',
      state: 'pending-state',
    }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    expect(location).toContain('/settings/banking?')
    expect(decodeURIComponent(location)).toContain('Anslutningen avbröts hos banken')
    // Should clean up the pending row
    expect(mockFrom).toHaveBeenCalledWith('bank_connections')
  })

  it('deletes a fresh pending row on bank denial instead of parking it in error', async () => {
    const deleteCalls: unknown[] = []
    const updateCalls: unknown[] = []
    mockFrom.mockImplementation(() => {
      const chain = mockChain({
        data: { id: 'conn-1', user_id: 'user-1', bank_name: 'TestBank', psu_type: 'business', status: 'pending' },
        error: null,
      })
      chain.delete = vi.fn(() => {
        deleteCalls.push('delete')
        return chain
      })
      chain.update = vi.fn((payload: unknown) => {
        updateCalls.push(payload)
        return chain
      })
      return chain
    })

    const response = await GET(makeRequest({
      error: 'access_denied',
      error_description: 'User cancelled',
      state: 'pending-state',
    }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    // URLSearchParams encodes spaces as '+', unlike the encodeURIComponent
    // fallback used when no matching row exists.
    expect(decodeURIComponent(location.replace(/\+/g, ' '))).toContain(
      'Anslutningen avbröts hos banken'
    )
    expect(deleteCalls).toHaveLength(1)
    expect(updateCalls).toHaveLength(0)
  })

  it('keeps a reconnect row on bank denial and marks it expired on session-expiry errors', async () => {
    const deleteCalls: unknown[] = []
    const updateCalls: Record<string, unknown>[] = []
    mockFrom.mockImplementation(() => {
      const chain = mockChain({
        data: { id: 'conn-1', user_id: 'user-1', bank_name: 'TestBank', psu_type: 'business', status: 'expired' },
        error: null,
      })
      chain.delete = vi.fn(() => {
        deleteCalls.push('delete')
        return chain
      })
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        updateCalls.push(payload)
        return chain
      })
      return chain
    })

    const response = await GET(makeRequest({
      error: 'server_error',
      error_description: 'Session expired at ASPSP',
      state: 'pending-state',
    }))

    expect(response.status).toBe(307)
    expect(deleteCalls).toHaveLength(0)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].status).toBe('expired')
    // The stored error_message is user-facing on the connection card: Swedish
    // explanation with the raw provider description surfaced in parentheses.
    expect(updateCalls[0].error_message).toContain('inloggningssession')
    expect(updateCalls[0].error_message).toContain('Session expired at ASPSP')
  })

  it('forwards bank_error_code and psu_type when the denied state matches a pending connection', async () => {
    mockFrom.mockImplementation(() =>
      mockChain({
        data: { id: 'conn-1', user_id: 'user-1', bank_name: 'Handelsbanken', psu_type: 'business', status: 'pending' },
        error: null,
      })
    )

    const response = await GET(makeRequest({
      error: 'server_error',
      state: 'pending-state',
    }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    expect(location).toContain('/settings/banking?')
    // A bare server_error used to surface as the literal token; the banner
    // now gets the Swedish explanation (issue #1716).
    expect(decodeURIComponent(location.replace(/\+/g, ' '))).toContain('fel på bankens sida')
    expect(location).toContain('bank_name=Handelsbanken')
    // The code is forwarded for every error, not just access_denied, together
    // with the connection's psu_type — the settings page keys the Handelsbanken
    // corporate fullmakt guidance off this exact combination.
    expect(location).toContain('bank_error_code=server_error')
    expect(location).toContain('psu_type=business')
  })

  it('redirects with error when code or state is missing', async () => {
    const response = await GET(makeRequest({ code: 'auth-code' }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    expect(location).toContain('/settings/banking?')
    expect(decodeURIComponent(location)).toContain('ofullständigt svar')
  })

  it('redirects with error when code fails format validation', async () => {
    const response = await GET(makeRequest({ code: '!!bad!!', state: 'some-state' }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    expect(location).toContain('/settings/banking?')
    expect(decodeURIComponent(location)).toContain('ogiltigt svar')
  })

  it('emits a durable consent_denied audit event when the bank denies with a matching row', async () => {
    const emitSpy = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined)
    try {
      mockFrom.mockImplementation(() =>
        mockChain({
          data: {
            id: 'conn-1',
            user_id: 'user-1',
            company_id: 'company-1',
            bank_name: 'Handelsbanken',
            psu_type: 'business',
            status: 'pending',
          },
          error: null,
        })
      )

      const response = await GET(makeRequest({
        error: 'server_error',
        error_description: 'ASPSP authorization failed',
        state: 'pending-state',
      }))

      expect(response.status).toBe(307)
      expect(emitSpy).toHaveBeenCalledWith({
        type: 'bank_connection.consent_denied',
        payload: {
          connectionId: 'conn-1',
          bankName: 'Handelsbanken',
          psuType: 'business',
          errorCode: 'server_error',
          errorDescription: 'ASPSP authorization failed',
          priorStatus: 'pending',
          userId: 'user-1',
          companyId: 'company-1',
        },
      })
    } finally {
      emitSpy.mockRestore()
    }
  })

  it('emits a durable finalize_failed audit event when the session exchange fails', async () => {
    const emitSpy = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined)
    try {
      mockFrom.mockImplementation(() =>
        mockChain({
          data: {
            id: 'conn-1',
            user_id: 'user-1',
            company_id: 'company-1',
            bank_name: 'TestBank',
            status: 'pending',
          },
          error: null,
        })
      )
      mockCreateSession.mockRejectedValue(new Error('upstream timeout'))

      const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))
      expect(response.status).toBe(200)
      await response.text()

      expect(emitSpy).toHaveBeenCalledWith({
        type: 'bank_connection.finalize_failed',
        payload: {
          connectionId: 'conn-1',
          bankName: 'TestBank',
          reason: 'upstream timeout',
          priorStatus: 'pending',
          userId: 'user-1',
          companyId: 'company-1',
        },
      })
    } finally {
      emitSpy.mockRestore()
    }
  })
})
