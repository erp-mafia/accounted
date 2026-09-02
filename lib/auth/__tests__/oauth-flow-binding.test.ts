import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

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

  it('falls back to the request origin when NEXT_PUBLIC_APP_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')

    const response = buildLoginRedirect(
      new Request('http://localhost:3000/api/extensions/woocommerce/return?success=1&user_id=abc'),
    )

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?next=' +
        encodeURIComponent('/api/extensions/woocommerce/return?success=1&user_id=abc'),
    )
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
