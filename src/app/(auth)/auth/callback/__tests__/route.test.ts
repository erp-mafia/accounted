import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

const verifyOtp = vi.fn()
const exchangeCodeForSession = vi.fn()

// The redirect origin is resolved from the forwarded host (see route.ts);
// app.testbrand.example is the registered brand domain in these tests, and
// brand-registry-down.example stands for a brands lookup that fails.
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandResultByHost: async (host: string) => ({
    brand: host === 'app.testbrand.example' ? { domain: host } : null,
    lookupFailed: host === 'brand-registry-down.example',
  }),
}))
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

const acceptPendingTeamInviteByTokenMock = vi.fn()
vi.mock('@/lib/company/pending-invites', () => ({
  acceptPendingTeamInviteByToken: (...args: unknown[]) =>
    acceptPendingTeamInviteByTokenMock(...args),
}))

// Default '/' keeps every pre-WL-14 expectation intact: the helper resolving
// '/' is byte-identical to the old hardcoded dashboard redirect.
const resolveLandingDestinationMock = vi.fn()
vi.mock('@/lib/company/landing-server', () => ({
  resolveLandingDestination: async (...args: unknown[]) =>
    (await resolveLandingDestinationMock(...args)) ?? '/',
}))

import { GET, POST } from '../route'
import { clickEmailLink } from './click-email-link'

// Shared by the MCP OAuth consent and WL-14 describe blocks: an SSR client
// whose team_members lookup finds an existing membership.
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

describe('/auth/callback: an emailed token link waits for the click', () => {
  // The shape the Send Email hook builds: redirect_to's query, then the token.
  const RECOVERY_LINK =
    'http://localhost:3000/auth/callback?next=%2Freset-password&token_hash=abc&type=recovery'

  beforeEach(() => {
    vi.clearAllMocks()
    verifyOtp.mockResolvedValue({ error: null })
  })

  it('holds the token in a cookie and sends the browser to /auth/confirm without spending it', async () => {
    const response = await GET(new NextRequest(RECOVERY_LINK))

    expect(verifyOtp).not.toHaveBeenCalled()
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/auth/confirm?next=%2Freset-password&type=recovery'
    )
    expect(response.cookies.get('accounted-confirm-link')).toMatchObject({
      value: 'abc',
      httpOnly: true,
      path: '/auth/callback',
      sameSite: 'lax',
      maxAge: 3600,
    })
  })

  it('leaves the link working through the fetches a mail system makes before the click', async () => {
    // The production trace: a scanner GET on delivery, then a HEAD half a
    // second before the user's own click (Next.js serves HEAD with the GET
    // handler). Each used to run verifyOtp, so the first spent the token and
    // the user's click failed as an expired link.
    await GET(new NextRequest(RECOVERY_LINK))
    await GET(new NextRequest(RECOVERY_LINK, { method: 'HEAD' }))
    expect(verifyOtp).not.toHaveBeenCalled()

    const response = await clickEmailLink(RECOVERY_LINK)

    expect(verifyOtp).toHaveBeenCalledTimes(1)
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc', type: 'recovery' })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
  })

  it('answers the click with 303 and clears the held token', async () => {
    const response = await clickEmailLink(RECOVERY_LINK)

    expect(response.status).toBe(303)
    expect(response.headers.get('set-cookie') ?? '').toContain('accounted-confirm-link=;')
  })

  it('treats a click without a held token as a dead link and never asks GoTrue', async () => {
    // Another browser, an hour later, or the back button after the token was
    // spent. A token_hash in the query is not a held token.
    const response = await POST(
      new NextRequest(
        'http://localhost:3000/auth/callback?next=%2Freset-password&type=recovery&token_hash=abc',
        { method: 'POST' }
      )
    )

    expect(verifyOtp).not.toHaveBeenCalled()
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=auth_error&flow=recovery'
    )
  })
})

