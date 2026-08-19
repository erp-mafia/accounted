import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { StoredAccount } from '../types'

// Mock the JWT signer so api-client can build a request header without real
// ENABLE_BANKING credentials (part 2 stubs fetch directly).
vi.mock('../lib/jwt', () => ({
  getAuthorizationHeader: () => 'Bearer test-token',
}))

// Mock the sync orchestrator so the /sync handler test can force a dead-session
// failure without hitting the network.
vi.mock('../lib/sync', () => ({
  syncAccountTransactions: vi.fn(),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: vi.fn().mockResolvedValue(null),
}))

import {
  isSessionExpiredResponse,
  SessionExpiredError,
  getAllTransactionsWithRaw,
  getPreferredAuthMethod,
  getPreferredAuthMethodDetails,
  startAuthorization,
} from '../lib/api-client'
import { enableBankingExtension } from '../index'
import { syncAccountTransactions } from '../lib/sync'

const CLOSED_SESSION_BODY = JSON.stringify({
  code: 401,
  message: 'Session is closed',
  error: 'CLOSED_SESSION',
  detail: null,
})

describe('isSessionExpiredResponse', () => {
  it('matches the CLOSED_SESSION 401 from the screenshot', () => {
    expect(isSessionExpiredResponse(401, CLOSED_SESSION_BODY)).toBe(true)
  })

  it('matches the lowercase session_expired variant', () => {
    expect(isSessionExpiredResponse(401, '{"error":"session_expired"}')).toBe(true)
  })

  it.each([
    '{"error":"EXPIRED_SESSION"}',
    '{"error":"INVALID_SESSION"}',
    '{"error":"SESSION_NOT_FOUND"}',
    '{"error":"WRONG_SESSION_STATUS"}',
    '{"message":"Session is closed"}',
  ])('matches session-dead body %s', (body) => {
    expect(isSessionExpiredResponse(401, body)).toBe(true)
    // 403 is also a valid session-rejection status from some ASPSPs.
    expect(isSessionExpiredResponse(403, body)).toBe(true)
  })

  it('does NOT match a bare 401 Unauthorized (app-credential problem, not a dead session)', () => {
    expect(isSessionExpiredResponse(401, '{"error":"Unauthorized"}')).toBe(false)
  })

  it('does NOT match a non-401/403 status even with a session code in the body', () => {
    expect(isSessionExpiredResponse(500, CLOSED_SESSION_BODY)).toBe(false)
    expect(isSessionExpiredResponse(400, '{"error":"ASPSP_ERROR"}')).toBe(false)
  })
})

describe('getAllTransactionsWithRaw: dead session', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws SessionExpiredError on a CLOSED_SESSION 401', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => CLOSED_SESSION_BODY,
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getAllTransactionsWithRaw('acc-1', '2026-01-01', '2026-06-01')
    ).rejects.toBeInstanceOf(SessionExpiredError)
  })
})

const syncRoute = enableBankingExtension.apiRoutes?.find(
  r => r.method === 'POST' && r.path === '/sync'
)

if (!syncRoute) {
  throw new Error('POST /sync route not registered on enable-banking extension')
}

function makeContext(connection: Record<string, unknown>, updateSpy: Mock, insertSpy?: Mock): ExtensionContext {
  // One universal chainable per from() call. Each table only ever terminates on
  // single() (bank_connections lookup) OR maybeSingle() (sie_imports /
  // company_members), so a single shared resolver is unambiguous. update()/
  // insert() record their payloads and return the chain so trailing
  // .eq()/.select() resolve.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  // The fresh-connect existing-connection guard chains .neq('status', 'revoked')
  // and resolves via maybeSingle (null here: no established row).
  chain.neq = vi.fn(() => chain)
  chain.gte = vi.fn(() => chain)
  chain.limit = vi.fn(() => chain)
  chain.order = vi.fn(() => chain)
  // The fresh-connect path sweeps never-activated rows before inserting:
  // .delete().eq(...).in(...).is(...).select('id') must chain through.
  chain.delete = vi.fn(() => chain)
  chain.in = vi.fn(() => chain)
  chain.is = vi.fn(() => chain)
  chain.insert = vi.fn((payload: unknown) => {
    insertSpy?.(payload)
    return chain
  })
  chain.single = vi.fn().mockResolvedValue({ data: connection, error: null })
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
  chain.update = vi.fn((payload: unknown) => {
    updateSpy(payload)
    return chain
  })

  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from: vi.fn(() => chain),
  }

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
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    services: {} as never,
  }
}

