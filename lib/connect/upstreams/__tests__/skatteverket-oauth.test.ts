import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const fetchWithTimeout = vi.fn()
vi.mock('@/lib/http/fetch-with-timeout', () => ({
  fetchWithTimeout: (...a: unknown[]) => fetchWithTimeout(...a),
  OAUTH_TIMEOUT_MS: 10_000,
  SKATTEVERKET_EXCHANGE_TIMEOUT_MS: 8_000,
}))

import {
  buildSkvAuthorizeUrl,
  exchangeSkvCode,
  refreshSkvToken,
  SKV_API_BASES,
  skvGatewayHeaders,
} from '../skatteverket-oauth'

const ENV = ['SKATTEVERKET_OAUTH_BASE_URL', 'SKATTEVERKET_OAUTH2_CLIENT_ID', 'SKATTEVERKET_OAUTH2_CLIENT_SECRET', 'SKATTEVERKET_APIGW_CLIENT_ID', 'SKATTEVERKET_APIGW_CLIENT_SECRET'] as const

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SKATTEVERKET_OAUTH2_CLIENT_ID', 'oauth-client')
  vi.stubEnv('SKATTEVERKET_OAUTH2_CLIENT_SECRET', 'oauth-secret')
  vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_ID', 'gw-client')
  vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_SECRET', 'gw-secret')
})
afterEach(() => vi.unstubAllEnvs())

function tokenResponse(body: Record<string, unknown>, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body }
}

describe('buildSkvAuthorizeUrl', () => {
  it('carries the registered client id, the connector state, PKCE and the default scopes', () => {
    const u = new URL(buildSkvAuthorizeUrl('https://app.gnubok.se/cb', 'ck1.signed', { codeChallenge: 'chal' }))
    expect(u.searchParams.get('client_id')).toBe('oauth-client')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.gnubok.se/cb')
    expect(u.searchParams.get('state')).toBe('ck1.signed')
    expect(u.searchParams.get('code_challenge')).toBe('chal')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('scope')).toContain('agd')
    expect(u.searchParams.get('scope')).toContain('agdredovisningperiod')
  })
})

describe('token exchanges send the client secret and return tokens verbatim', () => {
  it('authorization_code', async () => {
    fetchWithTimeout.mockResolvedValue(tokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's' }))
    const t = await exchangeSkvCode('the-code', 'https://app.gnubok.se/cb', 'verifier')
    expect(t).toEqual({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's' })
    const body = fetchWithTimeout.mock.calls[0][1].body as string
    expect(body).toContain('grant_type=authorization_code')
    expect(body).toContain('client_secret=oauth-secret')
    expect(body).toContain('code_verifier=verifier')
  })

  it('refresh_token', async () => {
    fetchWithTimeout.mockResolvedValue(tokenResponse({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }))
    const t = await refreshSkvToken('rt')
    expect(t.access_token).toBe('at2')
    expect(fetchWithTimeout.mock.calls[0][1].body).toContain('grant_type=refresh_token')
  })

  it('throws on a non-ok token response', async () => {
    fetchWithTimeout.mockResolvedValue(tokenResponse({ error: 'invalid_grant' }, false, 400))
    await expect(exchangeSkvCode('c', 'https://x/cb')).rejects.toThrow(/token exchange failed \(400\)/)
  })
})

describe('data API allowlist + gateway headers', () => {
  it('exposes exactly the four backing services', () => {
    expect(Object.keys(SKV_API_BASES).sort()).toEqual(['agd-inlamning', 'agd-period', 'moms', 'skattekonto'])
  })
  it('adds Arcim gateway client credentials + a correlation id', () => {
    const h = skvGatewayHeaders()
    expect(h.Client_Id).toBe('gw-client')
    expect(h.Client_Secret).toBe('gw-secret')
    expect(h.skv_client_correlation_id).toMatch(/[0-9a-f-]{36}/)
  })
})