describe('/auth/callback: recovery flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects to /reset-password after a confirmed recovery link (token-hash flow)', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const response = await clickEmailLink(
      'http://localhost:3000/auth/callback?token_hash=abc&type=recovery&next=/reset-password'
    )

    expect(response.status).toBe(303)
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

    const response = await clickEmailLink(
      'http://localhost:3000/auth/callback?token_hash=expired&type=recovery&next=/reset-password'
    )

    expect(response.status).toBe(303)
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

describe('/auth/callback: admin invite flow (type=invite)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('routes a verified invite to /reset-password and preserves the invite token from next', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const response = await clickEmailLink(
      'http://localhost:3000/auth/callback?token_hash=abc&type=invite&next=/invite/gnubok_inv_tok123'
    )

    expect(response.status).toBe(303)
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

    const response = await clickEmailLink(
      'http://localhost:3000/auth/callback?token_hash=abc&type=invite'
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
    expect(response.headers.get('set-cookie') ?? '').not.toContain('gnubok-invite-token')
  })
})

describe('/auth/callback: resuming an MCP OAuth consent flow (issue #1814)', () => {
  // A signup that started from an MCP client's Connect popup confirms its
  // e-mail (or completes Google OAuth) here. The consent page handles the
  // zero-company state itself, so it is the one `next` this callback honours
  // for a fresh session; anything else still lands on the dashboard.
  const CONSENT = '/api/mcp-oauth/authorize?response_type=code&state=xyz'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createServerClient).mockImplementation(() => clientWithTeamMembership() as never)
  })

  it('sends a confirmed signup back to the consent page when next targets it', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const response = await clickEmailLink(
      `http://localhost:3000/auth/callback?token_hash=abc&type=signup&next=${encodeURIComponent(CONSENT)}`
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`http://localhost:3000${CONSENT}`)
  })

  it('carries the consent destination through the MFA verify step', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    const client = clientWithTeamMembership()
    client.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
    })
    vi.mocked(createServerClient).mockImplementation(() => client as never)

    const response = await clickEmailLink(
      `http://localhost:3000/auth/callback?token_hash=abc&type=signup&next=${encodeURIComponent(CONSENT)}`
    )

    const location = new URL(response.headers.get('location')!)
    expect(location.pathname).toBe('/mfa/verify')
    expect(location.searchParams.get('returnTo')).toBe(CONSENT)
  })

  it('still lands on the dashboard for any other next', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const response = await clickEmailLink(
      'http://localhost:3000/auth/callback?token_hash=abc&type=signup&next=%2Fsettings'
    )

    expect(response.headers.get('location')).toBe('http://localhost:3000/')
  })

  it('ignores an off-origin next that merely contains the consent path', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const response = await clickEmailLink(
      `http://localhost:3000/auth/callback?token_hash=abc&type=signup&next=${encodeURIComponent('https://evil.example' + CONSENT)}`
    )

    expect(response.headers.get('location')).toBe('http://localhost:3000/')
  })
})

describe('/auth/callback: WL-14 cockpit landing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createServerClient).mockImplementation(() => clientWithTeamMembership() as never)
  })

  it('lands byrå staff in the cockpit when the helper resolves /clients', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    resolveLandingDestinationMock.mockResolvedValue('/clients')

    const response = await clickEmailLink(
      'http://localhost:3000/auth/callback?token_hash=abc&type=magiclink',
      { headers: { 'x-forwarded-host': 'app.brand-f.se' } }
    )

    expect(response.headers.get('location')).toBe('http://localhost:3000/clients')
    expect(resolveLandingDestinationMock).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'app.brand-f.se'
    )
  })

  it('degrades to the dashboard when the helper throws', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    resolveLandingDestinationMock.mockRejectedValue(new Error('brands unavailable'))

    const response = await clickEmailLink(
      'http://localhost:3000/auth/callback?token_hash=abc&type=magiclink'
    )

    expect(response.headers.get('location')).toBe('http://localhost:3000/')
  })

  it('never consults the helper when next resumes the MCP OAuth consent flow', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    const consent = '/api/mcp-oauth/authorize?response_type=code&state=xyz'

    const response = await clickEmailLink(
      `http://localhost:3000/auth/callback?token_hash=abc&type=signup&next=${encodeURIComponent(consent)}`
    )

    expect(response.headers.get('location')).toBe(`http://localhost:3000${consent}`)
    expect(resolveLandingDestinationMock).not.toHaveBeenCalled()
  })
})

