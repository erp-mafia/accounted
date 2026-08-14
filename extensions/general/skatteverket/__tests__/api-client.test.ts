import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the token-store to bypass DB and supply a fresh access token.
const deleteTokensMock = vi.fn()
vi.mock('../lib/token-store', () => ({
  getTokens: vi.fn(async () => ({
    access_token: 'test-access',
    refresh_token: 'test-refresh',
    expires_at: Date.now() + 60 * 60_000,
    refresh_count: 0,
    scope: 'momsdeklaration',
  })),
  storeTokens: vi.fn(),
  deleteTokens: (...args: unknown[]) => deleteTokensMock(...args),
}))

// Mock oauth so a refresh attempt (shouldn't fire) is harmless.
vi.mock('../lib/oauth', () => ({
  refreshAccessToken: vi.fn(async () => ({
    access_token: 'refreshed',
    refresh_token: 'refreshed-r',
    expires_at: Date.now() + 60 * 60_000,
    refresh_count: 1,
  })),
  exchangeCodeForTokens: vi.fn(),
}))

import { skvRequest, skvRequestWithAuth, SkatteverketAuthError } from '../lib/api-client'
import { __resetSystemTokenCacheForTests } from '../lib/system-auth/token-provider'

const fakeSupabase = {} as unknown as Parameters<typeof skvRequest>[0]

beforeEach(() => {
  process.env.SKATTEVERKET_APIGW_CLIENT_ID = 'gw-id'
  process.env.SKATTEVERKET_APIGW_CLIENT_SECRET = 'gw-secret'
  process.env.SKATTEVERKET_API_BASE_URL = 'https://api.test.example/x'
  vi.restoreAllMocks()
})

function mockFetchStatus(status: number, body = '', headers?: HeadersInit) {
  global.fetch = vi.fn(async () =>
    new Response(body, { status, statusText: String(status), headers })
  ) as unknown as typeof fetch
}

describe('skvRequest: error mapping', () => {
  it('maps empty 401 → ACCESS_DENIED (likely missing APIGW subscription)', async () => {
    mockFetchStatus(401)
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('ACCESS_DENIED')
      expect((e as SkatteverketAuthError).message).toMatch(/Utvecklarportalen|prenumeration/i)
    }
  })

  it('maps 401 with body text → SESSION_EXPIRED with a clean Swedish message (no body leak)', async () => {
    mockFetchStatus(401, 'token expired')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
      expect((e as SkatteverketAuthError).message).toMatch(/Sessionen har gått ut/)
      // Audit V16.1: the raw response body must NOT be concatenated into the
      // user-facing message: that information stays in server-side logs.
      expect((e as SkatteverketAuthError).message).not.toContain('token expired')
    }
  })

  it('maps 401 with "Token has been revoked." body → TOKEN_REVOKED and clears local row', async () => {
    deleteTokensMock.mockClear()
    mockFetchStatus(401, '{"error":"Token has been revoked."}')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('TOKEN_REVOKED')
      expect((e as SkatteverketAuthError).message).toMatch(/återkallat/i)
      expect(deleteTokensMock).toHaveBeenCalledWith(fakeSupabase, 'user-1', 'comp-1')
    }
  })

  it('maps 401 with WWW-Authenticate insufficient_scope → MISSING_SCOPE', async () => {
    mockFetchStatus(401, '', {
      'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="agd"',
    })
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('MISSING_SCOPE')
    }
  })

  it('maps 403 with Behörighet body → BEHORIGHET_SAKNAS', async () => {
    mockFetchStatus(403, 'Behörighet saknas för aktören')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('BEHORIGHET_SAKNAS')
    }
  })

  // #1155: the MuleSoft APIGW contract error wears scope wording but is our
  // subscription gap (#973), not the user's token. It used to match the
  // `required scope` substring test and surface as MISSING_SCOPE, which is in
  // RECONSENT_ERROR_CODES: every reconnect ran runPostConnectRefresh ->
  // syncSkattekonto -> 403 and instantly re-flagged the row, so the reconnect
  // banner could never be cleared.
  it('maps the APIGW "required scopes are not authorized" 403 → ACCESS_DENIED, not MISSING_SCOPE', async () => {
    mockFetchStatus(403, '{"error": "The required scopes are not authorized"}')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('ACCESS_DENIED')
      expect((e as SkatteverketAuthError).message).toMatch(/APIGW|Utvecklarportalen/)
    }
  })

  // The same body has two causes (subscription gap #973, missing token scope
  // like the AGI kvittens one), and the gateway never says which. A message
  // naming only the subscription sent a real prod filing down a dead end: the
  // fix was a scope, so every minute spent in Utvecklarportalen was wasted.
  it('names BOTH causes and the refused service on the gateway 403', async () => {
    mockFetchStatus(403, '{"error": "The required scopes are not authorized"}')
    try {
      // The real shape of the incident: the kvittens read on the hantera API.
      await skvRequest(
        fakeSupabase, 'user-1', 'comp-1', 'GET',
        '/arbetsgivare/165560000000/redovisningsperioder/202608/kvittenser',
        undefined,
        { baseUrl: 'https://api.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1' },
      )
      expect.fail('expected throw')
    } catch (e) {
      const { message } = e as SkatteverketAuthError
      expect(message).toMatch(/prenumeration/)
      expect(message).toMatch(/scope/)
      // Which service refused. Naming it is the whole point: the sibling
      // inlamning API kept working, so "Skatteverket said no" is not a clue.
      expect(message).toContain('arbetsgivardeklaration/hanteraredovisningsperiod/v1')
    }
  })

  it('still maps a real token-scope rejection → MISSING_SCOPE', async () => {
    // Body shape from SKV's AGI Tjänstebeskrivning v1.7 §4.1.2.2.
    mockFetchStatus(
      403,
      '{"error":"invalid_scope","description":"The required scope agd has been requested for that access token."}',
    )
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('MISSING_SCOPE')
    }
  })

  it('maps the SKV scope sentence alone (no invalid_scope code) → MISSING_SCOPE', async () => {
    mockFetchStatus(403, 'The required scope agd has been requested for that access token.')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('MISSING_SCOPE')
    }
  })

  it('treats the APIGW contract wording on a 401 as a gateway issue, even with an OAuth challenge header', async () => {
    // SESSION_EXPIRED and MISSING_SCOPE are both reconsent codes, so either
    // verdict would re-arm the banner. The gateway signature wins over the
    // WWW-Authenticate scope marker when both are present.
    mockFetchStatus(401, '{"error": "The required scopes are not authorized"}', {
      'WWW-Authenticate': 'Bearer error="invalid_scope"',
    })
    try {
      await skvRequest(
        fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', undefined,
        { baseUrl: 'https://api.skatteverket.se/arbetsgivardeklaration/inlamning/v1' },
      )
      expect.fail('expected throw')
    } catch (e) {
      const { code, message } = e as SkatteverketAuthError
      expect(code).toBe('ACCESS_DENIED')
      // Same shared message as the 403 contract path: both causes named plus
      // the refused service, so the 401 shape cannot drift into vaguer text.
      expect(message).toMatch(/prenumeration/)
      expect(message).toMatch(/scope/)
      expect(message).toContain('arbetsgivardeklaration/inlamning/v1')
    }
  })

  it('maps generic 403 → ACCESS_DENIED', async () => {
    mockFetchStatus(403, 'Forbidden')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('ACCESS_DENIED')
    }
  })

  it('maps 429 → RATE_LIMITED (new behavior)', async () => {
    mockFetchStatus(429)
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('RATE_LIMITED')
      // Swedish message: UI surfaces it directly.
      expect((e as SkatteverketAuthError).message).toMatch(/Skatteverket/)
      expect((e as SkatteverketAuthError).message).toMatch(/igen/i)
    }
  })

  it('returns the response for 5xx (caller decides retry)', async () => {
    mockFetchStatus(503, 'Service Unavailable')
    const res = await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
    expect(res.status).toBe(503)
  })

  it('returns the response for success', async () => {
    mockFetchStatus(200, '{"ok":true}')
    const res = await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ ok: true })
  })
})

