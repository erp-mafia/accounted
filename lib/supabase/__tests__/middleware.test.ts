import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Middleware redirect-destination tests.
 *
 * Focus: every auth bounce must (a) remember where the user was heading,
 * (b) reject an off-origin destination, and (c) not leak the original query
 * string onto the auth page. MFA enforcement conditions must be unchanged.
 */

const state = vi.hoisted(() => ({
  user: null as null | { id: string; app_metadata?: Record<string, unknown> },
  sessionId: 'session-1' as string | null,
  authError: null as unknown,
  aal: null as null | { currentLevel: string; nextLevel: string },
  factors: null as null | { totp: Array<{ id: string; status: string }> },
  company: {
    data: [{ company_id: 'company-1', locale: 'sv', used_fallback: false }],
    error: null as unknown,
  } as {
    data: Array<{
      company_id: string | null
      locale: string | null
      used_fallback: boolean
    }>
    error: unknown
  },
  signOut: vi.fn(async () => ({ error: null })),
  // Row returned for user_preferences reads (the auto_logout mint lookup).
  userPreferences: null as null | { auto_logout: boolean },
  userPreferencesError: null as unknown,
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: state.user },
        error: state.authError,
      })),
      getClaims: vi.fn(async () => ({
        data: { claims: state.sessionId ? { session_id: state.sessionId } : {} },
      })),
      signOut: state.signOut,
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: state.aal })),
        listFactors: vi.fn(async () => ({ data: state.factors })),
      },
    },
    rpc: vi.fn(async () => state.company),
    from: vi.fn((table: string) => {
      const chain: Record<string, unknown> = {}
      const self = new Proxy(chain, {
        get: (_t, prop) => {
          if (prop === 'then') return undefined
          if (prop === 'maybeSingle' || prop === 'single') {
            return async () => ({
              data:
                table === 'user_preferences' && !state.userPreferencesError
                  ? state.userPreferences
                  : null,
              error:
                table === 'user_preferences' ? state.userPreferencesError : null,
            })
          }
          return () => self
        },
      })
      return self
    }),
  })),
}))

const logState = vi.hoisted(() => ({ info: vi.fn() }))

vi.mock('@/lib/logger', () => {
  const logger = {
    info: (...args: unknown[]) => logState.info(...args),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  }
  return { createLogger: () => logger }
})

import { updateSession } from '../middleware'
import {
  createSessionTimeoutState,
  signSessionTimeoutState,
  verifySessionTimeoutState,
} from '@/lib/auth/session-timeout'
import { SESSION_TIMEOUT_COOKIE } from '@/lib/auth/session-timeout-shared'

const ORIGIN = 'http://localhost:3000'
const SIGNED_IN = { id: 'user-1', app_metadata: {} }

function locationOf(response: Response) {
  return response.headers.get('location')
}

function run(path: string, init?: RequestInit) {
  return updateSession(new NextRequest(`${ORIGIN}${path}`, init))
}