describe('/auth/callback: byrå-team invite acceptance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createServerClient).mockImplementation(() => clientWithTeamMembership() as never)
    acceptPendingTeamInviteByTokenMock.mockResolvedValue({ status: 'invalid' })
  })

  it('accepts a byrå-team invite from the cookie, lands the admin in /clients, and clears the cookie', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    acceptPendingTeamInviteByTokenMock.mockResolvedValue({
      status: 'accepted',
      teamId: 'team-1',
      teamName: 'Byrån',
    })
    // Membership now exists, so the landing helper resolves the cockpit.
    resolveLandingDestinationMock.mockResolvedValue('/clients')

    const response = await clickEmailLink(
      'http://localhost:3000/auth/callback?token_hash=abc&type=signup',
      { headers: { cookie: 'gnubok-invite-token=gnubok_inv_team', 'x-forwarded-host': 'app.brand-f.se' } }
    )

    expect(acceptPendingTeamInviteByTokenMock).toHaveBeenCalledWith(
      { id: 'user-1', email: undefined },
      'gnubok_inv_team'
    )
    expect(response.headers.get('location')).toBe('http://localhost:3000/clients')
    // Membership exists now, so the cookie is cleared instead of left for a
    // retry that would only 409.
    expect(response.headers.get('set-cookie') ?? '').toContain('gnubok-invite-token=;')
  })

  it('keeps the cookie for the onboarding retry when the team invite is not (yet) accepted', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    acceptPendingTeamInviteByTokenMock.mockResolvedValue({ status: 'invalid' })
    resolveLandingDestinationMock.mockResolvedValue('/')

    const response = await clickEmailLink(
      'http://localhost:3000/auth/callback?token_hash=abc&type=signup',
      { headers: { cookie: 'gnubok-invite-token=gnubok_inv_team' } }
    )

    // Not consumed: the cookie is not actively deleted here (no max-age=0).
    expect(response.headers.get('set-cookie') ?? '').not.toContain('gnubok-invite-token=;')
  })
})

describe('GET /auth/callback: off-origin next after a successful exchange', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('never redirects off-origin when getUser comes back empty after the exchange', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null })
    vi.mocked(createServerClient).mockReturnValueOnce({
      auth: {
        verifyOtp,
        exchangeCodeForSession,
        getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: null }),
          listFactors: vi.fn().mockResolvedValue({ data: null }),
        },
      },
      from: vi.fn(),
      rpc: vi.fn(),
    } as never)

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?code=xyz&next=//evil.example.com/steal'
    )
    const response = await GET(request)

    const location = response.headers.get('location')
    expect(location).not.toBeNull()
    expect(new URL(location!).origin).toBe('http://localhost:3000')
  })
})

describe('GET /auth/callback: redirect origin behind a reverse proxy', () => {
  const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.test'
    exchangeCodeForSession.mockResolvedValue({
      error: { message: 'code verifier missing' },
    })
  })

  afterEach(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL
  })

  // A standalone Next.js server sees its bind address in request.url; the
  // redirect must go to the host the browser used, not to 0.0.0.0:3000.
  it('redirects to the forwarded canonical host, not the bind address', async () => {
    const request = new NextRequest('http://0.0.0.0:3000/auth/callback?code=xyz&flow=oauth', {
      headers: { 'x-forwarded-host': 'app.accounted.test', host: '0.0.0.0:3000' },
    })
    const response = await GET(request)

    expect(response.headers.get('location')).toBe(
      'https://app.accounted.test/login?error=auth_error&flow=oauth'
    )
  })

  it('falls back to the canonical host for an unknown forwarded host', async () => {
    const request = new NextRequest('http://0.0.0.0:3000/auth/callback?code=xyz&flow=oauth', {
      headers: { 'x-forwarded-host': 'evil.example', host: '0.0.0.0:3000' },
    })
    const response = await GET(request)

    expect(response.headers.get('location')).toBe(
      'https://app.accounted.test/login?error=auth_error&flow=oauth'
    )
  })
})