function makeRequest(): Request {
  return new Request('http://localhost/api/extensions/ext/enable-banking/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connection_id: 'conn-1' }),
  })
}

describe('POST /sync (enable-banking): dead session reconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('flips the connection to expired and returns a reauth-required 409', async () => {
    ;(syncAccountTransactions as unknown as Mock).mockRejectedValue(
      new SessionExpiredError(401, CLOSED_SESSION_BODY)
    )

    const updateSpy = vi.fn()
    const ctx = makeContext(
      {
        id: 'conn-1',
        company_id: 'company-1',
        status: 'active',
        bank_name: 'Nordea',
        accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }] as StoredAccount[],
      },
      updateSpy
    )

    const res = await syncRoute.handler(makeRequest(), ctx)

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.reauth_required).toBe(true)
    expect(body.code).toBe('SESSION_EXPIRED')
    expect(body.connection_id).toBe('conn-1')

    // The connection must be marked 'expired' so the UI surfaces the reconnect
    // affordance instead of looping on the dead session.
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired' })
    )
  })
})

const connectRoute = enableBankingExtension.apiRoutes?.find(
  r => r.method === 'POST' && r.path === '/connect'
)

if (!connectRoute) {
  throw new Error('POST /connect route not registered on enable-banking extension')
}

describe('POST /connect (enable-banking): reconnect in place', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reuses the existing row (UPDATE, no INSERT) and keeps it out of the stale-pending sweep', async () => {
    // startAuthorization() POSTs to /auth: stub it (jwt is already mocked).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ url: 'https://bank.example/auth', authorization_id: 'auth-123' }),
        text: async () => '',
      }))
    )

    const updateSpy = vi.fn()
    const insertSpy = vi.fn()
    const ctx = makeContext(
      {
        id: 'conn-1',
        company_id: 'company-1',
        bank_name: 'Nordea',
        provider: 'nordea-se',
        session_id: null, // null → skip the best-effort revoke call
        status: 'expired',
      },
      updateSpy,
      insertSpy
    )

    const req = new Request('http://localhost/api/extensions/ext/enable-banking/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection_id: 'conn-1', aspsp_name: 'Nordea', aspsp_country: 'SE' }),
    })

    const res = await connectRoute.handler(req, ctx)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connection_id).toBe('conn-1')
    expect(body.authorization_url).toBe('https://bank.example/auth')

    // In-place: a fresh authorization on the SAME row, never a new INSERT.
    expect(insertSpy).not.toHaveBeenCalled()

    // The CSRF state is staged on the row FIRST: before startAuthorization, so
    // before authorization_id even exists: guaranteeing the callback can always
    // find the row by oauth_state and the bank session can never be orphaned.
    // It stays 'expired' (not 'pending') so the cron's stale-pending cleanup
    // can't delete an established connection mid-reconnect.
    const firstUpdate = updateSpy.mock.calls[0][0]
    expect(firstUpdate).toMatchObject({
      oauth_state: expect.any(String),
      status: 'expired',
      error_message: null,
    })
    expect(firstUpdate).not.toHaveProperty('authorization_id')
    // The superseded session_id is deliberately KEPT on the row through the
    // round-trip. A PSD2 session can be shared by several of the user's
    // companies (lib/session-sharing.ts), and the callback needs the old id to
    // move those siblings onto the renewed consent. Nulling it here made the
    // renewal invisible and left them pointing at a dead session.
    expect(firstUpdate).not.toHaveProperty('session_id')

    // The bank's authorization_id is recorded in a follow-up write (audit only;
    // the callback never reads it, so a failure here can't break the reconnect).
    expect(updateSpy.mock.calls[1][0]).toEqual({ authorization_id: 'auth-123' })
  })
})