describe('SkatteverketAuthError', () => {
  it('exposes the new TOKEN_CORRUPTED and RATE_LIMITED codes', () => {
    const a = new SkatteverketAuthError('msg', 'TOKEN_CORRUPTED')
    const b = new SkatteverketAuthError('msg', 'RATE_LIMITED')
    expect(a.code).toBe('TOKEN_CORRUPTED')
    expect(b.code).toBe('RATE_LIMITED')
  })
})

describe('skvRequestWithAuth: system mode', () => {
  beforeEach(() => {
    process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'on'
    process.env.SKATTEVERKET_SYSTEM_AUTH_MECHANISM = 'stub'
    __resetSystemTokenCacheForTests()
    deleteTokensMock.mockClear()
  })

  afterEach(() => {
    delete process.env.SKATTEVERKET_SYSTEM_AUTH_MODE
    delete process.env.SKATTEVERKET_SYSTEM_AUTH_MECHANISM
  })

  it('sends the system token and returns success responses', async () => {
    mockFetchStatus(200, '{"ok":true}')
    const res = await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x')
    expect(res.status).toBe(200)
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((call[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer stub-system-token',
    })
  })

  it('401 in system mode -> SYSTEM_AUTH_FAILED and NEVER touches the user token table', async () => {
    mockFetchStatus(401, '{"error":"Token has been revoked."}')
    try {
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('SYSTEM_AUTH_FAILED')
    }
    // The revoked-body branch deletes the user row in user mode; system
    // mode must never reach it.
    expect(deleteTokensMock).not.toHaveBeenCalled()
  })

  it('403 in system mode -> OMBUD_GRANT_MISSING (company-level)', async () => {
    mockFetchStatus(403, 'Forbidden')
    try {
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('OMBUD_GRANT_MISSING')
    }
    expect(deleteTokensMock).not.toHaveBeenCalled()
  })

  it('403 invalid_scope in system mode -> SYSTEM_AUTH_FAILED (config, not grant)', async () => {
    mockFetchStatus(403, '{"error":"invalid_scope"}')
    try {
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('SYSTEM_AUTH_FAILED')
      expect((e as SkatteverketAuthError).message).toMatch(/SKATTEVERKET_SYSTEM_SCOPES/)
    }
  })

  it('403 APIGW contract error in system mode names both knobs', async () => {
    // Still SYSTEM_AUTH_FAILED (run-level config either way). This assertion
    // is the inverse of what it was: #1250 removed the SKATTEVERKET_SYSTEM_SCOPES
    // mention on the reasoning that the gateway, not the scope list, had
    // refused. Production later proved the body cannot distinguish the two, so
    // naming one and hiding the other is a coin flip presented as a diagnosis.
    mockFetchStatus(403, '{"error": "The required scopes are not authorized"}')
    try {
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('SYSTEM_AUTH_FAILED')
      expect((e as SkatteverketAuthError).message).toMatch(/prenumeration/)
      expect((e as SkatteverketAuthError).message).toMatch(/SKATTEVERKET_SYSTEM_SCOPES/)
    }
  })

  it('unconfigured system auth -> SYSTEM_AUTH_FAILED before any fetch', async () => {
    process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'off'
    global.fetch = vi.fn() as unknown as typeof fetch
    try {
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('SYSTEM_AUTH_FAILED')
    }
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('refresh-token dead-session classification', () => {
  // SKV's per-flow refresh tokens live 65 minutes, so crons always find a
  // dead token. SKV reports that in several dialects (404 id_not_found,
  // 400 "Refresh Token status is expired", 400 invalid_grant); all must
  // surface as the SESSION_EXPIRED SkatteverketAuthError (which cron
  // quiet-buckets and the UI reconnect flow understand), not as a raw
  // Error that error-logs every run. Unique userIds per test: the
  // module-level refresh coalescing map is keyed by userId.
  const expiredTokens = {
    access_token: 'stale',
    refresh_token: 'dead-refresh',
    expires_at: Date.now() - 60_000,
    refresh_count: 1,
    scope: 'momsdeklaration',
  }

  it('classifies 404 id_not_found as SESSION_EXPIRED', async () => {
    const { getTokens } = await import('../lib/token-store')
    const { refreshAccessToken } = await import('../lib/oauth')
    // getValidToken reads once, refreshTokenForUser re-reads — queue both.
    vi.mocked(getTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(
      new Error(
        'Skatteverket token refresh failed (404): {\n  "error":"id_not_found",\n  "error_description":"The refresh token is not found"\n}\n',
      ),
    )

    try {
      await skvRequest(fakeSupabase, 'user-404', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
      expect((e as SkatteverketAuthError).message).toMatch(/Sessionen har gått ut/)
    }
  })

  it('classifies 400 "Refresh Token status is expired" as SESSION_EXPIRED', async () => {
    // Exact prod payload observed 2026-07-24: the AGI kvittenser cron hit
    // this every 15 minutes and error-logged it because only the 404
    // dialect was classified.
    const { getTokens } = await import('../lib/token-store')
    const { refreshAccessToken } = await import('../lib/oauth')
    vi.mocked(getTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(
      new Error(
        'Skatteverket token refresh failed (400): {\n  "error":"access_denied",\n  "error_description":"Refresh Token status is expired"\n}\n',
      ),
    )

    try {
      await skvRequest(fakeSupabase, 'user-400-expired', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
      expect((e as SkatteverketAuthError).message).toMatch(/Sessionen har gått ut/)
    }
  })

  it('classifies 400 invalid_grant as SESSION_EXPIRED', async () => {
    const { getTokens } = await import('../lib/token-store')
    const { refreshAccessToken } = await import('../lib/oauth')
    vi.mocked(getTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(
      new Error('Skatteverket token refresh failed (400): {"error": "invalid_grant"}'),
    )

    try {
      await skvRequest(fakeSupabase, 'user-400-grant', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
    }
  })

  it('leaves config-shaped 400s (invalid_client) as raw errors', async () => {
    // invalid_client means OUR client credentials are broken; telling the
    // user to reconnect cannot fix it and would re-create the
    // self-perpetuating reconnect banner (2026-07 MISSING_SCOPE incident).
    const { getTokens } = await import('../lib/token-store')
    const { refreshAccessToken } = await import('../lib/oauth')
    vi.mocked(getTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(
      new Error('Skatteverket token refresh failed (400): {"error":"invalid_client"}'),
    )

    try {
      await skvRequest(fakeSupabase, 'user-400-client', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).not.toBeInstanceOf(SkatteverketAuthError)
      expect((e as Error).message).toMatch(/invalid_client/)
    }
  })

  it('re-throws other refresh failures untouched', async () => {
    const { getTokens } = await import('../lib/token-store')
    const { refreshAccessToken } = await import('../lib/oauth')
    vi.mocked(getTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(
      new Error('Skatteverket token refresh failed (500): upstream unavailable'),
    )

    try {
      await skvRequest(fakeSupabase, 'user-500', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).not.toBeInstanceOf(SkatteverketAuthError)
      expect((e as Error).message).toMatch(/500/)
    }
  })
})
