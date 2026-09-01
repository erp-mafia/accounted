import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the token-store to bypass DB and supply a fresh access token.
vi.mock('../lib/token-store', () => ({
  getTokens: vi.fn(async () => ({
    access_token: 'user-skv-token',
    refresh_token: 'user-skv-refresh',
    expires_at: Date.now() + 60 * 60_000,
    refresh_count: 0,
    scope: 'momsdeklaration',
  })),
  storeTokens: vi.fn(),
  deleteTokens: vi.fn(),
}))

vi.mock('../lib/oauth', () => ({
  refreshAccessToken: vi.fn(async () => ({
    access_token: 'refreshed',
    refresh_token: 'refreshed-r',
    expires_at: Date.now() + 60 * 60_000,
    refresh_count: 1,
  })),
  exchangeCodeForTokens: vi.fn(),
}))

import { skvRequest, SkatteverketAuthError, getSkatteverketEnvironment } from '../lib/api-client'

const fakeSupabase = {} as unknown as Parameters<typeof skvRequest>[0]

const ENV_VARS = [
  'SKATTEVERKET_APIGW_CLIENT_ID',
  'SKATTEVERKET_APIGW_CLIENT_SECRET',
  'SKATTEVERKET_OAUTH2_CLIENT_ID',
  'SKATTEVERKET_API_BASE_URL',
  'SKATTEVERKET_AGD_PERIOD_API_BASE_URL',
  'GNUBOK_CONNECTOR_KEY',
  'GNUBOK_CONNECT_URL',
]

/**
 * Connector-mode env: a self-host with a connector key and NO own SKV
 * credentials. Env is stubbed in beforeEach, never at module top: a base-URL
 * const captured at import time would not see module-top stubs.
 */
beforeEach(() => {
  for (const v of ENV_VARS) delete process.env[v]
  process.env.GNUBOK_CONNECTOR_KEY = 'gnubok_ck_test'
  process.env.GNUBOK_CONNECT_URL = 'https://app.hosted.example'
  vi.restoreAllMocks()
})

afterEach(() => {
  for (const v of ENV_VARS) delete process.env[v]
})

function mockFetchStatus(status: number, body = '', headers?: HeadersInit) {
  const mock = vi.fn(async () => new Response(body, { status, headers }))
  global.fetch = mock as unknown as typeof fetch
  return mock
}

function lastFetchCall(mock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return mock.mock.calls[0] as unknown as [string, RequestInit]
}

