import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken } from '../lib/oauth'
import { skvDefaultScopes } from '@/lib/connect/upstreams/skatteverket-oauth'

/**
 * The direct (non-connector) per flow carries Arcim's client_secret plus the
 * code or refresh token. It runs through the core helpers in
 * lib/connect/upstreams/skatteverket-oauth.ts: https-only base URL and
 * redirect 'error', so a 307/308 or a plaintext override never ships the
 * credentials elsewhere.
 */

const ENV_VARS = [
  'SKATTEVERKET_OAUTH2_CLIENT_ID',
  'SKATTEVERKET_OAUTH2_CLIENT_SECRET',
  'SKATTEVERKET_OAUTH_BASE_URL',
  'GNUBOK_CONNECTOR_KEY',
  'GNUBOK_CONNECT_URL',
]

// Pinned byte for byte: SKV grants per scope token, and every one here was
// added after a live filing broke without it (see the core helper).
const EXPECTED_SCOPES = 'momsdeklaration inkforetag skahmst skattekonto ska agd agdredovisningperiod'

beforeEach(() => {
  for (const v of ENV_VARS) delete process.env[v]
  process.env.SKATTEVERKET_OAUTH2_CLIENT_ID = 'cid'
  process.env.SKATTEVERKET_OAUTH2_CLIENT_SECRET = 'csecret'
  vi.restoreAllMocks()
})

afterEach(() => {
  for (const v of ENV_VARS) delete process.env[v]
})

function mockFetchJson(status: number, json: unknown) {
  const mock = vi.fn(async () => new Response(JSON.stringify(json), { status }))
  global.fetch = mock as unknown as typeof fetch
  return mock
}

describe('Skatteverket per flow: direct path', () => {
  it('requests the scope string byte-identical to the core default', () => {
    const url = new URL(buildAuthorizeUrl('https://app.example/callback', 'state-1'))
    expect(url.searchParams.get('scope')).toBe(EXPECTED_SCOPES)
    expect(skvDefaultScopes()).toBe(EXPECTED_SCOPES)
  })

  it('exchanges the code with redirect "error"', async () => {
    const fetchMock = mockFetchJson(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 })

    const tokens = await exchangeCodeForTokens('code-1', 'https://app.example/callback', 'verifier-1')

    expect(tokens.access_token).toBe('at')
    expect(tokens.refresh_count).toBe(0)
    expect(tokens.scope).toBe(EXPECTED_SCOPES)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://peroauth2.test.skatteverket.se/oauth2/v1/per/token')
    expect(init.redirect).toBe('error')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('client_secret')).toBe('csecret')
    expect(body.get('code_verifier')).toBe('verifier-1')
  })

  it('refreshes with redirect "error" and counts the refresh', async () => {
    const fetchMock = mockFetchJson(200, { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 })

    const tokens = await refreshAccessToken('rt1', 2)

    expect(tokens.access_token).toBe('at2')
    expect(tokens.refresh_token).toBe('rt2')
    expect(tokens.refresh_count).toBe(3)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.redirect).toBe('error')
  })

  it('keeps the error message the dead-refresh classifier reads', async () => {
    mockFetchJson(404, { error: 'id_not_found' })
    await expect(refreshAccessToken('rt1', 0)).rejects.toThrow(
      /^Skatteverket token refresh failed \(404\): .*id_not_found/,
    )
  })

  it('refuses a plaintext OAuth base URL before sending any credential', async () => {
    process.env.SKATTEVERKET_OAUTH_BASE_URL = 'http://oauth.example/per'
    const fetchMock = mockFetchJson(200, { access_token: 'at' })

    expect(() => buildAuthorizeUrl('https://app.example/callback', 'state-1')).toThrow(/https/)
    await expect(exchangeCodeForTokens('code-1', 'https://app.example/callback')).rejects.toThrow(/https/)
    await expect(refreshAccessToken('rt1', 0)).rejects.toThrow(/https/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
