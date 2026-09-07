import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

const resetPasswordForEmailMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { resetPasswordForEmail: resetPasswordForEmailMock },
  })),
}))

const resolveBrandResultByHostMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandResultByHost: (...args: unknown[]) => resolveBrandResultByHostMock(...args),
}))

import { POST } from '../route'

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://internal/api/auth/password-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.test'
  resetPasswordForEmailMock.mockResolvedValue({ data: {}, error: null })
  resolveBrandResultByHostMock.mockImplementation(async (host: string) => ({
    brand: host === 'app.testbrand.example' ? { domain: host } : null,
    lookupFailed: false,
  }))
})

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL
})

describe('POST /api/auth/password-reset', () => {
  it('400s on invalid body', async () => {
    const res = await POST(makeRequest({ email: 'not-an-email' }))
    expect(res.status).toBe(400)
    expect(resetPasswordForEmailMock).not.toHaveBeenCalled()
  })

  it('sends the recovery callback on a registered brand host', async () => {
    const res = await POST(
      makeRequest(
        { email: '  Kund@Example.COM ', captchaToken: 'tok' },
        { host: 'internal', 'x-forwarded-host': 'app.testbrand.example' },
      ),
    )
    const { body: json } = await parseJsonResponse<{ data: { status: string } }>(res)

    expect(res.status).toBe(200)
    expect(json.data.status).toBe('sent')
    expect(resetPasswordForEmailMock).toHaveBeenCalledWith('kund@example.com', {
      redirectTo: 'https://app.testbrand.example/auth/callback?next=/reset-password',
      captchaToken: 'tok',
    })
  })

  it('falls back to the canonical callback for an unregistered host', async () => {
    await POST(makeRequest({ email: 'kund@example.com' }, { host: 'attacker.test' }))

    expect(resetPasswordForEmailMock).toHaveBeenCalledWith('kund@example.com', {
      redirectTo: 'https://app.accounted.test/auth/callback?next=/reset-password',
    })
  })

  it('503s (fail safe) when the brand lookup errors, without calling GoTrue', async () => {
    resolveBrandResultByHostMock.mockResolvedValue({ brand: null, lookupFailed: true })

    const res = await POST(
      makeRequest({ email: 'kund@example.com' }, { host: 'app.testbrand.example' }),
    )
    const { body: json } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(res.status).toBe(503)
    expect(json.error.code).toBe('brand_lookup_failed')
    expect(resetPasswordForEmailMock).not.toHaveBeenCalled()
  })

  it('maps a GoTrue error to the canonical envelope with its status', async () => {
    resetPasswordForEmailMock.mockResolvedValue({
      data: null,
      error: { code: 'over_email_send_rate_limit', message: 'rate limit', status: 429 },
    })

    const res = await POST(makeRequest({ email: 'kund@example.com' }, { host: 'app.accounted.test' }))
    const { body: json } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)

    expect(res.status).toBe(429)
    expect(json.error.code).toBe('over_email_send_rate_limit')
    expect(json.error.message).toBeTruthy()
  })
})
