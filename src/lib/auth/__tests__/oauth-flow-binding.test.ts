import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

// The trusted-origin resolver reads the brands table; books.partner.example
// is the one registered brand host in these tests.
const resolveBrandResultByHostMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandResultByHost: (...args: unknown[]) => resolveBrandResultByHostMock(...args),
}))
function registerBrandHost(host: string | null) {
  resolveBrandResultByHostMock.mockImplementation(async (candidate: string) => ({
    brand: host !== null && candidate === host ? { domain: host } : null,
    lookupFailed: false,
  }))
}
registerBrandHost('books.partner.example')

import { createClient } from '@/lib/supabase/server'
import {
  requireFlowInitiator,
  buildLoginRedirect,
  redactUserId,
  FLOW_INITIATOR_MISMATCH_MESSAGE,
} from '../oauth-flow-binding'

const CALLBACK_URL =
  'https://app.example.se/api/extensions/stripe/callback?code=ac_123&state=state-1'

function mockSession(getUser: ReturnType<typeof vi.fn>) {
  vi.mocked(createClient).mockResolvedValue({ auth: { getUser } } as never)
  return getUser
}

function sessionWith(userId: string | null, error: unknown = null) {
  return mockSession(
    vi.fn().mockResolvedValue({
      data: { user: userId ? { id: userId } : null },
      error,
    }),
  )
}

describe('requireFlowInitiator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.se')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('passes when the cookie session belongs to the initiator', async () => {
    const getUser = sessionWith('user-1')

    const result = await requireFlowInitiator(new Request(CALLBACK_URL), 'user-1')

    expect(result).toEqual({ ok: true, userId: 'user-1' })
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  it('refuses with a 403 envelope when a different user completes the flow', async () => {
    sessionWith('user-2')

    const result = await requireFlowInitiator(new Request(CALLBACK_URL), 'user-1', {
      flow: 'stripe.callback',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('mismatch')
    if (result.reason !== 'mismatch') throw new Error('unreachable')
    expect(result.sessionUserId).toBe('user-2')
    expect(result.response.status).toBe(403)
    const body = await result.response.json()
    expect(body.error.code).toBe('OAUTH_FLOW_INITIATOR_MISMATCH')
    expect(body.error.message).toBe(FLOW_INITIATOR_MISMATCH_MESSAGE)
    expect(typeof body.error.message_en).toBe('string')
  })

  it('sends an anonymous browser to /login with the callback URL as next', async () => {
    sessionWith(null)

    const result = await requireFlowInitiator(new Request(CALLBACK_URL), 'user-1')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('no_session')
    expect(result.response.status).toBe(307)
    const location = new URL(result.response.headers.get('location') ?? '')
    expect(location.origin).toBe('https://app.example.se')
    expect(location.pathname).toBe('/login')
    // Same-origin relative path + query, the only shape the login page's
    // safeReturnTo accepts, so signing in resumes the very same callback.
    expect(location.searchParams.get('next')).toBe(
      '/api/extensions/stripe/callback?code=ac_123&state=state-1',
    )
  })

  it('sends an anonymous browser to the recorded brand origin when the caller passes one', async () => {
    // Provider redirect URIs are pinned to the canonical host while sessions
    // are per host: a white-label user reaches the callback signed out and
    // must be sent to THEIR brand login, where the session already exists.
    sessionWith(null)

    const result = await requireFlowInitiator(new Request(CALLBACK_URL), 'user-1', {
      returnOrigin: 'https://books.partner.example',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('no_session')
    const location = new URL(result.response.headers.get('location') ?? '')
    expect(location.origin).toBe('https://books.partner.example')
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('next')).toBe(
      '/api/extensions/stripe/callback?code=ac_123&state=state-1',
    )
  })

  it('treats a getUser error as no session (fail closed)', async () => {
    sessionWith(null, { message: 'invalid JWT' })

    const result = await requireFlowInitiator(new Request(CALLBACK_URL), 'user-1')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('no_session')
  })

  it('treats a thrown client error as no session instead of finalizing on a guess', async () => {
    vi.mocked(createClient).mockRejectedValue(new Error('cookies() outside request scope'))

    const result = await requireFlowInitiator(new Request(CALLBACK_URL), 'user-1')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('no_session')
    expect(result.response.headers.get('location')).toContain('/login?next=')
  })

  it('never passes on an empty expected id even when someone is signed in', async () => {
    sessionWith('user-2')

    const result = await requireFlowInitiator(new Request(CALLBACK_URL), '')

    expect(result.ok).toBe(false)
  })
})

describe('buildLoginRedirect', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('falls back to the request origin when NEXT_PUBLIC_APP_URL is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')

    const response = await buildLoginRedirect(
      new Request('http://localhost:3000/api/extensions/woocommerce/return?success=1&user_id=abc'),
    )

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?next=' +
        encodeURIComponent('/api/extensions/woocommerce/return?success=1&user_id=abc'),
    )
  })

  it('uses a recorded origin only when it is the canonical host or a registered white-label host', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.se')
    const request = new Request('https://app.example.se/api/extensions/stripe/callback?code=1&state=2')

    const brand = await buildLoginRedirect(request, 'https://books.partner.example')
    expect(new URL(brand.headers.get('location') ?? '').origin).toBe('https://books.partner.example')

    // A stored value that is no longer (or never was) registered must not
    // become a redirect target: the allowlist is the only authority.
    const unknown = await buildLoginRedirect(request, 'https://evil.example')
    expect(new URL(unknown.headers.get('location') ?? '').origin).toBe('https://app.example.se')

    const canonical = await buildLoginRedirect(request, 'https://app.example.se')
    expect(new URL(canonical.headers.get('location') ?? '').origin).toBe('https://app.example.se')
  })

  it('keeps a callback that arrived on a registered brand host on that host', async () => {
    // NEXT_PUBLIC_APP_URL used to win over the request origin here, dragging
    // a brand-domain callback to the canonical login. The allowlisted request
    // host is the fallback now; an unregistered host still collapses.
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.se')

    const onBrand = await buildLoginRedirect(
      new Request('https://books.partner.example/api/extensions/stripe/callback?code=1&state=2'),
    )
    expect(new URL(onBrand.headers.get('location') ?? '').origin).toBe('https://books.partner.example')

    const onUnknown = await buildLoginRedirect(
      new Request('https://evil.example/api/extensions/stripe/callback?code=1&state=2'),
    )
    expect(new URL(onUnknown.headers.get('location') ?? '').origin).toBe('https://app.example.se')
  })
})

describe('redactUserId', () => {
  it('keeps only a correlation prefix of a uuid', () => {
    expect(redactUserId('123e4567-e89b-12d3-a456-426614174000')).toBe('123e4567...')
  })

  it('handles short and missing ids', () => {
    expect(redactUserId('user-1')).toBe('user-1')
    expect(redactUserId(null)).toBe('(none)')
    expect(redactUserId(undefined)).toBe('(none)')
  })
})
