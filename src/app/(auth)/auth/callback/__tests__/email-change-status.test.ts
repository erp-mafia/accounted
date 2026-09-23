import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// The email_change branch returns before any of the invite/team/landing
// machinery runs; these mocks only keep the module importable in the test
// environment.
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
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      verifyOtp: (...args: unknown[]) => verifyOtp(...args),
      exchangeCodeForSession: vi.fn(),
      getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
    },
  }),
}))

import { GET } from '../route'

function makeRequest(params: Record<string, string>) {
  const url = new URL('https://app.testbrand.example/auth/callback')
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return new NextRequest(url)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /auth/callback type=email_change', () => {
  it('redirects a first confirmation (no session) to the partial status page', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    })

    const res = await GET(makeRequest({ token_hash: 'th', type: 'email_change' }))

    expect(res.headers.get('location')).toBe(
      'https://app.testbrand.example/auth/email-change?status=partial',
    )
    expect(verifyOtp).toHaveBeenCalledWith({
      token_hash: 'th',
      type: 'email_change',
    })
  })

  it('redirects the completing confirmation (session minted) to the done status page', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: { id: 'u1' }, session: { access_token: 'at' } },
      error: null,
    })

    const res = await GET(makeRequest({ token_hash: 'th', type: 'email_change' }))

    expect(res.headers.get('location')).toBe(
      'https://app.testbrand.example/auth/email-change?status=done',
    )
  })

  it('redirects an invalid or expired link to the failed status page', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Email link is invalid or has expired' },
    })

    const res = await GET(makeRequest({ token_hash: 'th', type: 'email_change' }))

    expect(res.headers.get('location')).toBe(
      'https://app.testbrand.example/auth/email-change?status=failed',
    )
  })

  it('keeps the generic login-error redirect for other failed types', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Email link is invalid or has expired' },
    })

    const res = await GET(makeRequest({ token_hash: 'th', type: 'signup' }))

    const location = res.headers.get('location') ?? ''
    expect(location).toContain('/login?error=auth_error')
    expect(location).not.toContain('/auth/email-change')
  })
})
