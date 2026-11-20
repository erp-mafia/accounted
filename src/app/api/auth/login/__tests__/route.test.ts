import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

const signInMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { signInWithPassword: signInMock } })),
}))

const rateLimitMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/rate-limit-http', () => ({
  checkRateLimit: (...args: unknown[]) => rateLimitMock(...args),
}))

import { POST } from '../route'

function jwtWithAal(aal: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: 'user-1', aal })).toString('base64url')
  return `header.${payload}.signature`
}

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://app.accounted.se/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'sec-fetch-site': 'same-origin',
      host: 'app.accounted.se',
      'x-forwarded-for': '203.0.113.7',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const validBody = { email: 'Kund@Example.com', password: 'hunter2hunter2', captchaToken: 'cf-token' }

beforeEach(() => {
  vi.clearAllMocks()
  rateLimitMock.mockResolvedValue({ ok: true })
  signInMock.mockResolvedValue({
    data: {
      user: { id: 'user-1', factors: [] },
      session: { access_token: jwtWithAal('aal1') },
    },
    error: null,
  })
})

describe('POST /api/auth/login', () => {
  it('refuses a non-JSON body (a cross-site form post cannot sign anyone in)', async () => {
    const res = await POST(makeRequest('email=a&password=b', { 'Content-Type': 'application/x-www-form-urlencoded' }))
    expect(res.status).toBe(415)
    expect(signInMock).not.toHaveBeenCalled()
  })

  it('refuses a cross-site request', async () => {
    const res = await POST(makeRequest(validBody, { 'sec-fetch-site': 'cross-site' }))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('cross_site_request')
    expect(signInMock).not.toHaveBeenCalled()
  })

  it('refuses a foreign Origin when the browser sends no Sec-Fetch-Site', async () => {
    const res = await POST(
      makeRequest(validBody, { 'sec-fetch-site': '', origin: 'https://evil.example' }),
    )
    expect(res.status).toBe(403)
  })

  it('400s on an invalid body', async () => {
    const res = await POST(makeRequest({ email: 'not-an-email', password: '' }))
    expect(res.status).toBe(400)
    expect(signInMock).not.toHaveBeenCalled()
  })

  it('429s with a rate_limited code when a limit trips', async () => {
    rateLimitMock.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false })
    const res = await POST(makeRequest(validBody))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(res.status).toBe(429)
    expect(body.error.code).toBe('over_request_rate_limit')
    expect(signInMock).not.toHaveBeenCalled()
    // One limit per network, one per (hashed) address.
    const prefixes = rateLimitMock.mock.calls.map((call) => (call[0] as { prefix: string }).prefix)
    expect(prefixes).toEqual(['auth:login:net', 'auth:login:email'])
    const emailKey = (rateLimitMock.mock.calls[1][0] as { identifier: string }).identifier
    expect(emailKey).not.toContain('@')
  })

  it("passes GoTrue's refusal through with its code, so the page can classify it", async () => {
    signInMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' },
    })
    const res = await POST(makeRequest(validBody))
    const { body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('invalid_credentials')
    expect(res.cookies.get('gnubok-auth-method')).toBeUndefined()
  })

  it('signs in, forwards the captcha, and records the method in an HttpOnly hint', async () => {
    const res = await POST(makeRequest(validBody))
    const { body } = await parseJsonResponse<{ data: { mfaRequired: boolean } }>(res)

    expect(res.status).toBe(200)
    expect(body.data.mfaRequired).toBe(false)
    expect(signInMock).toHaveBeenCalledWith({
      email: 'kund@example.com',
      password: 'hunter2hunter2',
      options: { captchaToken: 'cf-token' },
    })
    const hint = res.cookies.get('gnubok-auth-method')
    expect(hint?.value).toBe('password')
    expect(hint?.httpOnly).toBe(true)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('answers mfaRequired when the account has a verified factor and the session is AAL1', async () => {
    signInMock.mockResolvedValue({
      data: {
        user: { id: 'user-1', factors: [{ id: 'f1', status: 'verified', factor_type: 'totp' }] },
        session: { access_token: jwtWithAal('aal1') },
      },
      error: null,
    })
    const res = await POST(makeRequest(validBody))
    const { body } = await parseJsonResponse<{ data: { mfaRequired: boolean } }>(res)
    expect(body.data.mfaRequired).toBe(true)
  })
})