describe('updateSession redirect destinations', () => {
  const envBackup = {
    require: process.env.NEXT_PUBLIC_REQUIRE_MFA,
    selfHosted: process.env.NEXT_PUBLIC_SELF_HOSTED,
    signingSecret: process.env.SESSION_TIMEOUT_SECRET,
    idleTimeout: process.env.NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MS,
    absoluteTimeout: process.env.NEXT_PUBLIC_SESSION_ABSOLUTE_TIMEOUT_MS,
    warning: process.env.NEXT_PUBLIC_SESSION_WARNING_MS,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    logState.info.mockClear()
    state.user = null
    state.sessionId = 'session-1'
    state.authError = null
    state.aal = null
    state.factors = null
    state.company = {
      data: [{ company_id: 'company-1', locale: 'sv', used_fallback: false }],
      error: null,
    }
    state.userPreferences = null
    state.userPreferencesError = null
    delete process.env.NEXT_PUBLIC_REQUIRE_MFA
    delete process.env.NEXT_PUBLIC_SELF_HOSTED
    process.env.SESSION_TIMEOUT_SECRET = 'middleware-test-secret'
    delete process.env.NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MS
    delete process.env.NEXT_PUBLIC_SESSION_ABSOLUTE_TIMEOUT_MS
    delete process.env.NEXT_PUBLIC_SESSION_WARNING_MS
  })

  afterEach(() => {
    if (envBackup.require === undefined) delete process.env.NEXT_PUBLIC_REQUIRE_MFA
    else process.env.NEXT_PUBLIC_REQUIRE_MFA = envBackup.require
    if (envBackup.selfHosted === undefined) delete process.env.NEXT_PUBLIC_SELF_HOSTED
    else process.env.NEXT_PUBLIC_SELF_HOSTED = envBackup.selfHosted
    if (envBackup.signingSecret === undefined) delete process.env.SESSION_TIMEOUT_SECRET
    else process.env.SESSION_TIMEOUT_SECRET = envBackup.signingSecret
    if (envBackup.idleTimeout === undefined) delete process.env.NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MS
    else process.env.NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MS = envBackup.idleTimeout
    if (envBackup.absoluteTimeout === undefined) delete process.env.NEXT_PUBLIC_SESSION_ABSOLUTE_TIMEOUT_MS
    else process.env.NEXT_PUBLIC_SESSION_ABSOLUTE_TIMEOUT_MS = envBackup.absoluteTimeout
    if (envBackup.warning === undefined) delete process.env.NEXT_PUBLIC_SESSION_WARNING_MS
    else process.env.NEXT_PUBLIC_SESSION_WARNING_MS = envBackup.warning
  })

  describe('session timeout enforcement', () => {
    beforeEach(() => {
      state.user = SIGNED_IN
      process.env.NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MS = '30000'
      process.env.NEXT_PUBLIC_SESSION_ABSOLUTE_TIMEOUT_MS = '60000'
      process.env.NEXT_PUBLIC_SESSION_WARNING_MS = '10000'
    })

    async function signedCookie(args?: {
      startedAt?: number
      lastActivityAt?: number
      method?: 'password' | 'bankid'
      userId?: string
      sessionId?: string | null
      autoLogout?: boolean
      legacy?: boolean
    }) {
      const stateValue = {
        ...createSessionTimeoutState({
          userId: args?.userId ?? 'user-1',
          sessionId: args?.sessionId === undefined ? 'session-1' : args.sessionId,
          method: args?.method ?? 'password',
          // Default the opt-in to true: these tests exercise enforcement.
          autoLogout: args?.autoLogout ?? true,
          now: args?.startedAt ?? Date.now(),
        }),
        ...(args?.lastActivityAt === undefined
          ? {}
          : { lastActivityAt: args.lastActivityAt }),
      }
      if (args?.legacy) {
        // Pre-toggle cookies carry no auto_logout snapshot.
        delete (stateValue as { autoLogout?: boolean }).autoLogout
      }
      const signed = await signSessionTimeoutState(stateValue)
      if (!signed) throw new Error('test signing secret missing')
      return signed
    }

    it('initializes a signed, session-bound cookie for an existing session', async () => {
      const response = await run('/settings/tax', {
        headers: { cookie: 'gnubok-auth-method=bankid' },
      })

      expect(response.status).toBe(200)
      const encoded = response.cookies.get(SESSION_TIMEOUT_COOKIE)?.value
      expect(encoded).toBeTruthy()
      await expect(verifySessionTimeoutState(encoded)).resolves.toMatchObject({
        userId: 'user-1',
        sessionId: 'session-1',
        method: 'bankid',
      })
      expect(response.cookies.get('gnubok-auth-method')?.value).toBe('')
    })

    it('rejects a tampered cookie and revokes only the current session', async () => {
      const response = await run('/settings/tax', {
        headers: { cookie: `${SESSION_TIMEOUT_COOKIE}=tampered.value` },
      })

      expect(response.status).toBe(307)
      expect(new URL(locationOf(response)!).searchParams.get('reason')).toBe('absolute')
      expect(state.signOut).toHaveBeenCalledWith({ scope: 'local' })
      expect(response.cookies.get(SESSION_TIMEOUT_COOKIE)?.value).toBe('')
    })

    it('redirects an idle session with its original method and deep link', async () => {
      const now = Date.now()
      const encoded = await signedCookie({
        startedAt: now - 40_000,
        lastActivityAt: now - 30_000,
        method: 'bankid',
      })

      const response = await run('/reports/vat?period=2026-01', {
        headers: { cookie: `${SESSION_TIMEOUT_COOKIE}=${encoded}` },
      })

      const url = new URL(locationOf(response)!)
      expect(url.pathname).toBe('/login')
      expect(url.searchParams.get('reason')).toBe('idle')
      expect(url.searchParams.get('method')).toBe('bankid')
      expect(url.searchParams.get('next')).toBe('/reports/vat?period=2026-01')
      expect(state.signOut).toHaveBeenCalledWith({ scope: 'local' })
    })

    it('gives absolute expiry precedence and returns structured API errors', async () => {
      const now = Date.now()
      const encoded = await signedCookie({
        startedAt: now - 60_000,
        lastActivityAt: now - 30_000,
      })

      const response = await run('/api/invoices', {
        headers: { cookie: `${SESSION_TIMEOUT_COOKIE}=${encoded}` },
      })

      expect(response.status).toBe(401)
      expect(response.headers.get('x-session-timeout-reason')).toBe('absolute')
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'SESSION_EXPIRED', reason: 'absolute' },
      })
    })

    it('does not let a forged Authorization header bypass normal APIs', async () => {
      const now = Date.now()
      const encoded = await signedCookie({ lastActivityAt: now - 30_000, startedAt: now - 40_000 })
      const headers = {
        authorization: 'Bearer forged',
        cookie: `${SESSION_TIMEOUT_COOKIE}=${encoded}`,
      }

      expect((await run('/api/invoices', { headers })).status).toBe(401)
      expect((await run('/api/v1/companies/c1/invoices', { headers })).status).toBe(200)
    })

    it('mints the cookie with the auto_logout opt-out default for new sessions', async () => {
      const response = await run('/settings/tax')

      expect(response.status).toBe(200)
      const encoded = response.cookies.get(SESSION_TIMEOUT_COOKIE)?.value
      await expect(verifySessionTimeoutState(encoded)).resolves.toMatchObject({
        autoLogout: false,
      })
    })

    it('snapshots an opted-in preference at mint time', async () => {
      state.userPreferences = { auto_logout: true }

      const response = await run('/settings/tax')

      const encoded = response.cookies.get(SESSION_TIMEOUT_COOKIE)?.value
      await expect(verifySessionTimeoutState(encoded)).resolves.toMatchObject({
        autoLogout: true,
      })
    })

    it('persists no snapshot when the preference read fails', async () => {
      state.userPreferencesError = { message: 'connection reset' }
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const response = await run('/settings/tax')

      // Unknown preference: nothing minted, nobody logged out; the next
      // request retries the read.
      expect(response.status).toBe(200)
      expect(response.cookies.get(SESSION_TIMEOUT_COOKIE)).toBeUndefined()
      expect(state.signOut).not.toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    it('never logs out a session that has not opted in', async () => {
      const now = Date.now()
      // Far past both limits: without the opt-in the session must survive.
      const encoded = await signedCookie({
        startedAt: now - 600_000,
        lastActivityAt: now - 600_000,
        autoLogout: false,
      })

      const response = await run('/reports/vat', {
        headers: { cookie: `${SESSION_TIMEOUT_COOKIE}=${encoded}` },
      })

      expect(response.status).toBe(200)
      expect(state.signOut).not.toHaveBeenCalled()
    })

    it('upgrades a pre-toggle cookie in place instead of treating it as forged', async () => {
      state.userPreferences = { auto_logout: true }
      const startedAt = Date.now() - 5_000
      const encoded = await signedCookie({ startedAt, legacy: true })

      const response = await run('/settings/tax', {
        headers: { cookie: `${SESSION_TIMEOUT_COOKIE}=${encoded}` },
      })

      expect(response.status).toBe(200)
      expect(state.signOut).not.toHaveBeenCalled()
      const upgraded = response.cookies.get(SESSION_TIMEOUT_COOKIE)?.value
      // Timers survive the upgrade: only the opt-in snapshot is added.
      await expect(verifySessionTimeoutState(upgraded)).resolves.toMatchObject({
        startedAt,
        autoLogout: true,
      })
    })

    it('starts a new timeout window when the Supabase session changes', async () => {
      const encoded = await signedCookie({ sessionId: 'old-session' })

      const response = await run('/settings/tax', {
        headers: { cookie: `${SESSION_TIMEOUT_COOKIE}=${encoded}` },
      })

      expect(response.status).toBe(200)
      const renewed = response.cookies.get(SESSION_TIMEOUT_COOKIE)?.value
      await expect(verifySessionTimeoutState(renewed)).resolves.toMatchObject({
        sessionId: 'session-1',
      })
      expect(state.signOut).not.toHaveBeenCalled()
    })
  })

  // ── Public agent-discovery + docs surfaces ────────────────────────────

  describe('anonymous access to agent-discovery and docs surfaces', () => {
    it.each(['/llms.txt', '/llms-full.txt', '/docs/api', '/docs/api.md', '/docs/api/reference.md', '/docs/api/cookbook/quickstart.md'])(
      'serves %s without a login bounce',
      async (path) => {
        const response = await run(path)
        expect(response.status).not.toBe(307)
        expect(locationOf(response)).toBeNull()
      },
    )

    it('does not treat a /docs prefix on another route as public', async () => {
      // /docsy-dashboard must still bounce: only /docs and /docs/* are public.
      const response = await run('/docsy-dashboard')
      expect(response.status).toBe(307)
      expect(new URL(locationOf(response)!).pathname).toBe('/login')
    })

    it('serves docs to a signed-in user without redirecting away', async () => {
      state.user = SIGNED_IN
      const response = await run('/docs/api')
      expect(response.status).not.toBe(307)
    })
  })

  // ── Site 1: protected-route bounce ────────────────────────────────────

  describe('protected route bounce to /login', () => {
    it('preserves the deep link the anonymous user was heading for', async () => {
      const response = await run('/settings/tax')

      expect(response.status).toBe(307)
      const url = new URL(locationOf(response)!)
      expect(url.pathname).toBe('/login')
      expect(url.searchParams.get('next')).toBe('/settings/tax')
    })

    it('does not leak the original query string onto /login', async () => {
      // The Stripe Checkout return: /settings/billing?success=1. Overwriting
      // only the pathname used to carry ?success=1 onto /login.
      const response = await run('/settings/billing?success=1')

      const url = new URL(locationOf(response)!)
      expect(url.pathname).toBe('/login')
      expect(url.searchParams.get('success')).toBeNull()
      expect([...url.searchParams.keys()]).toEqual(['next'])
      expect(url.searchParams.get('next')).toBe('/settings/billing?success=1')
    })

    it('keeps ?org_number= on a logged-out /onboarding link', async () => {
      const response = await run('/onboarding?org_number=5566778899')

      const url = new URL(locationOf(response)!)
      expect(url.pathname).toBe('/login')
      expect(url.searchParams.get('next')).toBe('/onboarding?org_number=5566778899')
    })

    it('sends no destination parameter when the target is the dashboard root', async () => {
      const response = await run('/')

      expect(locationOf(response)).toBe(`${ORIGIN}/login`)
    })

    it('drops a request path that normalises to a protocol-relative URL', async () => {
      // /..//evil.com normalises to the pathname //evil.com. Reflecting that
      // back as ?next= would hand the login page an off-origin destination.
      const response = await run('/..//evil.com')

      const url = new URL(locationOf(response)!)
      expect(url.pathname).toBe('/login')
      expect(url.searchParams.get('next')).toBeNull()
    })
  })

  // ── Site 4: authenticated user on an auth page ────────────────────────

  describe('authenticated user landing on /login or /register', () => {
    beforeEach(() => {
      state.user = SIGNED_IN
    })

    it('honours ?next= instead of discarding the query string', async () => {
      const response = await run('/login?next=%2Fsettings%2Ftax')

      expect(locationOf(response)).toBe(`${ORIGIN}/settings/tax`)
    })

    it('honours ?next= on /register too', async () => {
      const response = await run('/register?next=%2Fsettings%2Ftax')

      expect(locationOf(response)).toBe(`${ORIGIN}/settings/tax`)
    })

    it('falls back to the dashboard when there is no destination', async () => {
      const response = await run('/login')

      expect(locationOf(response)).toBe(`${ORIGIN}/`)
    })

    it('rejects an absolute URL as the destination', async () => {
      const response = await run('/login?next=https%3A%2F%2Fevil.com%2Fx')

      expect(locationOf(response)).toBe(`${ORIGIN}/`)
    })

    it('rejects a protocol-relative destination', async () => {
      const response = await run('/login?next=%2F%2Fevil.com')

      expect(locationOf(response)).toBe(`${ORIGIN}/`)
    })

    it('rejects an encoded traversal that normalises off-origin', async () => {
      // /..//evil.com and /%2e%2e//evil.com both normalise to //evil.com.
      for (const hostile of ['%2F..%2F%2Fevil.com', '%2F%252e%252e%2F%2Fevil.com']) {
        const response = await run(`/login?next=${hostile}`)
        expect(locationOf(response)).toBe(`${ORIGIN}/`)
      }
    })

    it('still bounces /auth and /sandbox to the dashboard, query and all', async () => {
      expect(locationOf(await run('/sandbox?next=%2Fsettings%2Ftax'))).toBe(`${ORIGIN}/`)
      expect(locationOf(await run('/auth/callback?next=%2Fsettings%2Ftax'))).toBe(`${ORIGIN}/`)
    })
  })

  // ── Sites 2 and 3: MFA step-up and forced enrollment ──────────────────

  describe('MFA step-up bounce to /mfa/verify', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_REQUIRE_MFA = 'true'
      state.user = SIGNED_IN
      state.aal = { currentLevel: 'aal1', nextLevel: 'aal2' }
    })

    it('preserves the destination as ?returnTo=', async () => {
      const response = await run('/reports/vat?period=2026-01')

      const url = new URL(locationOf(response)!)
      expect(url.pathname).toBe('/mfa/verify')
      expect(url.searchParams.get('returnTo')).toBe('/reports/vat?period=2026-01')
      expect([...url.searchParams.keys()]).toEqual(['returnTo'])
    })

    it('still fires the step-up when the request carries its own returnTo', async () => {
      // A crafted ?returnTo= must never be mistaken for a completed step-up.
      const response = await run('/settings/tax?returnTo=%2Fanywhere')

      expect(new URL(locationOf(response)!).pathname).toBe('/mfa/verify')
    })

    it('does not reflect a request path that normalises off-origin', async () => {
      const response = await run('/..//evil.com')

      const url = new URL(locationOf(response)!)
      expect(url.pathname).toBe('/mfa/verify')
      expect(url.searchParams.get('returnTo')).toBeNull()
    })
  })

  describe('forced enrollment bounce to /mfa/enroll', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_REQUIRE_MFA = 'true'
      state.user = SIGNED_IN
      state.aal = { currentLevel: 'aal1', nextLevel: 'aal1' }
      state.factors = { totp: [] }
    })

    it('preserves the destination as ?returnTo=', async () => {
      const response = await run('/invoices/new')

      const url = new URL(locationOf(response)!)
      expect(url.pathname).toBe('/mfa/enroll')
      expect(url.searchParams.get('returnTo')).toBe('/invoices/new')
    })

    it('still forces enrollment (the gate itself is unchanged)', async () => {
      state.factors = { totp: [{ id: 'f1', status: 'verified' }] }

      const response = await run('/invoices/new')

      expect(response.status).toBe(200)
    })

    it('skips enrollment for a user with no company, as before', async () => {
      state.company = { data: [{ company_id: null, locale: null, used_fallback: false }], error: null }

      const response = await run('/select-company')

      expect(response.status).toBe(200)
    })
  })

  // ── MFA semantics that must not change ────────────────────────────────

  describe('per-request timing header and log line', () => {
    const TIMING_RE =
      /^mw-auth;dur=\d+, mw-session;dur=\d+, mw-company;dur=\d+, mw-mfa;dur=\d+, mw-total;dur=\d+$/

    function lastLog() {
      expect(logState.info).toHaveBeenCalledTimes(1)
      const [msg, ctx] = logState.info.mock.calls[0] as [string, Record<string, unknown>]
      expect(msg).toBe('proxy completed')
      return ctx
    }

    it('page responses carry Server-Timing and log kind=page with the route', async () => {
      state.user = SIGNED_IN
      const res = await run('/invoices')
      expect(res.status).toBe(200)
      expect(res.headers.get('server-timing')).toMatch(TIMING_RE)
      expect(res.headers.get('x-proxy-timing')).toBeNull()
      const ctx = lastLog()
      expect(ctx.kind).toBe('page')
      expect(ctx.route).toBe('/invoices')
      expect(ctx.status).toBe(200)
      expect(typeof ctx.totalMs).toBe('number')
      expect(typeof ctx.authMs).toBe('number')
      expect(typeof ctx.companyMs).toBe('number')
    })

    it('classifies prefetch and RSC requests from the app-router headers', async () => {
      state.user = SIGNED_IN
      await run('/invoices', { headers: { 'next-router-prefetch': '1', rsc: '1' } })
      expect(lastLog().kind).toBe('prefetch')
      logState.info.mockClear()
      await run('/invoices', { headers: { rsc: '1' } })
      expect(lastLog().kind).toBe('rsc')
    })

    it('/api responses use X-Proxy-Timing and leave Server-Timing to the route wrapper', async () => {
      state.user = SIGNED_IN
      const res = await run('/api/settings')
      expect(res.headers.get('x-proxy-timing')).toMatch(TIMING_RE)
      expect(res.headers.get('server-timing')).toBeNull()
      expect(lastLog().kind).toBe('api')
    })

    it('redirect responses also carry the header and log their status', async () => {
      const res = await run('/invoices')
      expect(res.status).toBe(307)
      expect(res.headers.get('server-timing')).toMatch(TIMING_RE)
      expect(lastLog().status).toBe(307)
    })

    it('never logs a token-carrying path or a raw entity id', async () => {
      const res = await run('/invite/9f8e7d6c5b4a3928171605f4e3d2c1b0')
      expect(res.status).toBe(200)
      expect(lastLog().route).toBe('/invite/*')
      logState.info.mockClear()
      state.user = SIGNED_IN
      await run('/invoices/6f1c2a3e-1234-4bcd-9abc-0123456789ab')
      expect(lastLog().route).toBe('/invoices/:id')
    })
  })

  describe('MFA-disabled and self-hosted paths are unchanged', () => {
    it('does not redirect when NEXT_PUBLIC_REQUIRE_MFA is unset', async () => {
      state.user = SIGNED_IN
      state.aal = { currentLevel: 'aal1', nextLevel: 'aal2' }

      const response = await run('/settings/tax')

      expect(response.status).toBe(200)
    })

    it('does not redirect on self-hosted even with MFA required', async () => {
      process.env.NEXT_PUBLIC_REQUIRE_MFA = 'true'
      process.env.NEXT_PUBLIC_SELF_HOSTED = 'true'
      state.user = SIGNED_IN
      state.aal = { currentLevel: 'aal1', nextLevel: 'aal2' }
      state.factors = { totp: [] }

      const response = await run('/settings/tax')

      expect(response.status).toBe(200)
    })

    it('does not redirect BankID-linked users, who are already 2FA', async () => {
      process.env.NEXT_PUBLIC_REQUIRE_MFA = 'true'
      state.user = { id: 'user-1', app_metadata: { bankid_linked: true } }
      state.aal = { currentLevel: 'aal1', nextLevel: 'aal2' }

      const response = await run('/settings/tax')

      expect(response.status).toBe(200)
    })
  })
})