describe('/auth/callback: every redirect site uses the trusted origin', () => {
  const BIND = 'http://0.0.0.0:3000'
  const CANONICAL = 'https://app.accounted.test'
  const RECOVERY_LINK = `${BIND}/auth/callback?next=%2Freset-password&token_hash=abc&type=recovery`
  const OAUTH_RETURN = `${BIND}/auth/callback?code=xyz&flow=oauth`
  const proxied = (forwardedHost: string) => ({
    headers: { 'x-forwarded-host': forwardedHost, host: '0.0.0.0:3000' },
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    verifyOtp.mockResolvedValue({ error: null })
    exchangeCodeForSession.mockResolvedValue({ error: { message: 'code verifier missing' } })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('holds an emailed token and sends the browser to /auth/confirm on the forwarded host', async () => {
    const response = await GET(new NextRequest(RECOVERY_LINK, proxied('app.accounted.test')))

    expect(verifyOtp).not.toHaveBeenCalled()
    expect(response.headers.get('location')).toBe(
      `${CANONICAL}/auth/confirm?next=%2Freset-password&type=recovery`,
    )
  })

  it('completes the confirm click on the forwarded host', async () => {
    const response = await clickEmailLink(RECOVERY_LINK, proxied('app.accounted.test'))

    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc', type: 'recovery' })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`${CANONICAL}/reset-password`)
  })

  it('lands a successful provider login on the forwarded host', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null })
    vi.mocked(createServerClient).mockReturnValueOnce(clientWithTeamMembership() as never)

    const response = await GET(new NextRequest(OAUTH_RETURN, proxied('app.accounted.test')))

    expect(response.headers.get('location')).toBe(`${CANONICAL}/`)
  })

  it('keeps a registered byrå domain, upgraded to https', async () => {
    const response = await GET(new NextRequest(OAUTH_RETURN, proxied('app.testbrand.example')))

    expect(response.headers.get('location')).toBe(
      'https://app.testbrand.example/login?error=auth_error&flow=oauth',
    )
  })

  // X-Forwarded-Host and Host are attacker-controlled: whatever they name,
  // a redirect may only land on a host this deployment serves.
  const spoofs: Array<[string, string, Record<string, string>]> = [
    ['an unknown forwarded host', BIND, { 'x-forwarded-host': 'evil.example', host: '0.0.0.0:3000' }],
    ['an unknown Host without a proxy', BIND, { host: 'evil.example' }],
    ['an unknown host in request.url itself', 'https://evil.example', {}],
    ['a suffix look-alike of the canonical host', BIND, { 'x-forwarded-host': 'app.accounted.test.evil.example' }],
    ['a forwarded host list', BIND, { 'x-forwarded-host': 'evil.example, app.accounted.test' }],
    ['a brand domain on a non-default port', BIND, { 'x-forwarded-host': 'app.testbrand.example:8443' }],
    ['a local host on a hosted canonical', BIND, { 'x-forwarded-host': 'localhost:3000' }],
    ['a host whose brand lookup fails', BIND, { 'x-forwarded-host': 'brand-registry-down.example' }],
  ]

  it.each(spoofs)('%s falls back to the canonical origin on every hop', async (_label, base, headers) => {
    const held = await GET(
      new NextRequest(
        `${base}/auth/callback?next=%2Freset-password&token_hash=abc&type=recovery`,
        { headers },
      ),
    )
    expect(new URL(held.headers.get('location')!).origin).toBe(CANONICAL)

    const clicked = await POST(
      new NextRequest(`${base}/auth/callback?next=%2Freset-password&type=recovery`, {
        method: 'POST',
        headers: { ...headers, cookie: 'accounted-confirm-link=abc' },
      }),
    )
    expect(clicked.headers.get('location')).toBe(`${CANONICAL}/reset-password`)

    const bounced = await GET(new NextRequest(`${base}/auth/callback?code=xyz&flow=oauth`, { headers }))
    expect(bounced.headers.get('location')).toBe(`${CANONICAL}/login?error=auth_error&flow=oauth`)
  })
})
