import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

const verifyOtp = vi.fn()
const exchangeCodeForSession = vi.fn()

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      verifyOtp,
      exchangeCodeForSession,
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: null }),
        listFactors: vi.fn().mockResolvedValue({ data: null }),
      },
    },
    from: vi.fn(),
    rpc: vi.fn(),
  })),
}))

vi.mock('@/lib/auth/invite-tokens', () => ({
  hashInviteToken: vi.fn(),
}))

// Default '/' keeps every pre-WL-14 expectation intact: the helper resolving
// '/' is byte-identical to the old hardcoded dashboard redirect.
const resolveLandingDestinationMock = vi.fn()
vi.mock('@/lib/company/landing-server', () => ({
  resolveLandingDestination: async (...args: unknown[]) =>
    (await resolveLandingDestinationMock(...args)) ?? '/',
}))

import { GET } from '../route'

describe('GET /auth/callback: recovery flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects to /reset-password after a successful recovery OTP (token-hash flow)', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=abc&type=recovery&next=/reset-password'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc', type: 'recovery' })
  })

  it('redirects to /reset-password after a successful PKCE exchange when next=/reset-password (no type param)', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?code=xyz&next=/reset-password'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
    expect(exchangeCodeForSession).toHaveBeenCalledWith('xyz')
  })

  it('tags a failed recovery link with flow=recovery so the login page shows reset copy', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=expired&type=recovery&next=/reset-password'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=auth_error&flow=recovery'
    )
  })

  it('tags a failed signup confirmation (PKCE code, no type/next) with flow=signup', async () => {
    exchangeCodeForSession.mockResolvedValue({
      error: { message: 'code verifier missing' },
    })

    const request = new NextRequest('http://localhost:3000/auth/callback?code=xyz')
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=auth_error&flow=signup'
    )
  })

  it('tags a failed OAuth code exchange (flow=oauth marker) with flow=oauth', async () => {
    exchangeCodeForSession.mockResolvedValue({
      error: { message: 'code verifier missing' },
    })

    const request = new NextRequest('http://localhost:3000/auth/callback?code=xyz&flow=oauth')
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=auth_error&flow=oauth'
    )
  })

  it('tags a provider denial (no code, only ?error from the provider) with flow=oauth', async () => {
    const request = new NextRequest(
      'http://localhost:3000/auth/callback?flow=oauth&error=access_denied'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=auth_error&flow=oauth'
    )
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
  })
})

describe('GET /auth/callback: admin invite flow (type=invite)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('routes a verified invite to /reset-password and preserves the invite token from next', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=abc&type=invite&next=/invite/gnubok_inv_tok123'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc', type: 'invite' })
    // The company invite token is persisted as the pre-auth invite cookie so
    // the reset-password handoff can accept the membership after the
    // password is set.
    expect(response.headers.get('set-cookie') ?? '').toContain(
      'gnubok-invite-token=gnubok_inv_tok123'
    )
  })

  it('routes a verified invite without an invite path in next to /reset-password without the cookie', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=abc&type=invite'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
    expect(response.headers.get('set-cookie') ?? '').not.toContain('gnubok-invite-token')
  })
})

describe('GET /auth/callback: resuming an MCP OAuth consent flow (issue #1814)', () => {
  // A signup that started from an MCP client's Connect popup confirms its
  // e-mail (or completes Google OAuth) here. The consent page handles the
  // zero-company state itself, so it is the one `next` this callback honours
  // for a fresh session; anything else still lands on the dashboard.
  const CONSENT = '/api/mcp-oauth/authorize?response_type=code&state=xyz'

  function clientWithTeamMembership() {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      maybeSingle: vi.fn().mockResolvedValue({ data: { team_id: 'team-1' }, error: null }),
    }
    return {
      auth: {
        verifyOtp,
        exchangeCodeForSession,
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: null }),
          listFactors: vi.fn().mockResolvedValue({ data: null }),
        },
      },
      from: vi.fn(() => chain),
      rpc: vi.fn(),
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createServerClient).mockImplementation(() => clientWithTeamMembership() as never)
  })

  it('sends a confirmed signup back to the consent page when next targets it', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      `http://localhost:3000/auth/callback?token_hash=abc&type=signup&next=${encodeURIComponent(CONSENT)}`
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(`http://localhost:3000${CONSENT}`)
  })

  it('carries the consent destination through the MFA verify step', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    const client = clientWithTeamMembership()
    client.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
    })
    vi.mocked(createServerClient).mockImplementation(() => client as never)

    const request = new NextRequest(
      `http://localhost:3000/auth/callback?token_hash=abc&type=signup&next=${encodeURIComponent(CONSENT)}`
    )
    const response = await GET(request)

    const location = new URL(response.headers.get('location')!)
    expect(location.pathname).toBe('/mfa/verify')
    expect(location.searchParams.get('returnTo')).toBe(CONSENT)
  })

  it('still lands on the dashboard for any other next', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=abc&type=signup&next=%2Fsettings'
    )
    const response = await GET(request)

    expect(response.headers.get('location')).toBe('http://localhost:3000/')
  })

  it('ignores an off-origin next that merely contains the consent path', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      `http://localhost:3000/auth/callback?token_hash=abc&type=signup&next=${encodeURIComponent('https://evil.example' + CONSENT)}`
    )
    const response = await GET(request)

    expect(response.headers.get('location')).toBe('http://localhost:3000/')
  })
})

describe('GET /auth/callback: WL-14 cockpit landing', () => {
  function clientWithTeamMembership() {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      maybeSingle: vi.fn().mockResolvedValue({ data: { team_id: 'team-1' }, error: null }),
    }
    return {
      auth: {
        verifyOtp,
        exchangeCodeForSession,
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: null }),
          listFactors: vi.fn().mockResolvedValue({ data: null }),
        },
      },
      from: vi.fn(() => chain),
      rpc: vi.fn(),
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createServerClient).mockImplementation(() => clientWithTeamMembership() as never)
  })

  it('lands byrå staff in the cockpit when the helper resolves /clients', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    resolveLandingDestinationMock.mockResolvedValue('/clients')

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=abc&type=magiclink',
      { headers: { 'x-forwarded-host': 'app.amnas.se' } }
    )
    const response = await GET(request)

    expect(response.headers.get('location')).toBe('http://localhost:3000/clients')
    expect(resolveLandingDestinationMock).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'app.amnas.se'
    )
  })

  it('degrades to the dashboard when the helper throws', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    resolveLandingDestinationMock.mockRejectedValue(new Error('brands unavailable'))

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=abc&type=magiclink'
    )
    const response = await GET(request)

    expect(response.headers.get('location')).toBe('http://localhost:3000/')
  })

  it('never consults the helper when next resumes the MCP OAuth consent flow', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    const consent = '/api/mcp-oauth/authorize?response_type=code&state=xyz'

    const request = new NextRequest(
      `http://localhost:3000/auth/callback?token_hash=abc&type=signup&next=${encodeURIComponent(consent)}`
    )
    const response = await GET(request)

    expect(response.headers.get('location')).toBe(`http://localhost:3000${consent}`)
    expect(resolveLandingDestinationMock).not.toHaveBeenCalled()
  })
})
