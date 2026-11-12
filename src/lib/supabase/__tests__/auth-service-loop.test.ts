import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * A page cannot call the auth service in a loop.
 *
 * The real proxy (updateSession) and the real Supabase client, against a
 * counting stand-in for Supabase Auth. Each test replays one request the way
 * the client of 2026-11-11 did: the same cookie every time, nothing the
 * server sends back is stored, nine requests a second. That day every
 * request cost a /user call, every request in the refresh window cost a
 * refresh, the refreshes drew 1,665 rate limits in 135 seconds, and the rate
 * limit was read as "signed out": cookies cleared, bounce to /login.
 */

// Each request runs the whole proxy with a real client: about 20 ms.
vi.setConfig({ testTimeout: 30_000 })

vi.mock('server-only', () => ({}))

const SUPABASE_URL = 'https://abcdefgh.supabase.co'
const SESSION_COOKIE = 'sb-abcdefgh-auth-token'
const USER_ID = '667c36e3-ef84-4c1b-8338-e502723cd101'
const NOW = new Date('2026-11-11T14:11:46Z')

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** An access token shaped like GoTrue's; HS256, so auth-js verifies it by asking /user. */
function accessToken(expiresAtSeconds: number, label: string): string {
  const header = base64url({ alg: 'HS256', typ: 'JWT' })
  const payload = base64url({
    sub: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    iss: `${SUPABASE_URL}/auth/v1`,
    exp: expiresAtSeconds,
    iat: expiresAtSeconds - 3600,
    aal: 'aal1',
    session_id: 'session-1',
  })
  return `${header}.${payload}.${label}`
}

const user = {
  id: USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'user@example.com',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
  factors: [],
  created_at: '2026-11-02T11:18:29Z',
}

function sessionCookie(expiresInSeconds: number, refreshToken = 'r0'): string {
  const expiresAt = Math.floor(NOW.getTime() / 1000) + expiresInSeconds
  const session = {
    access_token: accessToken(expiresAt, 'a0'),
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    user,
  }
  return `${SESSION_COOKIE}=base64-${base64url(session)}`
}

type RefreshAnswer = 'rotates' | 'rate_limited' | 'refused' | 'unreachable'
type UserAnswer = 'known' | 'server_error' | 'session_gone'