describe('POST /connect (enable-banking): psu_type persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubAuth() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ url: 'https://bank.example/auth', authorization_id: 'auth-123' }),
        text: async () => '',
      }))
    )
  }

  it('reuses the stored psu_type on reconnect when the client sends no override', async () => {
    // A 'personal' connection must NOT silently flip to 'business' on renewal:
    // that was the Handelsbanken signing-failure trap.
    stubAuth()
    const updateSpy = vi.fn()
    const ctx = makeContext(
      {
        id: 'conn-1',
        company_id: 'company-1',
        bank_name: 'Handelsbanken',
        provider: 'handelsbanken-se',
        session_id: null,
        status: 'expired',
        psu_type: 'personal',
      },
      updateSpy
    )

    const req = new Request('http://localhost/api/extensions/ext/enable-banking/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection_id: 'conn-1', aspsp_name: 'Handelsbanken', aspsp_country: 'SE' }),
    })

    const res = await connectRoute.handler(req, ctx)
    expect(res.status).toBe(200)
    // The CSRF-state staging update (first write) carries the reused type.
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ psu_type: 'personal' })
  })

  it('lets an explicit psu_type override the stored type (switch account type in place)', async () => {
    stubAuth()
    const updateSpy = vi.fn()
    const ctx = makeContext(
      {
        id: 'conn-1',
        company_id: 'company-1',
        bank_name: 'Handelsbanken',
        provider: 'handelsbanken-se',
        session_id: null,
        status: 'expired',
        psu_type: 'business',
      },
      updateSpy
    )

    const req = new Request('http://localhost/api/extensions/ext/enable-banking/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connection_id: 'conn-1',
        aspsp_name: 'Handelsbanken',
        aspsp_country: 'SE',
        psu_type: 'personal',
      }),
    })

    const res = await connectRoute.handler(req, ctx)
    expect(res.status).toBe(200)
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ psu_type: 'personal' })
  })

  it('persists psu_type on a fresh connect (derived from entity_type)', async () => {
    stubAuth()
    const insertSpy = vi.fn()
    // Fresh connect: the shared single() resolver returns this object for BOTH
    // the companies entity_type lookup and the post-insert row read, so giving it
    // entity_type drives the derivation and id provides the returned row.
    const ctx = makeContext(
      { id: 'conn-new', entity_type: 'enskild_firma' },
      vi.fn(),
      insertSpy
    )

    const req = new Request('http://localhost/api/extensions/ext/enable-banking/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aspsp_name: 'Handelsbanken', aspsp_country: 'SE' }),
    })

    const res = await connectRoute.handler(req, ctx)
    expect(res.status).toBe(200)
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy.mock.calls[0][0]).toMatchObject({ psu_type: 'personal' })
  })
})

