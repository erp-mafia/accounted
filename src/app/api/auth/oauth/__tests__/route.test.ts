import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

const oauthMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { signInWithOAuth: oauthMock } })),
}))

vi.mock('@/lib/auth/rate-limit-http', () => ({
  checkRateLimit: vi.fn(async () => ({ ok: true })),
}))

const resolveBrandMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandResultByHost: (...args: unknown[]) => resolveBrandMock(...args),
}))

import { POST } from '../route'

function makeRequest(body: unknown, host = 'app.accounted.se'): Request {
  return new Request(`https://${host}/api/auth/oauth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin', host },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
  resolveBrandMock.mockImplementation(async (host: string) => ({
    brand: host === 'bok.partner.se' ? { domain: 'bok.partner.se' } : null,
    lookupFailed: false,
  }))
  oauthMock.mockResolvedValue({
    data: { provider: 'google', url: 'https://project.supabase.co/auth/v1/authorize?provider=google' },
    error: null,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/auth/oauth', () => {
  it('400s on a malformed provider id', async () => {
    const res = await POST(makeRequest({ provider: '../../etc' }))
    expect(res.status).toBe(400)
    expect(oauthMock).not.toHaveBeenCalled()
  })

  it('starts the flow server-side (no browser redirect) and returns the provider URL', async () => {
    const res = await POST(makeRequest({ provider: 'google', next: '/api/mcp-oauth/authorize?client_id=x' }))
    const { body } = await parseJsonResponse<{ data: { url: string } }>(res)

    expect(res.status).toBe(200)
    expect(body.data.url).toContain('/auth/v1/authorize?provider=google')
    const args = oauthMock.mock.calls[0][0] as { provider: string; options: { redirectTo: string; skipBrowserRedirect: boolean } }
    expect(args.provider).toBe('google')
    expect(args.options.skipBrowserRedirect).toBe(true)
    const redirect = new URL(args.options.redirectTo)
    expect(redirect.origin).toBe('https://app.accounted.se')
    expect(redirect.pathname).toBe('/auth/callback')
    expect(redirect.searchParams.get('flow')).toBe('oauth')
    expect(redirect.searchParams.get('next')).toBe('/api/mcp-oauth/authorize?client_id=x')
  })

  it('returns to the brand host a white-label user started on', async () => {
    await POST(makeRequest({ provider: 'google' }, 'bok.partner.se'))
    const args = oauthMock.mock.calls[0][0] as { options: { redirectTo: string } }
    expect(new URL(args.options.redirectTo).origin).toBe('https://bok.partner.se')
    expect(new URL(args.options.redirectTo).searchParams.has('next')).toBe(false)
  })

  it("passes GoTrue's refusal through (provider not enabled)", async () => {
    oauthMock.mockResolvedValue({ data: { url: null }, error: { code: 'validation_failed', status: 400, message: 'Unsupported provider' } })
    const res = await POST(makeRequest({ provider: 'github' }))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })
})