const auth = {
  userCalls: 0,
  refreshCalls: 0,
  refresh: 'rotates' as RefreshAnswer,
  user: 'known' as UserAnswer,
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Supabase as the proxy sees it: Auth counts its calls, PostgREST answers one company. */
async function supabase(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.pathname === '/auth/v1/user') {
    auth.userCalls++
    if (auth.user === 'server_error') return json(502, { code: 502, msg: 'Bad Gateway' })
    if (auth.user === 'session_gone') {
      return json(403, { code: 403, error_code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' })
    }
    return json(200, user)
  }
  if (url.pathname === '/auth/v1/token') {
    auth.refreshCalls++
    if (auth.refresh === 'unreachable') {
      // auth-js retries an unreachable service with backoff for 30 s; let the
      // clock say that time is up, so the test does not sit through it.
      vi.advanceTimersByTime(31_000)
      throw new TypeError('fetch failed')
    }
    if (auth.refresh === 'rate_limited') {
      return json(429, { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' })
    }
    if (auth.refresh === 'refused') {
      return json(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' })
    }
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    return json(200, {
      access_token: accessToken(expiresAt, 'a1'),
      refresh_token: 'r1',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: expiresAt,
      user,
    })
  }
  if (url.pathname === '/auth/v1/.well-known/jwks.json') return json(200, { keys: [] })
  if (url.pathname === '/rest/v1/rpc/resolve_active_company') {
    return json(200, [{ company_id: 'company-1', locale: 'sv', used_fallback: false }])
  }
  return json(200, [])
}

async function send(path: string, cookie: string) {
  const { updateSession } = await import('../middleware')
  return updateSession(
    new NextRequest(`http://localhost${path}`, { headers: { cookie, 'x-forwarded-for': '92.33.157.175' } }),
  )
}

/** `count` requests with the same cookie, `everyMs` apart: a client that stores nothing it is sent. */
async function replay(path: string, cookie: string, count: number, everyMs: number) {
  const responses = []
  for (let i = 0; i < count; i++) {
    responses.push(await send(path, cookie))
    vi.advanceTimersByTime(everyMs)
  }
  return responses
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie().filter((cookie) => cookie.startsWith(SESSION_COOKIE))
}

function clearsSession(response: Response): boolean {
  return setCookies(response).some((cookie) => /^[^=]+=;/.test(cookie) || /max-age=0/i.test(cookie))
}

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SESSION_TIMEOUT_SECRET', 'a-test-secret-of-at-least-thirty-two-chars')
  vi.stubGlobal('fetch', supabase)
  // The real client builds a Realtime client, which needs a WebSocket
  // constructor; CI runs Node 20, which has none. The proxy never opens a
  // channel, so a stand-in is enough on every Node version.
  vi.stubGlobal('WebSocket', class {})
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  auth.userCalls = 0
  auth.refreshCalls = 0
  auth.refresh = 'rotates'
  auth.user = 'known'
  const { resetAuthCallBudgetForTests } = await import('../auth-call-budget')
  resetAuthCallBudgetForTests()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('a request repeated by a client that stores nothing', () => {
  it('costs one /user check per 3 seconds, not one per request', async () => {
    // 9 requests a second for 12 seconds, the pace of 2026-11-11.
    const responses = await replay('/import', sessionCookie(3000), 108, 111)

    expect(responses.every((response) => response.status === 200)).toBe(true)
    expect(auth.refreshCalls).toBe(0)
    // 12 s / 3 s, plus the first: before the budget this was 108, or more.
    expect(auth.userCalls).toBeLessThanOrEqual(5)
  })

  it('costs one /user check when the requests arrive at once', async () => {
    await replay('/import', sessionCookie(3000), 100, 0)
    expect(auth.userCalls).toBe(1)
  })

  it('costs one refresh in the refresh window, and every answer carries the new session', async () => {
    // 30 s of life left: inside the 90 s window where every request refreshes.
    const responses = await replay('/import', sessionCookie(30), 100, 30)

    expect(auth.refreshCalls).toBe(1)
    expect(responses.every((response) => response.status === 200)).toBe(true)
    expect(responses.every((response) => setCookies(response).length > 0 && !clearsSession(response))).toBe(true)
  })

  it('costs one refresh per 10 seconds for as long as it keeps replaying the old token', async () => {
    await replay('/import', sessionCookie(80), 108, 222)
    // 24 s at one refresh per 10 s, plus the first: before the budget this was 108.
    expect(auth.refreshCalls).toBeLessThanOrEqual(3)
  })
})

describe('a refresh the auth service rate limits', () => {
  it('leaves a still-valid session signed in and is not asked again per request', async () => {
    auth.refresh = 'rate_limited'
    const responses = await replay('/import', sessionCookie(30), 100, 30)

    expect(auth.refreshCalls).toBe(1)
    expect(responses.every((response) => response.status === 200)).toBe(true)
    expect(responses.some(clearsSession)).toBe(false)
  })

  it('answers an expired session with "try again", never with /login or cleared cookies', async () => {
    auth.refresh = 'rate_limited'
    const responses = await replay('/import', sessionCookie(-60), 100, 30)

    expect(auth.refreshCalls).toBe(1)
    for (const response of responses) {
      expect(response.status).toBe(503)
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('retry-after')).toBe('10')
      expect(setCookies(response)).toEqual([])
    }
    const page = await responses[0].text()
    expect(page).toContain('Du är fortfarande inloggad')
    expect(page).toContain('http-equiv="refresh" content="10"')
  })

  it('answers the API with a 503 the browser does not read as signed out', async () => {
    auth.refresh = 'rate_limited'
    const response = await send('/api/auth/session-token', sessionCookie(-60))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('10')
    expect(setCookies(response)).toEqual([])
    const body = await response.json()
    expect(body.error.code).toBe('AUTH_UNAVAILABLE')
    expect(body.error.message).toContain('Försök igen')
  })

  it('still lets the user sign in or out', async () => {
    auth.refresh = 'rate_limited'
    for (const path of ['/api/auth/login', '/api/auth/logout', '/login']) {
      const response = await send(path, sessionCookie(-60))
      expect(response.status).toBe(200)
      expect(clearsSession(response)).toBe(false)
    }
  })
})

describe('an auth service that cannot be reached', () => {
  it('does not sign the user out either', async () => {
    auth.refresh = 'unreachable'
    const response = await send('/import', sessionCookie(-60))

    expect(response.status).toBe(503)
    expect(response.headers.get('location')).toBeNull()
    expect(setCookies(response)).toEqual([])
  })

  it('hands the browser a refresh that did succeed, on the page and on the API', async () => {
    // The refresh rotates the tokens, then the /user check fails: without
    // the new tokens the browser would replay a refresh token that is spent.
    auth.user = 'server_error'
    for (const path of ['/import', '/api/auth/session-token']) {
      const response = await send(path, sessionCookie(-60))

      expect(response.status).toBe(503)
      expect(setCookies(response).length).toBeGreaterThan(0)
      expect(clearsSession(response)).toBe(false)
    }
  })
})

describe('a session the auth service says is gone', () => {
  it('ends, also when the refresh before that answer was rate limited', async () => {
    auth.refresh = 'rate_limited'
    auth.user = 'session_gone'
    const response = await send('/import', sessionCookie(30))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost/login?next=%2Fimport')
    expect(clearsSession(response)).toBe(true)
  })
})

describe('a refresh token the auth service refuses', () => {
  it('still ends the session: cookies cleared, bounce to /login with the way back', async () => {
    auth.refresh = 'refused'
    const response = await send('/import?mode=sie', sessionCookie(-60, 'dead'))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost/login?next=%2Fimport%3Fmode%3Dsie')
    expect(clearsSession(response)).toBe(true)
  })

  it('is asked about once, however often the dead cookie is replayed', async () => {
    auth.refresh = 'refused'
    await replay('/import', sessionCookie(-60, 'dead'), 100, 30)
    expect(auth.refreshCalls).toBe(1)
  })
})