describe('auth_method selection (Handelsbanken Mobile BankID)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubAspsps(aspsps: unknown[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ aspsps }),
        text: async () => '',
      }))
    )
  }

  it('pins a hidden DECOUPLED method with no psu_types (Handelsbanken Mobile BankID)', async () => {
    // Handelsbanken's real shape: BankID is decoupled + HIDDEN, Redirect is the
    // visible default. Hidden methods are only used when requested explicitly,
    // so we must pin BankID or corporate PSUs fail after approving in the app.
    // No psu_types on the method = applies to every PSU type.
    stubAspsps([
      {
        name: 'Handelsbanken',
        country: 'SE',
        bic: 'HANDSESS',
        auth_methods: [
          { name: 'BANKID', approach: 'DECOUPLED', hidden_method: true, title: 'Bank ID' },
          { name: 'REDIRECT', approach: 'REDIRECT', hidden_method: false, title: 'Redirect' },
        ],
      },
    ])

    expect(await getPreferredAuthMethod('Handelsbanken', 'SE', 'business')).toBe('BANKID')
  })

  it('does NOT pin a VISIBLE decoupled method (Lunar-class regression from PR #854)', async () => {
    // When the decoupled method is not hidden it is already part of the bank's
    // own default flow. Force-pinning it overrode Lunar's working default:
    // the user typed personnummer, was told to approve in the Lunar app, and
    // the approval request never arrived. undefined = let the ASPSP default run.
    stubAspsps([
      {
        name: 'Lunar',
        country: 'SE',
        auth_methods: [
          { name: 'DECOUPLED', approach: 'DECOUPLED', hidden_method: false, title: 'App' },
        ],
      },
    ])

    expect(await getPreferredAuthMethod('Lunar', 'SE', 'business')).toBeUndefined()
  })

  it('does NOT pin a hidden decoupled method scoped to a different psu_type', async () => {
    stubAspsps([
      {
        name: 'Testbank',
        country: 'SE',
        auth_methods: [
          {
            name: 'BANKID',
            approach: 'DECOUPLED',
            hidden_method: true,
            psu_types: ['personal'],
          },
        ],
      },
    ])

    expect(await getPreferredAuthMethod('Testbank', 'SE', 'business')).toBeUndefined()
  })

  it('pins a hidden decoupled method whose psu_types matches (or is empty)', async () => {
    stubAspsps([
      {
        name: 'Testbank',
        country: 'SE',
        auth_methods: [
          {
            name: 'BANKID_BUSINESS',
            approach: 'DECOUPLED',
            hidden_method: true,
            psu_types: ['business'],
          },
        ],
      },
    ])
    expect(await getPreferredAuthMethod('Testbank', 'SE', 'business')).toBe('BANKID_BUSINESS')

    // An empty psu_types array is treated like a missing one: applies to all.
    stubAspsps([
      {
        name: 'Testbank',
        country: 'SE',
        auth_methods: [
          { name: 'BANKID_ALL', approach: 'DECOUPLED', hidden_method: true, psu_types: [] },
        ],
      },
    ])
    expect(await getPreferredAuthMethod('Testbank', 'SE', 'personal')).toBe('BANKID_ALL')
  })

  it('returns undefined (ASPSP default) when the bank has no decoupled method', async () => {
    stubAspsps([
      { name: 'Nordea', country: 'SE', auth_methods: [{ name: 'REDIRECT', approach: 'REDIRECT' }] },
    ])

    expect(await getPreferredAuthMethod('Nordea', 'SE', 'personal')).toBeUndefined()
  })

  it('returns undefined when the bank is not found in the ASPSP list', async () => {
    stubAspsps([])
    expect(await getPreferredAuthMethod('Handelsbanken', 'SE', 'business')).toBeUndefined()
  })

  it('getPreferredAuthMethodDetails returns the full method so the connect log can record it', async () => {
    stubAspsps([
      {
        name: 'Handelsbanken',
        country: 'SE',
        auth_methods: [
          {
            name: 'BANKID',
            approach: 'DECOUPLED',
            hidden_method: true,
            psu_types: ['business'],
          },
        ],
      },
    ])

    expect(await getPreferredAuthMethodDetails('Handelsbanken', 'SE', 'business')).toEqual({
      name: 'BANKID',
      approach: 'DECOUPLED',
      hidden_method: true,
      psu_types: ['business'],
    })
  })

  it('startAuthorization sends auth_method in the request body when provided', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ url: 'https://bank.example/auth', authorization_id: 'auth-1' }),
      text: async () => '',
    }))
    vi.stubGlobal('fetch', fetchMock)

    await startAuthorization('Handelsbanken', 'SE', 'https://app/cb', 'state-1', 'business', 'BANKID')

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body.auth_method).toBe('BANKID')
    expect(body.psu_type).toBe('business')
  })

  it('startAuthorization omits auth_method when none is provided', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ url: 'https://bank.example/auth', authorization_id: 'auth-1' }),
      text: async () => '',
    }))
    vi.stubGlobal('fetch', fetchMock)

    await startAuthorization('Nordea', 'SE', 'https://app/cb', 'state-1', 'personal')

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect('auth_method' in body).toBe(false)
  })
})
