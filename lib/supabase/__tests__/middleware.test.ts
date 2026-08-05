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
  // Rows the team_members query resolves to (the byrå exception in the
  // no-company branch awaits an eq-terminated chain, so the from() mock
  // makes exactly that table thenable).
  byraMemberships: [] as Array<{ role: string; teams: { kind: string } }>,
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: state.user },
        error: state.authError,
      })),
      signOut: vi.fn(async () => ({ error: null })),
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
          if (prop === 'then') {
            // The byrå-membership lookup awaits its filter chain directly
            // (no .maybeSingle terminal), so team_members must be thenable.
            if (table === 'team_members') {
              return (resolve: (v: unknown) => void) =>
                resolve({ data: state.byraMemberships, error: null })
            }
            return undefined
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return async () => ({ data: null, error: null })
          }
          return () => self
        },
      })
      return self
    }),
  })),
}))

import { updateSession } from '../middleware'

const ORIGIN = 'http://localhost:3000'
const SIGNED_IN = { id: 'user-1', app_metadata: {} }

function locationOf(response: Response) {
  return response.headers.get('location')
}

function run(path: string) {
  return updateSession(new NextRequest(`${ORIGIN}${path}`))
}

describe('updateSession redirect destinations', () => {
  const envBackup = {
    require: process.env.NEXT_PUBLIC_REQUIRE_MFA,
    selfHosted: process.env.NEXT_PUBLIC_SELF_HOSTED,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    state.user = null
    state.authError = null
    state.aal = null
    state.factors = null
    state.company = {
      data: [{ company_id: 'company-1', locale: 'sv', used_fallback: false }],
      error: null,
    }
    state.byraMemberships = []
    delete process.env.NEXT_PUBLIC_REQUIRE_MFA
    delete process.env.NEXT_PUBLIC_SELF_HOSTED
  })

  afterEach(() => {
    if (envBackup.require === undefined) delete process.env.NEXT_PUBLIC_REQUIRE_MFA
    else process.env.NEXT_PUBLIC_REQUIRE_MFA = envBackup.require
    if (envBackup.selfHosted === undefined) delete process.env.NEXT_PUBLIC_SELF_HOSTED
    else process.env.NEXT_PUBLIC_SELF_HOSTED = envBackup.selfHosted
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

  // ── No-company branch: the byrå cockpit exception ─────────────────────

  describe('byrå owners/admins with zero companies', () => {
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

    it('keeps the onboarding redirect for a plain byrå member', async () => {
      state.byraMemberships = [{ role: 'member', teams: { kind: 'byra' } }]

      const response = await run('/')

      expect(new URL(locationOf(response)!).pathname).toBe('/onboarding')
    })

    it('keeps the onboarding redirect for non-byrå users', async () => {
      state.byraMemberships = []

      const response = await run('/')

      expect(new URL(locationOf(response)!).pathname).toBe('/onboarding')
    })
  })

  // ── MFA semantics that must not change ────────────────────────────────

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
