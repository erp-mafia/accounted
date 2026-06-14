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

import {
  isSessionExpiredResponse,
  SessionExpiredError,
  getAllTransactionsWithRaw,
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

describe('getAllTransactionsWithRaw — dead session', () => {
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
  chain.gte = vi.fn(() => chain)
  chain.limit = vi.fn(() => chain)
  chain.order = vi.fn(() => chain)
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

describe('POST /sync (enable-banking) — dead session reconnect', () => {
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

describe('POST /connect (enable-banking) — reconnect in place', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reuses the existing row (UPDATE, no INSERT) and keeps it out of the stale-pending sweep', async () => {
    // startAuthorization() POSTs to /auth — stub it (jwt is already mocked).
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

    // In-place: a fresh authorization on the SAME row, never a new INSERT, and
    // it stays 'expired' (not 'pending') so the cron's stale-pending cleanup
    // can't delete an established connection mid-reconnect.
    expect(insertSpy).not.toHaveBeenCalled()
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'expired',
        authorization_id: 'auth-123',
        session_id: null,
        error_message: null,
      })
    )
  })
})