describe('skvRequestWithAuth: connector mode', () => {
  it('routes to the data proxy with remapped headers and NO gateway credentials', async () => {
    const fetchMock = mockFetchStatus(200, '{"ok":true}')

    const res = await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/deklarationer')
    expect(res.status).toBe(200)

    const [url, init] = lastFetchCall(fetchMock)
    // Default (unset) moms base → the moms service segment; the proxy
    // resolves the real upstream from hosted's env, not this instance's.
    expect(url).toBe('https://app.hosted.example/api/connect/skv/api/moms/deklarationer')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer gnubok_ck_test')
    expect(headers['X-Connector-Upstream-Authorization']).toBe('Bearer user-skv-token')
    // The gateway credentials are the broker's secret; the instance has none
    // and must not try to read them (getApiGwClientId would throw).
    expect(headers['Client_Id']).toBeUndefined()
    expect(headers['Client_Secret']).toBeUndefined()
  })

  it('maps a per-service baseUrl to its proxy segment', async () => {
    const fetchMock = mockFetchStatus(200, '{}')

    await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/kvittenser', undefined, {
      baseUrl: 'https://api.test.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1',
    })

    const [url] = lastFetchCall(fetchMock)
    expect(url).toBe('https://app.hosted.example/api/connect/skv/api/agd-period/kvittenser')
  })

  it('mirrors the content type to the upstream content-type header on bodied requests', async () => {
    const fetchMock = mockFetchStatus(200, '{}')

    await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'POST', '/underlag', '<xml/>', {
      baseUrl: 'https://api.test.skatteverket.se/arbetsgivardeklaration/inlamning/v1',
      contentType: 'application/xml',
    })

    const [url, init] = lastFetchCall(fetchMock)
    expect(url).toBe('https://app.hosted.example/api/connect/skv/api/agd-inlamning/underlag')
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/xml')
    expect(headers['X-Connector-Upstream-Content-Type']).toBe('application/xml')
    expect(init.body).toBe('<xml/>')
  })

  it('classifies a broker key refusal as ACCESS_DENIED with connector guidance, not APIGW guidance', async () => {
    mockFetchStatus(401, '{"error":"Invalid connector key","code":"CONNECTOR_KEY_INVALID"}')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('ACCESS_DENIED')
      const { message } = e as SkatteverketAuthError
      // The operator's actual knob, not the hosted APIGW's.
      expect(message).toMatch(/GNUBOK_CONNECTOR_KEY/)
      expect(message).not.toMatch(/SKATTEVERKET_APIGW_CLIENT_ID|Utvecklarportalen/)
    }
  })

  it('classifies CONNECTOR_NOT_OWNED (ledger no longer vouches) as SESSION_EXPIRED', async () => {
    mockFetchStatus(404, '{"error":"Unknown Skatteverket connection for this key","code":"CONNECTOR_NOT_OWNED"}')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
      expect((e as SkatteverketAuthError).message).toMatch(/BankID/)
    }
  })

  it('classifies CONNECTOR_RATE_LIMITED as RATE_LIMITED', async () => {
    mockFetchStatus(429, '{"error":"busy","code":"CONNECTOR_RATE_LIMITED"}')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('RATE_LIMITED')
    }
  })

  it('still maps an upstream SKV body passed through the proxy with the normal rules', async () => {
    // No CONNECTOR_* code → this is Skatteverket answering through the
    // proxy; the pre-connector classification must keep applying.
    mockFetchStatus(403, 'Behörighet saknas för aktören')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('BEHORIGHET_SAKNAS')
    }
  })

  it('keeps the passed-through WWW-Authenticate classification: insufficient_scope → MISSING_SCOPE', async () => {
    // The proxy forwards SKV's diagnostic headers, so the direct path's
    // scope classification must keep working through the connector.
    mockFetchStatus(401, '', {
      'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="agd"',
    })
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('MISSING_SCOPE')
    }
  })

  it('gives connector guidance (never APIGW/Utvecklarportalen) on a body-less passthrough 401', async () => {
    // An empty 401 through the proxy means the HOSTED gateway config
    // refused; the operator's instance has no SKATTEVERKET_APIGW_CLIENT_ID
    // to check, so the direct path's guidance would be a dead end.
    mockFetchStatus(401, '')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('ACCESS_DENIED')
      const { message } = e as SkatteverketAuthError
      expect(message).toMatch(/connectorn/)
      expect(message).not.toMatch(/SKATTEVERKET_APIGW_CLIENT_ID|Utvecklarportalen/)
    }
  })

  it('gives connector guidance on the APIGW scope-contract 403 passthrough', async () => {
    mockFetchStatus(403, '{"error": "The required scopes are not authorized"}')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('ACCESS_DENIED')
      const { message } = e as SkatteverketAuthError
      expect(message).toMatch(/connectorn/)
      expect(message).not.toMatch(/Utvecklarportalen/)
    }
  })

  it('classifies the broker CONNECTOR_SKV_REFRESH_DEAD dialect as SESSION_EXPIRED', async () => {
    // The everyday case: SKV per-flow refresh tokens die after 65 minutes;
    // the broker re-codes SKV's dead-token dialects as 401
    // CONNECTOR_SKV_REFRESH_DEAD, and the reconnect flow must fire exactly
    // as it does on the direct path.
    const { getTokens } = await import('../lib/token-store')
    const { refreshAccessToken } = await import('../lib/oauth')
    const expiredTokens = {
      access_token: 'stale',
      refresh_token: 'old-refresh',
      expires_at: Date.now() - 60_000,
      refresh_count: 1,
      scope: 'momsdeklaration',
    }
    vi.mocked(getTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(
      new Error(
        'Skatteverket token refresh failed (401): {"error":"Skatteverket refresh token is no longer valid; a new BankID consent is required","code":"CONNECTOR_SKV_REFRESH_DEAD"}',
      ),
    )

    try {
      await skvRequest(fakeSupabase, 'user-connector-dead', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
      expect((e as SkatteverketAuthError).message).toMatch(/Sessionen har gått ut/)
    }
  })

  it('classifies the broker refresh dialect (404 CONNECTOR_NOT_OWNED) as SESSION_EXPIRED', async () => {
    const { getTokens } = await import('../lib/token-store')
    const { refreshAccessToken } = await import('../lib/oauth')
    const expiredTokens = {
      access_token: 'stale',
      refresh_token: 'dead-refresh',
      expires_at: Date.now() - 60_000,
      refresh_count: 1,
      scope: 'momsdeklaration',
    }
    vi.mocked(getTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(
      new Error(
        'Skatteverket token refresh failed (404): {"error":"Unknown connection for this key","code":"CONNECTOR_NOT_OWNED"}',
      ),
    )

    try {
      await skvRequest(fakeSupabase, 'user-connector-404', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
    }
  })

  it('leaves broker 502s (CONNECTOR_SKV_TOKEN_FAILED) as raw errors, never a reconnect flag', async () => {
    // A transient SKV outage behind the broker must not tell the user to
    // reconnect (#1155): only the 404 not-owned dialect is terminal.
    const { getTokens } = await import('../lib/token-store')
    const { refreshAccessToken } = await import('../lib/oauth')
    const expiredTokens = {
      access_token: 'stale',
      refresh_token: 'r',
      expires_at: Date.now() - 60_000,
      refresh_count: 1,
      scope: 'momsdeklaration',
    }
    vi.mocked(getTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(
      new Error(
        'Skatteverket token refresh failed (502): {"error":"Skatteverket token exchange failed","code":"CONNECTOR_SKV_TOKEN_FAILED"}',
      ),
    )

    try {
      await skvRequest(fakeSupabase, 'user-connector-502', 'comp-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).not.toBeInstanceOf(SkatteverketAuthError)
      expect((e as Error).message).toMatch(/502/)
    }
  })
})

describe('skvRequestWithAuth: connector mode is OFF with own credentials (direct path byte-identical)', () => {
  it('a connector key does not reroute an own-credentials instance', async () => {
    // Hosted, and any self-host running its own SKV client: the direct path
    // must stay exactly as before, connector key or not.
    process.env.SKATTEVERKET_APIGW_CLIENT_ID = 'gw-id'
    process.env.SKATTEVERKET_APIGW_CLIENT_SECRET = 'gw-secret'
    process.env.SKATTEVERKET_API_BASE_URL = 'https://api.test.example/moms'
    const fetchMock = mockFetchStatus(200, '{"ok":true}')

    await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/deklarationer')

    const [url, init] = lastFetchCall(fetchMock)
    expect(url).toBe('https://api.test.example/moms/deklarationer')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer user-skv-token')
    expect(headers['Client_Id']).toBe('gw-id')
    expect(headers['Client_Secret']).toBe('gw-secret')
    expect(headers['skv_client_correlation_id']).toBeDefined()
    // Nothing connector-shaped leaks to the real upstream.
    expect(headers['X-Connector-Upstream-Authorization']).toBeUndefined()
    expect(headers['X-Connector-Upstream-Content-Type']).toBeUndefined()
    expect(JSON.stringify(headers)).not.toContain('gnubok_ck_')
  })
})

describe('skvRequestWithAuth: system mode is never brokered', () => {
  it('unconfigured system auth on a connector self-host fails with SYSTEM_AUTH_FAILED before any fetch', async () => {
    // System (CCG/ombud) auth is a hosted-only feature: connector mode must
    // not reroute it, and a credential-less self-host fails cleanly.
    const fetchMock = mockFetchStatus(200, '{}')
    try {
      const { skvRequestWithAuth } = await import('../lib/api-client')
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('SYSTEM_AUTH_FAILED')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getSkatteverketEnvironment: connector mode', () => {
  it("reports 'prod' in connector mode (hosted resolves the upstream, instance defaults would lie 'test')", () => {
    expect(getSkatteverketEnvironment()).toBe('prod')
  })

  it('keeps the env-based answer when own credentials disable connector mode', () => {
    process.env.SKATTEVERKET_APIGW_CLIENT_ID = 'gw-id'
    expect(getSkatteverketEnvironment()).toBe('test')
    process.env.SKATTEVERKET_API_BASE_URL = 'https://api.skatteverket.se/momsdeklaration/v1'
    expect(getSkatteverketEnvironment()).toBe('prod')
  })
})
