import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

import { requireAuth } from '../require-auth'
import { createClient } from '@/lib/supabase/server'

const CLAIMS = {
  iss: 'https://test.supabase.co/auth/v1',
  sub: 'user-1',
  aud: 'authenticated',
  exp: 9999999999,
  iat: 0,
  role: 'authenticated',
  aal: 'aal1',
  session_id: 'sess-1',
  email: 'test@test.se',
  is_anonymous: false,
  app_metadata: { provider: 'email' },
  user_metadata: {},
}

const MOCK_USER = {
  id: 'user-1',
  aud: 'authenticated',
  email: 'test@test.se',
  app_metadata: { provider: 'email' },
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
}

const VERIFIED_TOTP = { id: 'f1', status: 'verified', factor_type: 'totp' }
const UNVERIFIED_TOTP = { id: 'f2', status: 'unverified', factor_type: 'totp' }

/** listFactors() payload: `all` carries everything, the typed arrays only verified ones. */
function factorList(...factors: Array<typeof VERIFIED_TOTP>) {
  return {
    data: {
      all: factors,
      totp: factors.filter((f) => f.status === 'verified'),
      phone: [],
      webauthn: [],
    },
    error: null,
  }
}

type MockAuth = Record<string, unknown>

function useSupabase(auth: MockAuth) {
  const supabase = { auth }
  vi.mocked(createClient).mockResolvedValue(supabase as never)
  return supabase
}

function enableMfa() {
  vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
}

