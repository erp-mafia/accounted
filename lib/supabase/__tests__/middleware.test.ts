import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Middleware redirect-destination tests.
 *
 * Focus: every auth bounce must (a) remember where the user was heading,
 * (b) reject an off-origin destination, and (c) not leak the original query
 * string onto the auth page. MFA enforcement decides on server-authenticated
 * data only (the getUser() factor list and the signature-verified `aal`
 * claim), never on the editable cookie session.
 */

const state = vi.hoisted(() => ({
  user: null as null | {
    id: string
    email?: string
    app_metadata?: Record<string, unknown>
    // What GoTrue returns on /user: the server-side factor list.
    factors?: Array<{ id: string; status: string; factor_type: string }>
  },
  sessionId: 'session-1' as string | null,
  authError: null as unknown,
  // `aal` claim of the (mock) signature-verified access token, i.e. what
  // getClaims() reports. null = the token carries no aal claim.
  jwtAal: null as string | null,
  // Make getClaims() fail: an error result or a throw.
  claimsFailure: null as null | 'error' | 'throw',
  // The cookie-derived assurance lookup and the listFactors round trip. The
  // proxy must call NEITHER any more: the first computes nextLevel from the
  // editable cookie session, the second is a getUser() the proxy has already
  // paid for. Spies so tests can prove it. getAal answers the way a cookie
  // with `user.factors` stripped would: "nothing to step up to".
  getAal: vi.fn(async () => ({
    data: { currentLevel: 'aal1', nextLevel: 'aal1' },
    error: null,
  })),
  listFactors: vi.fn(async () => ({ data: { totp: [] }, error: null })),
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
  // Rows the team_members query resolves to (the byrå exception in the
  // no-company branch and the home-domain guard both await eq-terminated
  // chains, so the from() mock makes exactly that table thenable).
  byraMemberships: [] as Array<{
    role?: string
    teams: { kind: string; brands?: { domain: string } | Array<{ domain: string }> | null }
  }>,
  // Rows any awaited company_members filter chain resolves to: the Rule 2
  // home-domain client lookup AND the Rule 1 canonical personal-company
  // exemption both land here (each scenario exercises only one of them).
  clientMemberships: [] as Array<Record<string, unknown>>,
  clientMembershipsError: null as unknown,
  // What the mocked resolveBrandByHost returns for the request host.
  hostBrand: null as null | { teamId: string; id?: string },
  // What the mocked isEmailOnBrandAllowlist returns (Rule 2 exemption).
  allowlisted: false,
  signOut: vi.fn(async () => ({ error: null })),
  // Cookies auth-js writes through the `cookies.setAll` callback while
  // getUser() runs: the ROTATED tokens after a successful refresh, and the
  // maxAge-0 deletions when it removes a dead session. The middleware has to
  // carry these onto whatever response it returns.
  cookieWrites: [] as Array<{
    name: string
    value: string
    options?: Record<string, unknown>
  }>,
  // Row returned for user_preferences reads (the auto_logout mint lookup).
  userPreferences: null as null | { auto_logout: boolean },
  userPreferencesError: null as unknown,
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn((
    _url: string,
    _key: string,
    options: {
      cookies: {
        setAll: (
          cookies: Array<{
            name: string
            value: string
            options?: Record<string, unknown>
          }>,
        ) => void
      }
    },
  ) => ({
    auth: {
      getUser: vi.fn(async () => {
        if (state.cookieWrites.length > 0) options.cookies.setAll(state.cookieWrites)
        return {
          data: { user: state.user },
          error: state.authError,
        }
      }),
      getClaims: vi.fn(async () => {
        if (state.claimsFailure === 'throw') throw new Error('jwks fetch failed')
        if (state.claimsFailure === 'error') {
          return {
            data: null,
            error: { name: 'AuthInvalidJwtError', message: 'Invalid JWT signature' },
          }
        }
        return {
          data: {
            claims: {
              ...(state.sessionId ? { session_id: state.sessionId } : {}),
              ...(state.jwtAal ? { aal: state.jwtAal } : {}),
              // Satisfy the iss/aud pinning the MFA gates apply (lib/auth/claims.ts).
              iss: `${(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '')}/auth/v1`,
              aud: 'authenticated',
              sub: state.user?.id,
            },
          },
          error: null,
        }
      }),
      signOut: state.signOut,
      mfa: {
        getAuthenticatorAssuranceLevel: () => state.getAal(),
        listFactors: () => state.listFactors(),
      },
    },
    rpc: vi.fn(async () => state.company),
    from: vi.fn((table: string) => {
      const chain: Record<string, unknown> = {}
      const self = new Proxy(chain, {
        get: (_t, prop) => {
          if (prop === 'then') {
            // The byrå-membership lookup and the home-domain client lookup
            // await their filter chains directly (no .maybeSingle terminal),
            // so those tables must be thenable.
            if (table === 'team_members') {
              return (resolve: (v: unknown) => void) =>
                resolve({ data: state.byraMemberships, error: null })
            }
            if (table === 'company_members') {
              return (resolve: (v: unknown) => void) =>
                resolve({
                  data: state.clientMembershipsError ? null : state.clientMemberships,
                  error: state.clientMembershipsError,
                })
            }
            return undefined
          }
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

vi.mock('@/lib/branding/resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/branding/resolve')>()),
  resolveBrandByHost: vi.fn(async () =>
    state.hostBrand
      ? { id: state.hostBrand.id ?? 'brand-host', teamId: state.hostBrand.teamId }
      : null,
  ),
}))

vi.mock('@/lib/auth/brand-signup-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/brand-signup-gate')>()),
  isEmailOnBrandAllowlist: vi.fn(async () => state.allowlisted),
}))

import { updateSession } from '../middleware'
import {
  createSessionTimeoutState,
  signSessionTimeoutState,
  verifySessionTimeoutState,
} from '@/lib/auth/session-timeout'
import { SESSION_TIMEOUT_COOKIE } from '@/lib/auth/session-timeout-shared'

const ORIGIN = 'http://localhost:3000'
const SIGNED_IN = { id: 'user-1', app_metadata: {} }
const VERIFIED_TOTP = { id: 'f1', status: 'verified', factor_type: 'totp' }
/** A user whose server-side record carries a verified TOTP factor. */
const MFA_USER = { ...SIGNED_IN, factors: [VERIFIED_TOTP] }

function locationOf(response: Response) {
  return response.headers.get('location')
}

function run(path: string, init?: RequestInit) {
  return updateSession(new NextRequest(`${ORIGIN}${path}`, init))
}

function runAt(origin: string, path: string, headers?: Record<string, string>) {
  return updateSession(new NextRequest(`${origin}${path}`, { headers }))
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
    state.listFactors.mockClear()
    state.getAal.mockClear()
    state.user = null
    state.sessionId = 'session-1'
    state.authError = null
    state.cookieWrites = []
    state.jwtAal = null
    state.claimsFailure = null
    state.company = {
      data: [{ company_id: 'company-1', locale: 'sv', used_fallback: false }],
      error: null,
    }
    state.byraMemberships = []
    state.clientMemberships = []
    state.clientMembershipsError = null
    state.hostBrand = null
    state.allowlisted = false
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

    it('carries the cookies that clear a dead session', async () => {
      // auth-js removes the session inside getUser() and queues the deletion
      // on the response. Dropping it on the bounce made the browser replay
      // the dead refresh token on /login, spending a second GoTrue 400 per
      // expiry (paired 400s ~100 ms apart in production).
      state.authError = { name: 'AuthApiError', code: 'refresh_token_not_found' }
      state.cookieWrites = [
        { name: 'sb-test-auth-token', value: '', options: { path: '/', maxAge: 0 } },
      ]

      const response = await run('/settings/tax', {
        headers: {
          cookie: `sb-test-auth-token=dead; ${SESSION_TIMEOUT_COOKIE}=stale`,
        },
      })

      expect(response.status).toBe(307)
      expect(new URL(locationOf(response)!).pathname).toBe('/login')
      const cleared = response.cookies.get('sb-test-auth-token')
      expect(cleared?.value).toBe('')
      expect(cleared?.maxAge).toBe(0)
      expect(response.cookies.get(SESSION_TIMEOUT_COOKIE)?.value).toBe('')
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

    // Email-change confirmation links are usually clicked while still logged
    // in (the change starts in settings), and the completing verify mints a
    // session before the status page renders. Bouncing either request off the
    // /auth prefix silently swallowed the confirmation.
    it('lets an authenticated email-change confirmation reach the callback', async () => {
      const response = await run('/auth/callback?token_hash=abc&type=email_change')
      expect(response.status).not.toBe(307)
      expect(locationOf(response)).toBeNull()
    })

    // Stock GoTrue links (no Send Email hook) come back through redirect_to
    // with only the flow=email_change marker: ?message= after the first of
    // the two confirmations, ?code= after the completing one, ?error= for a
    // dead link. None carries type=, and the change usually starts in a
    // signed-in settings tab.
    it('lets an authenticated stock email-change redirect reach the callback', async () => {
      for (const query of [
        'flow=email_change&message=Confirmation+link+accepted',
        'flow=email_change&code=pkce',
        'flow=email_change&error=access_denied&error_code=otp_expired',
      ]) {
        const response = await run(`/auth/callback?${query}`)
        expect(response.status).not.toBe(307)
        expect(locationOf(response)).toBeNull()
      }
    })

    it('lets an authenticated user see the email-change status page', async () => {
      const response = await run('/auth/email-change?status=done')
      expect(response.status).not.toBe(307)
      expect(locationOf(response)).toBeNull()
    })

    it('still bounces other authenticated token types off the callback', async () => {
      expect(locationOf(await run('/auth/callback?token_hash=abc&type=signup'))).toBe(
        `${ORIGIN}/`,
      )
    })
  })

  // ── Sites 2 and 3: MFA step-up and forced enrollment ──────────────────

  describe('MFA step-up bounce to /mfa/verify', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_REQUIRE_MFA = 'true'
      // Verified factor on the server-side user, single-factor token.
      state.user = MFA_USER
      state.jwtAal = 'aal1'
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

    it('carries the rotated auth cookie instead of re-minting it next request', async () => {
      state.cookieWrites = [
        { name: 'sb-test-auth-token', value: 'rotated', options: { path: '/' } },
      ]

      const response = await run('/settings/tax')

      expect(new URL(locationOf(response)!).pathname).toBe('/mfa/verify')
      expect(response.cookies.get('sb-test-auth-token')?.value).toBe('rotated')
    })

    it('decides on the server-side factor list, never on the cookie session', async () => {
      // The attack: the sb-*-auth-token cookie is unsigned JSON, so the
      // password holder strips `user.factors` and the local assurance lookup
      // reports nextLevel aal1 ("nothing to step up to"). state.getAal is
      // that view; the proxy must not even ask for it.
      const response = await run('/invoices')

      expect(new URL(locationOf(response)!).pathname).toBe('/mfa/verify')
      expect(state.getAal).not.toHaveBeenCalled()
      expect(state.listFactors).not.toHaveBeenCalled()
    })

    it.each(['error', 'throw'] as const)(
      'fails closed when getClaims reports %s',
      async (failure) => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        state.claimsFailure = failure

        const response = await run('/invoices')

        expect(new URL(locationOf(response)!).pathname).toBe('/mfa/verify')
        expect(errorSpy).toHaveBeenCalled()
        errorSpy.mockRestore()
      },
    )

    it('fails closed when the verified claims carry no aal', async () => {
      state.jwtAal = null

      const response = await run('/invoices')

      expect(new URL(locationOf(response)!).pathname).toBe('/mfa/verify')
    })
  })

  describe('forced enrollment bounce to /mfa/enroll', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_REQUIRE_MFA = 'true'
      // No factor on the server-side user, single-factor token.
      state.user = SIGNED_IN
      state.jwtAal = 'aal1'
    })

    it('preserves the destination as ?returnTo=', async () => {
      const response = await run('/invoices/new')

      const url = new URL(locationOf(response)!)
      expect(url.pathname).toBe('/mfa/enroll')
      expect(url.searchParams.get('returnTo')).toBe('/invoices/new')
    })

    it('steps up instead of enrolling when the server-side user already has a verified factor', async () => {
      // Previously this scenario (cookie says no factor, server says one
      // exists, token at aal1) rendered the page at AAL1: the verify bounce
      // trusted the cookie and the enrolment check then found the factor.
      state.user = MFA_USER

      const response = await run('/invoices/new')

      expect(new URL(locationOf(response)!).pathname).toBe('/mfa/verify')
    })

    it('skips enrollment for a user with no company, as before', async () => {
      state.company = { data: [{ company_id: null, locale: null, used_fallback: false }], error: null }

      const response = await run('/select-company')

      expect(response.status).toBe(200)
    })

    it('reads the factor list off the getUser() round trip, not a second auth call', async () => {
      const response = await run('/invoices/new')

      expect(new URL(locationOf(response)!).pathname).toBe('/mfa/enroll')
      expect(state.listFactors).not.toHaveBeenCalled()
      expect(state.getAal).not.toHaveBeenCalled()
    })

    it('lets an aal2 token through even when the server-side user has no factor left', async () => {
      // A user who unenrols their last factor mid-session keeps aal2 until
      // the next token refresh; the enrolment bounce lands on the refresh,
      // not on the next click (unchanged deferral, PR #1922).
      state.jwtAal = 'aal2'

      const response = await run('/invoices/new')

      expect(response.status).toBe(200)
      expect(state.listFactors).not.toHaveBeenCalled()
    })

    it('does not spend an MFA lookup on RSC and prefetch requests at aal2 either', async () => {
      state.jwtAal = 'aal2'

      await run('/invoices', { headers: { rsc: '1' } })
      await run('/invoices', { headers: { 'next-router-prefetch': '1', rsc: '1' } })

      expect(state.listFactors).not.toHaveBeenCalled()
      expect(state.getAal).not.toHaveBeenCalled()
    })
  })

  // ── API branch: the MFA gate for cookie sessions ──────────────────────

  describe('API MFA gate for cookie sessions', () => {
    const FORBIDDEN = { error: 'MFA-verifiering krävs.' }

    beforeEach(() => {
      process.env.NEXT_PUBLIC_REQUIRE_MFA = 'true'
      state.user = MFA_USER
      state.jwtAal = 'aal1'
    })

    it('returns 403 for an AAL1 session whose server-side user has a verified factor', async () => {
      const response = await run('/api/invoices')

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual(FORBIDDEN)
    })

    it('never consults the cookie-derived assurance level or a second factor lookup', async () => {
      // state.getAal reports nextLevel aal1: the answer a cookie with
      // `user.factors` stripped produces. It must not be asked at all.
      const response = await run('/api/invoices')

      expect(response.status).toBe(403)
      expect(state.getAal).not.toHaveBeenCalled()
      expect(state.listFactors).not.toHaveBeenCalled()
    })

    it('lets an AAL2 session through', async () => {
      state.jwtAal = 'aal2'

      const response = await run('/api/invoices')

      expect(response.status).toBe(200)
    })

    it.each(['error', 'throw'] as const)(
      'fails closed when getClaims reports %s',
      async (failure) => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        state.claimsFailure = failure

        const response = await run('/api/invoices')

        expect(response.status).toBe(403)
        expect(errorSpy).toHaveBeenCalled()
        errorSpy.mockRestore()
      },
    )

    it('fails closed when the verified claims carry no aal', async () => {
      state.jwtAal = null

      const response = await run('/api/invoices')

      expect(response.status).toBe(403)
    })

    it("passes a user with nothing to step up to (enrolment stays the page gate's job)", async () => {
      state.user = SIGNED_IN

      expect((await run('/api/invoices')).status).toBe(200)

      state.user = {
        ...SIGNED_IN,
        factors: [{ id: 'f2', status: 'unverified', factor_type: 'totp' }],
      }

      expect((await run('/api/invoices')).status).toBe(200)
      expect(state.getAal).not.toHaveBeenCalled()
    })

    it('keeps the AAL1 escape hatches and the OAuth endpoints open', async () => {
      for (const path of ['/api/account/delete', '/api/company/current', '/api/mcp-oauth/token']) {
        expect((await run(path)).status).toBe(200)
      }
    })

    it('skips Bearer-auth surfaces by path, and only with the header present', async () => {
      const headers = { authorization: 'Bearer key' }

      expect((await run('/api/v1/companies/c1/invoices', { headers })).status).toBe(200)
      expect((await run('/api/extensions/ext/mcp-server/mcp', { headers })).status).toBe(200)
      // A cookie session on a v1 path without the header is still a cookie session.
      expect((await run('/api/v1/companies/c1/invoices')).status).toBe(403)
      // A forged header on a cookie-authenticated route never disables the gate.
      expect((await run('/api/invoices', { headers })).status).toBe(403)
    })

    it('does not gate BankID-linked users, nor anyone when MFA is off', async () => {
      state.user = { ...MFA_USER, app_metadata: { bankid_linked: true } }
      expect((await run('/api/invoices')).status).toBe(200)

      state.user = MFA_USER
      delete process.env.NEXT_PUBLIC_REQUIRE_MFA
      expect((await run('/api/invoices')).status).toBe(200)
    })

    it('carries the rotated auth cookie on the 403', async () => {
      state.cookieWrites = [
        { name: 'sb-test-auth-token', value: 'rotated', options: { path: '/' } },
      ]

      const response = await run('/api/invoices')

      expect(response.status).toBe(403)
      expect(response.cookies.get('sb-test-auth-token')?.value).toBe('rotated')
    })
  })

  // ── No-company branch: the byrå cockpit exception ─────────────────────

  describe('byrå team members with zero companies', () => {
    beforeEach(() => {
      state.user = SIGNED_IN
      // No resolvable company at all (fresh byrå, no client memberships).
      state.company = {
        data: [{ company_id: null, locale: 'sv', used_fallback: true }],
        error: null,
      }
    })

    it('steers a byrå owner from the dashboard root to the empty cockpit, not onboarding', async () => {
      state.byraMemberships = [{ role: 'owner', teams: { kind: 'byra' } }]

      const response = await run('/')

      expect(new URL(locationOf(response)!).pathname).toBe('/byra')
    })

    it('lets a byrå admin through to cockpit routes', async () => {
      state.byraMemberships = [{ role: 'admin', teams: { kind: 'byra' } }]

      for (const path of ['/byra', '/clients', '/companies/new-client', '/settings/brand']) {
        const response = await run(path)
        expect(response.status).toBe(200)
      }
    })

    it('steers a plain byrå member to the cockpit too (any role counts)', async () => {
      state.byraMemberships = [{ role: 'member', teams: { kind: 'byra' } }]

      const response = await run('/')

      expect(new URL(locationOf(response)!).pathname).toBe('/byra')
    })

    it('keeps the onboarding redirect for non-byrå users', async () => {
      state.byraMemberships = []

      const response = await run('/')

      expect(new URL(locationOf(response)!).pathname).toBe('/onboarding')
    })
  })

  // ── Home-domain affinity (WL): the domain corrects itself ─────────────

  describe('home-domain affinity', () => {
    const ARBORE = 'https://arbore.accounted.se'
    const ACOUNT = 'https://acount.accounted.se'

    beforeEach(() => {
      state.user = SIGNED_IN
    })

    it('redirects a byrå member on a foreign byrå domain to their own domain', async () => {
      state.byraMemberships = [
        { teams: { kind: 'byra', brands: { domain: 'acount.accounted.se' } } },
      ]

      const response = await runAt(ARBORE, '/')

      expect(locationOf(response)).toBe(`${ACOUNT}/`)
    })

    it('redirects a byrå member on the platform domain to their byrå domain', async () => {
      state.byraMemberships = [
        { teams: { kind: 'byra', brands: { domain: 'arbore.accounted.se' } } },
      ]

      const response = await runAt('https://app.gnubok.se', '/')

      expect(locationOf(response)).toBe(`${ARBORE}/`)
    })

    it('preserves path and query across the affinity redirect', async () => {
      state.byraMemberships = [
        { teams: { kind: 'byra', brands: { domain: 'arbore.accounted.se' } } },
      ]

      const response = await runAt('https://app.gnubok.se', '/invoices/abc?tab=payments')

      expect(locationOf(response)).toBe(`${ARBORE}/invoices/abc?tab=payments`)
    })

    it('lets a byrå member through on their own domain and caches the verdict', async () => {
      state.byraMemberships = [
        { teams: { kind: 'byra', brands: { domain: 'arbore.accounted.se' } } },
      ]

      const response = await runAt(ARBORE, '/byra')

      expect(response.status).toBe(200)
      expect(response.headers.get('set-cookie')).toContain(
        'gnubok-home-ok=user-1~arbore.accounted.se',
      )
    })

    it('keeps a byrå member with a brandless personal company on the canonical host', async () => {
      state.byraMemberships = [
        { teams: { kind: 'byra', brands: { domain: 'arbore.accounted.se' } } },
      ]
      // A personal company with no team at all: homed on canonical.
      state.clientMemberships = [{ companies: { team_id: null, teams: null } }]

      const response = await runAt('https://app.gnubok.se', '/')

      expect(response.status).toBe(200)
      expect(locationOf(response)).toBeNull()
      expect(response.headers.get('set-cookie')).toContain(
        'gnubok-home-ok=user-1~app.gnubok.se',
      )
    })

    it('counts a company whose team has no brand as canonical-homed too', async () => {
      state.byraMemberships = [
        { teams: { kind: 'byra', brands: { domain: 'arbore.accounted.se' } } },
      ]
      state.clientMemberships = [
        { companies: { team_id: 'team-personal', teams: { brands: null } } },
      ]

      const response = await runAt('https://app.gnubok.se', '/')

      expect(response.status).toBe(200)
      expect(response.headers.get('set-cookie')).toContain(
        'gnubok-home-ok=user-1~app.gnubok.se',
      )
    })

    it('still redirects a byrå member whose companies are all brand-homed', async () => {
      state.byraMemberships = [
        { teams: { kind: 'byra', brands: { domain: 'arbore.accounted.se' } } },
      ]
      state.clientMemberships = [
        { companies: { team_id: 'team-arbore', teams: { brands: { id: 'brand-1' } } } },
      ]

      const response = await runAt('https://app.gnubok.se', '/')

      expect(locationOf(response)).toBe(`${ARBORE}/`)
    })

    it('still redirects off a FOREIGN byrå domain even with a canonical personal company', async () => {
      state.byraMemberships = [
        { teams: { kind: 'byra', brands: { domain: 'acount.accounted.se' } } },
      ]
      state.clientMemberships = [{ companies: { team_id: null, teams: null } }]

      const response = await runAt(ARBORE, '/')

      expect(locationOf(response)).toBe(`${ACOUNT}/`)
    })

    it('stays put without caching when the canonical-company lookup fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      state.byraMemberships = [
        { teams: { kind: 'byra', brands: { domain: 'arbore.accounted.se' } } },
      ]
      state.clientMembershipsError = { message: 'connection reset' }

      const response = await runAt('https://app.gnubok.se', '/')

      // Fail open: no redirect, and no home-ok cookie so the next request
      // re-runs the check instead of freezing the error verdict for the TTL.
      expect(response.status).toBe(200)
      expect(response.headers.get('set-cookie') ?? '').not.toContain('gnubok-home-ok')
      expect(errorSpy).toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    it('tolerates the array shape for the embedded brand', async () => {
      state.byraMemberships = [
        { teams: { kind: 'byra', brands: [{ domain: 'acount.accounted.se' }] } },
      ]

      const response = await runAt(ARBORE, '/')

      expect(locationOf(response)).toBe(`${ACOUNT}/`)
    })

    it('redirects a user with no byrå ties off a brand domain to the platform', async () => {
      state.hostBrand = { teamId: 'team-arbore' }

      const response = await runAt(ARBORE, '/')

      expect(locationOf(response)).toBe('https://app.gnubok.se/')
    })

    it('keeps an allowlisted email on the brand domain before any membership exists', async () => {
      // The partner owner between allowlisted signup and team provisioning:
      // no team_members row, no company, only a brand_signup_allowlist entry.
      const { isEmailOnBrandAllowlist } = await import('@/lib/auth/brand-signup-gate')
      state.user = { ...SIGNED_IN, email: 'owner@partner.example' }
      state.hostBrand = { teamId: 'team-arbore', id: 'brand-arbore' }
      state.allowlisted = true

      const response = await runAt(ARBORE, '/')

      expect(response.status).toBe(200)
      expect(locationOf(response)).toBeNull()
      expect(response.headers.get('set-cookie')).toContain(
        'gnubok-home-ok=user-1~arbore.accounted.se',
      )
      expect(isEmailOnBrandAllowlist).toHaveBeenCalledWith(
        'brand-arbore',
        'owner@partner.example',
      )
    })

    it('still redirects a non-allowlisted email off the brand domain', async () => {
      state.user = { ...SIGNED_IN, email: 'stranger@example.com' }
      state.hostBrand = { teamId: 'team-arbore', id: 'brand-arbore' }
      state.allowlisted = false

      const response = await runAt(ARBORE, '/')

      expect(locationOf(response)).toBe('https://app.gnubok.se/')
    })

    it('skips the allowlist lookup for a user without an email', async () => {
      const { isEmailOnBrandAllowlist } = await import('@/lib/auth/brand-signup-gate')
      state.hostBrand = { teamId: 'team-arbore' }
      state.allowlisted = true

      const response = await runAt(ARBORE, '/')

      expect(locationOf(response)).toBe('https://app.gnubok.se/')
      expect(isEmailOnBrandAllowlist).not.toHaveBeenCalled()
    })

    it('keeps a byrå client user on the byrå domain their company lives under', async () => {
      state.hostBrand = { teamId: 'team-arbore' }
      state.clientMemberships = [{ company_id: 'company-1' }]

      const response = await runAt(ARBORE, '/')

      expect(response.status).toBe(200)
    })

    it('does nothing on the platform domain for regular users', async () => {
      const response = await runAt('https://app.gnubok.se', '/')

      expect(response.status).toBe(200)
    })

    it('does nothing on localhost and direct Vercel hosts', async () => {
      state.byraMemberships = [
        { teams: { kind: 'byra', brands: { domain: 'arbore.accounted.se' } } },
      ]

      for (const origin of [ORIGIN, 'https://erp-base-abc123.vercel.app']) {
        const response = await runAt(origin, '/byra')
        expect(response.status).toBe(200)
      }
    })

    it('skips the check while this user\'s OK cookie for this host is fresh', async () => {
      state.byraMemberships = [
        { teams: { kind: 'byra', brands: { domain: 'acount.accounted.se' } } },
      ]

      const response = await runAt(ARBORE, '/', {
        cookie: 'gnubok-home-ok=user-1~arbore.accounted.se',
      })

      expect(response.status).toBe(200)
    })

    it('ignores an OK cookie left behind by a DIFFERENT user and still bounces', async () => {
      // The amnas account-switch repro (2026-08-31): the byrå owner signs in
      // on the brand host (cookie set), signs out, and a second account with
      // no ties to the brand signs in within the TTL window. The inherited
      // host-only verdict skipped the bounce; the user-scoped value must not.
      state.hostBrand = { teamId: 'team-arbore', id: 'brand-arbore' }

      const response = await runAt(ARBORE, '/', {
        cookie: 'gnubok-home-ok=user-OTHER~arbore.accounted.se',
      })

      expect(locationOf(response)).toBe('https://app.gnubok.se/')
    })

    it('ignores a stale host-only cookie from the pre-user-scoped format', async () => {
      state.hostBrand = { teamId: 'team-arbore', id: 'brand-arbore' }

      const response = await runAt(ARBORE, '/', {
        cookie: 'gnubok-home-ok=arbore.accounted.se',
      })

      expect(locationOf(response)).toBe('https://app.gnubok.se/')
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
      state.user = MFA_USER
      state.jwtAal = 'aal1'

      const response = await run('/settings/tax')

      expect(response.status).toBe(200)
    })

    it('does not redirect on self-hosted even with MFA required', async () => {
      process.env.NEXT_PUBLIC_REQUIRE_MFA = 'true'
      process.env.NEXT_PUBLIC_SELF_HOSTED = 'true'
      state.user = MFA_USER
      state.jwtAal = 'aal1'

      const response = await run('/settings/tax')

      expect(response.status).toBe(200)
    })

    it('does not redirect BankID-linked users, who are already 2FA', async () => {
      process.env.NEXT_PUBLIC_REQUIRE_MFA = 'true'
      state.user = { ...MFA_USER, app_metadata: { bankid_linked: true } }
      state.jwtAal = 'aal1'

      const response = await run('/settings/tax')

      expect(response.status).toBe(200)
    })
  })
})
