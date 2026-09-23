import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { exchangeCodeForTokens, refreshAccessToken } from '../lib/oauth'

const ENV_VARS = [
  'SKATTEVERKET_OAUTH2_CLIENT_ID',
  'SKATTEVERKET_OAUTH2_CLIENT_SECRET',
  'SKATTEVERKET_APIGW_CLIENT_ID',
  'SKATTEVERKET_OAUTH_BASE_URL',
  'GNUBOK_CONNECTOR_KEY',
  'GNUBOK_CONNECT_URL',
]

beforeEach(() => {
  for (const v of ENV_VARS) delete process.env[v]
  process.env.GNUBOK_CONNECTOR_KEY = 'gnubok_ck_test'
  process.env.GNUBOK_CONNECT_URL = 'https://app.hosted.example'
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

describe('exchangeCodeForTokens: connector mode', () => {
  it('exchanges through the broker and maps the { data } envelope to SkatteverketTokens', async () => {
    const before = Date.now()
    const fetchMock = mockFetchJson(200, {
      data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'momsdeklaration ska' },
    })

    const tokens = await exchangeCodeForTokens(
      'auth-code',
      'https://app.hosted.example/api/extensions/ext/skatteverket/callback',
      'verifier-1',
      'signed-cs',
    )

    expect(tokens.access_token).toBe('at')
    expect(tokens.refresh_token).toBe('rt')
    expect(tokens.refresh_count).toBe(0)
    expect(tokens.scope).toBe('momsdeklaration ska')
    expect(tokens.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://app.hosted.example/api/connect/skv/oauth/token')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gnubok_ck_test')
    const body = JSON.parse(init.body as string)
    expect(body.grant_type).toBe('authorization_code')
    expect(body.connector_state).toBe('signed-cs')
    expect(body.code_verifier).toBe('verifier-1')
    // client_id/client_secret must never leave the instance: it has none.
    expect(init.body as string).not.toMatch(/client_id|client_secret/)
  })

  it('refuses to exchange without a connector_state (flow predates connector mode)', async () => {
    const fetchMock = mockFetchJson(200, { data: { access_token: 'at' } })
    await expect(
      exchangeCodeForTokens('auth-code', 'https://x.example/cb', 'verifier-1'),
    ).rejects.toThrow(/connector_state saknas/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('refreshAccessToken: connector mode', () => {
  it('refreshes through the broker, increments refresh_count, unwraps { data }', async () => {
    const fetchMock = mockFetchJson(200, {
      data: { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600, scope: 's' },
    })

    const tokens = await refreshAccessToken('rt1', 3)

    expect(tokens.access_token).toBe('at2')
    expect(tokens.refresh_token).toBe('rt2')
    expect(tokens.refresh_count).toBe(4)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://app.hosted.example/api/connect/skv/oauth/token')
    expect(JSON.parse(init.body as string)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt1',
    })
  })
})

describe('direct path unchanged when own credentials disable connector mode', () => {
  it('exchanges directly against SKV with client credentials in the form body', async () => {
    process.env.SKATTEVERKET_OAUTH2_CLIENT_ID = 'own-client'
    process.env.SKATTEVERKET_OAUTH2_CLIENT_SECRET = 'own-secret'
    const fetchMock = mockFetchJson(200, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      scope: 'momsdeklaration',
    })

    // The trailing connectorState arg is ignored on the direct path: an
    // own-credentials instance exchanges with SKV even if a stale
    // oauth_connector_state row survived a credentials change.
    const tokens = await exchangeCodeForTokens('auth-code', 'https://x.example/cb', 'v1', 'stale-cs')
    expect(tokens.access_token).toBe('at')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://peroauth2.test.skatteverket.se/oauth2/v1/per/token')
    const body = init.body as string
    expect(body).toContain('client_id=own-client')
    expect(body).toContain('client_secret=own-secret')
    expect(body).not.toContain('connector_state')
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('refreshes directly against SKV', async () => {
    process.env.SKATTEVERKET_OAUTH2_CLIENT_ID = 'own-client'
    process.env.SKATTEVERKET_OAUTH2_CLIENT_SECRET = 'own-secret'
    const fetchMock = mockFetchJson(200, {
      access_token: 'at2',
      refresh_token: 'rt2',
      expires_in: 3600,
    })

    const tokens = await refreshAccessToken('rt1', 0)
    expect(tokens.refresh_count).toBe(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://peroauth2.test.skatteverket.se/oauth2/v1/per/token')
    expect(init.body as string).toContain('grant_type=refresh_token')
    expect(init.body as string).toContain('client_id=own-client')
  })
})