describe('requireAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Deterministic baseline: MFA off unless a test stubs it on.
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'false')
    // Matches CLAIMS.iss so the fast path passes the issuer pinning.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses locally verified claims without calling getUser (fast path)', async () => {
    const getClaims = vi.fn().mockResolvedValue({ data: { claims: CLAIMS }, error: null })
    const getUser = vi.fn()
    useSupabase({ getClaims, getUser })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(result.user?.email).toBe('test@test.se')
    expect(result.user?.app_metadata).toEqual({ provider: 'email' })
    expect(getUser).not.toHaveBeenCalled()
  })

  it('falls back to getUser when the client has no getClaims (legacy mocks)', async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: MOCK_USER }, error: null })
    useSupabase({ getUser })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  it('returns 401 when neither claims nor getUser yield a user', async () => {
    const getClaims = vi.fn().mockResolvedValue({ data: null, error: null })
    const getUser = vi.fn().mockResolvedValue({ data: { user: null }, error: null })
    useSupabase({ getClaims, getUser })

    const result = await requireAuth()

    expect(result.user).toBeNull()
    expect(result.error?.status).toBe(401)
    const body = await result.error?.json()
    expect(body).toEqual({ error: 'Unauthorized' })
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  it('falls back to getUser when getClaims throws (JWKS outage)', async () => {
    const getClaims = vi.fn().mockRejectedValue(new Error('jwks fetch failed'))
    const getUser = vi.fn().mockResolvedValue({ data: { user: MOCK_USER }, error: null })
    useSupabase({ getClaims, getUser })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  it('falls back to getUser when the claims issuer does not match the project URL', async () => {
    const claims = { ...CLAIMS, iss: 'https://evil.example.com/auth/v1' }
    const getClaims = vi.fn().mockResolvedValue({ data: { claims }, error: null })
    const getUser = vi.fn().mockResolvedValue({ data: { user: MOCK_USER }, error: null })
    useSupabase({ getClaims, getUser })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  it('falls back to getUser when the claims audience is not authenticated', async () => {
    const claims = { ...CLAIMS, aud: 'something-else' }
    const getClaims = vi.fn().mockResolvedValue({ data: { claims }, error: null })
    const getUser = vi.fn().mockResolvedValue({ data: { user: MOCK_USER }, error: null })
    useSupabase({ getClaims, getUser })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  it('accepts an array audience containing authenticated', async () => {
    const claims = { ...CLAIMS, aud: ['authenticated', 'other'] }
    const getClaims = vi.fn().mockResolvedValue({ data: { claims }, error: null })
    const getUser = vi.fn()
    useSupabase({ getClaims, getUser })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(getUser).not.toHaveBeenCalled()
  })

  describe('MFA gate', () => {
    beforeEach(() => {
      enableMfa()
      vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('returns 403 for an AAL1 session when the auth server reports a verified factor', async () => {
      const getClaims = vi.fn().mockResolvedValue({ data: { claims: CLAIMS }, error: null })
      const listFactors = vi.fn().mockResolvedValue(factorList(VERIFIED_TOTP))
      useSupabase({ getClaims, mfa: { listFactors } })

      const result = await requireAuth()

      expect(result.user).toBeNull()
      expect(result.error?.status).toBe(403)
      const body = await result.error?.json()
      expect(body).toEqual({ error: 'MFA verification required' })
      expect(listFactors).toHaveBeenCalledTimes(1)
    })

    it('never consults the cookie-derived assurance level', async () => {
      // The attack: the sb-*-auth-token cookie is unsigned JSON, so the
      // password holder strips `user.factors` and the local
      // getAuthenticatorAssuranceLevel() reports nextLevel aal1 ("no MFA
      // enrolled"). The gate must decide on the server's answer instead.
      const getClaims = vi.fn().mockResolvedValue({ data: { claims: CLAIMS }, error: null })
      const getAuthenticatorAssuranceLevel = vi.fn().mockResolvedValue({
        data: { currentLevel: 'aal1', nextLevel: 'aal1' },
        error: null,
      })
      const listFactors = vi.fn().mockResolvedValue(factorList(VERIFIED_TOTP))
      useSupabase({ getClaims, mfa: { getAuthenticatorAssuranceLevel, listFactors } })

      const result = await requireAuth()

      expect(result.error?.status).toBe(403)
      expect(getAuthenticatorAssuranceLevel).not.toHaveBeenCalled()
    })

    it('passes an AAL2 session on the verified claims alone (no listFactors round trip)', async () => {
      const claims = { ...CLAIMS, aal: 'aal2' }
      const getClaims = vi.fn().mockResolvedValue({ data: { claims }, error: null })
      const listFactors = vi.fn()
      const getAuthenticatorAssuranceLevel = vi.fn()
      useSupabase({ getClaims, mfa: { listFactors, getAuthenticatorAssuranceLevel } })

      const result = await requireAuth()

      expect(result.error).toBeNull()
      expect(result.user?.id).toBe('user-1')
      expect(listFactors).not.toHaveBeenCalled()
      expect(getAuthenticatorAssuranceLevel).not.toHaveBeenCalled()
    })

    it('passes an AAL1 session when the auth server reports no verified factor', async () => {
      const getClaims = vi.fn().mockResolvedValue({ data: { claims: CLAIMS }, error: null })
      const listFactors = vi.fn().mockResolvedValue(factorList())
      useSupabase({ getClaims, mfa: { listFactors } })

      const result = await requireAuth()

      expect(result.error).toBeNull()
      expect(result.user?.id).toBe('user-1')
      expect(listFactors).toHaveBeenCalledTimes(1)
    })

    it('does not count an unverified (enrolment in progress) factor as a step-up target', async () => {
      const getClaims = vi.fn().mockResolvedValue({ data: { claims: CLAIMS }, error: null })
      const listFactors = vi.fn().mockResolvedValue(factorList(UNVERIFIED_TOTP))
      useSupabase({ getClaims, mfa: { listFactors } })

      const result = await requireAuth()

      expect(result.error).toBeNull()
    })

    it('reads a verified phone factor from the typed array when `all` is absent', async () => {
      const getClaims = vi.fn().mockResolvedValue({ data: { claims: CLAIMS }, error: null })
      const listFactors = vi.fn().mockResolvedValue({
        data: { phone: [{ id: 'p1', status: 'verified', factor_type: 'phone' }] },
        error: null,
      })
      useSupabase({ getClaims, mfa: { listFactors } })

      const result = await requireAuth()

      expect(result.error?.status).toBe(403)
    })

    it('treats a session whose verified claims carry no aal as not assured', async () => {
      const { aal: _aal, ...claims } = CLAIMS
      const getClaims = vi.fn().mockResolvedValue({ data: { claims }, error: null })
      const listFactors = vi.fn().mockResolvedValue(factorList(VERIFIED_TOTP))
      useSupabase({ getClaims, mfa: { listFactors } })

      const result = await requireAuth()

      expect(result.error?.status).toBe(403)
    })

    it('fails closed when listFactors returns an error', async () => {
      const getClaims = vi.fn().mockResolvedValue({ data: { claims: CLAIMS }, error: null })
      const listFactors = vi.fn().mockResolvedValue({
        data: null,
        error: { name: 'AuthApiError', message: 'upstream unavailable' },
      })
      useSupabase({ getClaims, mfa: { listFactors } })

      const result = await requireAuth()

      expect(result.error?.status).toBe(403)
    })

    it('fails closed when listFactors throws', async () => {
      const getClaims = vi.fn().mockResolvedValue({ data: { claims: CLAIMS }, error: null })
      const listFactors = vi.fn().mockRejectedValue(new Error('network down'))
      useSupabase({ getClaims, mfa: { listFactors } })

      const result = await requireAuth()

      expect(result.error?.status).toBe(403)
    })

    it('fails closed when the client exposes no mfa API at all', async () => {
      const getClaims = vi.fn().mockResolvedValue({ data: { claims: CLAIMS }, error: null })
      useSupabase({ getClaims })

      const result = await requireAuth()

      expect(result.error?.status).toBe(403)
    })

    it('asks listFactors on the getUser fallback path and refuses a verified factor', async () => {
      // No verified claims exist here (getClaims failed), so the level is
      // unknown: a verified factor means the session must be refused.
      const getClaims = vi.fn().mockRejectedValue(new Error('jwks fetch failed'))
      const getUser = vi.fn().mockResolvedValue({ data: { user: MOCK_USER }, error: null })
      const listFactors = vi.fn().mockResolvedValue(factorList(VERIFIED_TOTP))
      useSupabase({ getClaims, getUser, mfa: { listFactors } })

      const result = await requireAuth()

      expect(result.error?.status).toBe(403)
      expect(listFactors).toHaveBeenCalledTimes(1)
    })

    it('passes a factor-less user on the getUser fallback path', async () => {
      const getUser = vi.fn().mockResolvedValue({ data: { user: MOCK_USER }, error: null })
      const listFactors = vi.fn().mockResolvedValue(factorList())
      useSupabase({ getUser, mfa: { listFactors } })

      const result = await requireAuth()

      expect(result.error).toBeNull()
      expect(result.user?.id).toBe('user-1')
      expect(listFactors).toHaveBeenCalledTimes(1)
    })

    it('skips the MFA check for bankid_linked users', async () => {
      const claims = { ...CLAIMS, app_metadata: { provider: 'email', bankid_linked: true } }
      const getClaims = vi.fn().mockResolvedValue({ data: { claims }, error: null })
      const listFactors = vi.fn()
      useSupabase({ getClaims, mfa: { listFactors } })

      const result = await requireAuth()

      expect(result.error).toBeNull()
      expect(result.user?.id).toBe('user-1')
      expect(listFactors).not.toHaveBeenCalled()
    })
  })
})
