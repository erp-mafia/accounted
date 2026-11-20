import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

const ssoMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { signInWithSSO: ssoMock } })),
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
  return new Request(`https://${host}/api/auth/sso`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin', host },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
  vi.stubEnv('NEXT_PUBLIC_SSO_PROVIDER_ID', '')
  vi.stubEnv('NEXT_PUBLIC_SSO_DOMAIN', 'bolaget.se')
  resolveBrandMock.mockResolvedValue({ brand: null, lookupFailed: false })
  ssoMock.mockResolvedValue({ data: { url: 'https://idp.example/saml?x=1' }, error: null })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/auth/sso', () => {
  it('400s with sso_not_configured when no provider is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SSO_DOMAIN', '')
    const res = await POST(makeRequest({ next: '/' }))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('sso_not_configured')
    expect(ssoMock).not.toHaveBeenCalled()
  })

  it('starts the flow on the trusted origin and returns the IdP URL', async () => {
    const res = await POST(makeRequest({ next: '/invoices' }))
    const { body } = await parseJsonResponse<{ data: { url: string } }>(res)

    expect(res.status).toBe(200)
    expect(body.data.url).toBe('https://idp.example/saml?x=1')
    expect(ssoMock).toHaveBeenCalledWith({
      domain: 'bolaget.se',
      options: { redirectTo: 'https://app.accounted.se/auth/callback?flow=oauth&next=%2Finvoices' },
    })
  })

  it('prefers an explicit provider id and drops an off-origin next', async () => {
    vi.stubEnv('NEXT_PUBLIC_SSO_PROVIDER_ID', 'provider-123')
    await POST(makeRequest({ next: 'https://evil.example/' }))
    expect(ssoMock).toHaveBeenCalledWith({
      providerId: 'provider-123',
      options: { redirectTo: 'https://app.accounted.se/auth/callback?flow=oauth&next=%2F' },
    })
  })

  it('503s when the brand registry cannot be read', async () => {
    resolveBrandMock.mockResolvedValue({ brand: null, lookupFailed: true })
    const res = await POST(makeRequest({ next: '/' }, 'bok.partner.se'))
    expect(res.status).toBe(503)
  })
})
