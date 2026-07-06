import { describe, it, expect, beforeEach, vi } from 'vitest'

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

import { skvRequest, SkatteverketAuthError } from '../lib/api-client'

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
      await skvRequest(fakeSupabase, 'user-1', 'GET', '/x')
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
      await skvRequest(fakeSupabase, 'user-1', 'GET', '/x')
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
      await skvRequest(fakeSupabase, 'user-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('TOKEN_REVOKED')
      expect((e as SkatteverketAuthError).message).toMatch(/återkallat/i)
      expect(deleteTokensMock).toHaveBeenCalledWith(fakeSupabase, 'user-1')
    }
  })

  it('maps 401 with WWW-Authenticate insufficient_scope → MISSING_SCOPE', async () => {
    mockFetchStatus(401, '', {
      'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="agd"',
    })
    try {
      await skvRequest(fakeSupabase, 'user-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('MISSING_SCOPE')
    }
  })

  it('maps 403 with Behörighet body → BEHORIGHET_SAKNAS', async () => {
    mockFetchStatus(403, 'Behörighet saknas för aktören')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('BEHORIGHET_SAKNAS')
    }
  })

  it('maps generic 403 → ACCESS_DENIED', async () => {
    mockFetchStatus(403, 'Forbidden')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'GET', '/x')
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('ACCESS_DENIED')
    }
  })

  it('maps 429 → RATE_LIMITED (new behavior)', async () => {
    mockFetchStatus(429)
    try {
      await skvRequest(fakeSupabase, 'user-1', 'GET', '/x')
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
    const res = await skvRequest(fakeSupabase, 'user-1', 'GET', '/x')
    expect(res.status).toBe(503)
  })

  it('returns the response for success', async () => {
    mockFetchStatus(200, '{"ok":true}')
    const res = await skvRequest(fakeSupabase, 'user-1', 'GET', '/x')
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

describe('refresh-token 404 classification', () => {
  // SKV's per-flow refresh tokens live 65 minutes, so daily crons always find
  // a dead token and get 404 id_not_found. That must surface as the
  // SESSION_EXPIRED SkatteverketAuthError (which cron quiet-buckets and the
  // UI reconnect flow understand), not as a raw Error that error-logs every
  // night. Unique userIds per test: the module-level refresh coalescing map
  // is keyed by userId.
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
