import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Stock (GoTrue-hosted) email-change links: the outcome comes back through
// redirect_to as ?message= / ?error= / ?code= with flow=email_change stamped by
// /api/account/email, never as a token_hash. The branch returns before any of
// the invite/team/landing machinery runs; these mocks only keep the module
// importable in the test environment.
vi.mock('@/lib/auth/invite-tokens', () => ({ hashInviteToken: vi.fn() }))
vi.mock('@/lib/auth/consume-invite-cookie', () => ({
  INVITE_COOKIE_NAME: 'gnubok-invite-token',
}))
vi.mock('@/lib/company/landing-server', () => ({
  resolveLandingDestination: vi.fn().mockResolvedValue('/'),
}))
vi.mock('@/lib/company/pending-invites', () => ({
  acceptPendingTeamInviteByToken: vi.fn(),
}))

const verifyOtp = vi.fn()
const exchangeCodeForSession = vi.fn()
const getUser = vi.fn()
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      verifyOtp: (...args: unknown[]) => verifyOtp(...args),
      exchangeCodeForSession: (...args: unknown[]) => exchangeCodeForSession(...args),
      getUser: (...args: unknown[]) => getUser(...args),
    },
  }),
}))

import { GET } from '../route'

const STATUS_PAGE = 'https://app.testbrand.example/auth/email-change?status='

function makeRequest(params: Record<string, string>) {
  const url = new URL('https://app.testbrand.example/auth/callback')
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return new NextRequest(url)
}

beforeEach(() => {
  vi.clearAllMocks()
  getUser.mockResolvedValue({ data: { user: null }, error: null })
  exchangeCodeForSession.mockResolvedValue({ data: {}, error: null })
})

describe('GET /auth/callback flow=email_change (stock GoTrue links)', () => {
  it('redirects the first of the two confirmations (?message=) to the partial page', async () => {
    const res = await GET(
      makeRequest({
        flow: 'email_change',
        message:
          'Confirmation link accepted. Please proceed to confirm link sent to the other email',
      }),
    )

    expect(res.headers.get('location')).toBe(`${STATUS_PAGE}partial`)
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('redirects a dead link (?error=) to the failed page', async () => {
    const res = await GET(
      makeRequest({
        flow: 'email_change',
        error: 'access_denied',
        error_code: 'otp_expired',
        error_description: 'Email link is invalid or has expired',
      }),
    )

    expect(res.headers.get('location')).toBe(`${STATUS_PAGE}failed`)
  })

  it('exchanges the completing click (?code=) and redirects to the done page', async () => {
    const res = await GET(makeRequest({ flow: 'email_change', code: 'pkce-code' }))

    expect(exchangeCodeForSession).toHaveBeenCalledWith('pkce-code')
    expect(res.headers.get('location')).toBe(`${STATUS_PAGE}done`)
  })

  it('reports done when the code exchange fails in a browser without a session', async () => {
    // Completing link opened in a phone mail app: no PKCE verifier cookie,
    // no session cookie. GoTrue already flipped the address before minting
    // the code, so this is a completed change, not a failed one.
    exchangeCodeForSession.mockResolvedValue({
      data: {},
      error: { message: 'PKCE code verifier not found' },
    })
    getUser.mockResolvedValue({ data: { user: null }, error: null })

    const res = await GET(makeRequest({ flow: 'email_change', code: 'pkce-code' }))

    expect(exchangeCodeForSession).toHaveBeenCalledWith('pkce-code')
    expect(getUser).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toBe(`${STATUS_PAGE}done`)
  })

  it('falls back to the pending state when the outcome only came in the fragment', async () => {
    getUser.mockResolvedValue({
      data: {
        user: {
          id: 'u1',
          email: 'old@testbrand.example',
          new_email: 'new@testbrand.example',
        },
      },
      error: null,
    })

    const res = await GET(makeRequest({ flow: 'email_change' }))

    expect(res.headers.get('location')).toBe(`${STATUS_PAGE}partial`)
  })

  it('reports failed when nothing can be read (no outcome, no session)', async () => {
    const res = await GET(makeRequest({ flow: 'email_change' }))

    expect(res.headers.get('location')).toBe(`${STATUS_PAGE}failed`)
  })

  it('leaves hook-style token_hash links to the verifyOtp branch', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    })

    const res = await GET(
      makeRequest({ flow: 'email_change', token_hash: 'th', type: 'email_change' }),
    )

    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'th', type: 'email_change' })
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toBe(`${STATUS_PAGE}partial`)
  })

  it('does not hijack other flows that carry a ?message= or ?code=', async () => {
    const res = await GET(makeRequest({ code: 'pkce-code' }))

    expect(exchangeCodeForSession).toHaveBeenCalledWith('pkce-code')
    expect(res.headers.get('location') ?? '').not.toContain('/auth/email-change')
  })
})
