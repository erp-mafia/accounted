import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

const anonMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { signInAnonymously: anonMock } })),
}))

const rateLimitMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/rate-limit-http', () => ({
  checkRateLimit: (...args: unknown[]) => rateLimitMock(...args),
}))

import { POST } from '../route'

function makeRequest(body: unknown): Request {
  return new Request('https://app.accounted.se/api/auth/anonymous', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  rateLimitMock.mockResolvedValue({ ok: true })
  anonMock.mockResolvedValue({ data: { user: { id: 'anon-1' }, session: { access_token: 't' } }, error: null })
})

describe('POST /api/auth/anonymous', () => {
  it('400s on an oversized captcha token', async () => {
    const res = await POST(makeRequest({ captchaToken: 'x'.repeat(5000) }))
    expect(res.status).toBe(400)
  })

  it('signs in anonymously with the forwarded captcha token', async () => {
    const res = await POST(makeRequest({ captchaToken: 'cf' }))
    expect(res.status).toBe(200)
    expect(anonMock).toHaveBeenCalledWith({ options: { captchaToken: 'cf' } })
  })

  it('429s past the per-network limit', async () => {
    rateLimitMock.mockResolvedValue({ ok: false })
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(429)
    expect(anonMock).not.toHaveBeenCalled()
  })

  it("passes GoTrue's refusal through", async () => {
    anonMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: 'captcha_failed', status: 400, message: 'captcha protection: request disallowed' },
    })
    const res = await POST(makeRequest({ captchaToken: 'bad' }))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('captcha_failed')
  })
})
