import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

const signUpMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { signUp: signUpMock } })),
}))

const gateMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/brand-signup-gate', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/auth/brand-signup-gate')>()
  return {
    ...actual,
    evaluateBrandSignupGate: (...args: unknown[]) => gateMock(...args),
  }
})

import { POST } from '../route'

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://internal/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const validBody = { email: 'kund@example.com', password: 'Str0ng!Pass' }

beforeEach(() => {
  vi.clearAllMocks()
  gateMock.mockResolvedValue({ allowed: true, brand: null, via: 'no_brand' })
  signUpMock.mockResolvedValue({
    data: { user: { identities: [{ id: 'i1' }] }, session: null },
    error: null,
  })
})

describe('POST /api/auth/signup', () => {
  it('400s on invalid body', async () => {
    const res = await POST(makeRequest({ email: 'not-an-email', password: 'x' }))
    expect(res.status).toBe(400)
    expect(signUpMock).not.toHaveBeenCalled()
  })

  it('403s with signup_not_allowed when the gate blocks', async () => {
    gateMock.mockResolvedValue({ allowed: false, brand: { id: 'brand-1' } })

    const res = await POST(
      makeRequest(validBody, { host: 'ziffr.accounted.se' }),
    )
    const { body: json } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(res.status).toBe(403)
    expect(json.error.code).toBe('signup_not_allowed')
    expect(signUpMock).not.toHaveBeenCalled()
  })

  it('feeds the gate the forwarded host, normalized email and invite cookie', async () => {
    await POST(
      makeRequest(
        { ...validBody, email: '  Kund@Example.COM ' },
        {
          host: 'internal',
          'x-forwarded-host': 'ziffr.accounted.se',
          cookie: 'gnubok-invite-token=gnubok_inv_x',
        },
      ),
    )

    expect(gateMock).toHaveBeenCalledWith({
      host: 'ziffr.accounted.se',
      email: 'kund@example.com',
      inviteToken: 'gnubok_inv_x',
    })
  })

  it('signs up with a confirmation callback on the originating host', async () => {
    const res = await POST(
      makeRequest(validBody, {
        'x-forwarded-host': 'ziffr.accounted.se',
        'x-forwarded-proto': 'https',
      }),
    )
    const { body: json } = await parseJsonResponse<{ data: { status: string } }>(res)

    expect(res.status).toBe(200)
    expect(json.data.status).toBe('confirmation_sent')
    expect(signUpMock).toHaveBeenCalledWith({
      email: 'kund@example.com',
      password: 'Str0ng!Pass',
      options: {
        emailRedirectTo: 'https://ziffr.accounted.se/auth/callback',
      },
    })
  })

  it('forwards the captcha token and a safe next path', async () => {
    await POST(
      makeRequest(
        { ...validBody, captchaToken: 'tok', next: '/api/mcp-oauth/authorize?x=1' },
        { host: 'app.accounted.se' },
      ),
    )

    const call = signUpMock.mock.calls[0][0]
    expect(call.options.captchaToken).toBe('tok')
    expect(call.options.emailRedirectTo).toBe(
      'https://app.accounted.se/auth/callback?next=%2Fapi%2Fmcp-oauth%2Fauthorize%3Fx%3D1',
    )
  })

  it('drops an unsafe next path instead of forwarding it', async () => {
    await POST(
      makeRequest(
        { ...validBody, next: 'https://evil.example.com/phish' },
        { host: 'app.accounted.se' },
      ),
    )
    const call = signUpMock.mock.calls[0][0]
    expect(call.options.emailRedirectTo).toBe(
      'https://app.accounted.se/auth/callback',
    )
  })

  it('maps a GoTrue error to the canonical envelope', async () => {
    signUpMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: 'weak_password', message: 'Password is too weak', status: 422 },
    })

    const res = await POST(makeRequest(validBody, { host: 'app.accounted.se' }))
    const { body: json } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)

    expect(res.status).toBe(422)
    expect(json.error.code).toBe('weak_password')
  })

  it('reports duplicate for the obfuscated existing-account response', async () => {
    signUpMock.mockResolvedValue({
      data: { user: { identities: [] }, session: null },
      error: null,
    })

    const res = await POST(makeRequest(validBody, { host: 'app.accounted.se' }))
    const { body: json } = await parseJsonResponse<{ data: { status: string } }>(res)

    expect(json.data.status).toBe('duplicate')
  })

  it('reports session for auto-confirmed signups', async () => {
    signUpMock.mockResolvedValue({
      data: { user: { identities: [{ id: 'i1' }] }, session: { access_token: 'x' } },
      error: null,
    })

    const res = await POST(makeRequest(validBody, { host: 'app.accounted.se' }))
    const { body: json } = await parseJsonResponse<{ data: { status: string } }>(res)

    expect(json.data.status).toBe('session')
  })
})
