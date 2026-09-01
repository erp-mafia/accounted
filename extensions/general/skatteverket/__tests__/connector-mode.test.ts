import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  baseUrlToService,
  parseConnectorCode,
  startConnectorAuthorization,
  exchangeConnectorCode,
  refreshConnectorToken,
  skatteverketConnectorMode,
} from '../lib/connector-mode'

const CONNECTOR = { baseUrl: 'https://app.hosted.example/api/connect/skv', key: 'gnubok_ck_test' }

const SKV_ENV_VARS = [
  'SKATTEVERKET_API_BASE_URL',
  'SKATTEVERKET_SKATTEKONTO_API_BASE_URL',
  'SKATTEVERKET_AGD_INLAMNING_API_BASE_URL',
  'SKATTEVERKET_AGD_PERIOD_API_BASE_URL',
  'SKATTEVERKET_OAUTH2_CLIENT_ID',
  'SKATTEVERKET_APIGW_CLIENT_ID',
  'GNUBOK_CONNECTOR_KEY',
  'GNUBOK_CONNECT_URL',
]

beforeEach(() => {
  for (const v of SKV_ENV_VARS) delete process.env[v]
})

afterEach(() => {
  for (const v of SKV_ENV_VARS) delete process.env[v]
  vi.restoreAllMocks()
})

function mockFetchJson(status: number, json: unknown) {
  const mock = vi.fn(async () => new Response(JSON.stringify(json), { status }))
  global.fetch = mock as unknown as typeof fetch
  return mock
}

describe('baseUrlToService', () => {
  // The proxy's allowlist has exactly these four segments; the map must pin
  // every default (test AND prod) so an unset-env instance and a
  // prod-configured one both route to the same service.
  it.each([
    ['https://api.test.skatteverket.se/momsdeklaration/v1', 'moms'],
    ['https://api.skatteverket.se/momsdeklaration/v1', 'moms'],
    ['https://api.test.skatteverket.se/beskattning/skattekonto/v2', 'skattekonto'],
    ['https://api.skatteverket.se/beskattning/skattekonto/v2', 'skattekonto'],
    ['https://api.test.skatteverket.se/arbetsgivardeklaration/inlamning/v1', 'agd-inlamning'],
    ['https://api.skatteverket.se/arbetsgivardeklaration/inlamning/v1', 'agd-inlamning'],
    ['https://api.test.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1', 'agd-period'],
    ['https://api.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1', 'agd-period'],
  ])('maps %s → %s', (base, service) => {
    expect(baseUrlToService(base)).toBe(service)
  })

  it('maps an env-overridden base URL to its service by env-var identity', () => {
    process.env.SKATTEVERKET_AGD_PERIOD_API_BASE_URL = 'https://mock.example/agd-hantera'
    expect(baseUrlToService('https://mock.example/agd-hantera')).toBe('agd-period')
  })

  it('ignores a trailing slash', () => {
    expect(baseUrlToService('https://api.test.skatteverket.se/momsdeklaration/v1/')).toBe('moms')
  })

  it('throws loudly on an unmapped base instead of proxying to the wrong service', () => {
    expect(() => baseUrlToService('https://api.test.skatteverket.se/nagot-annat/v1')).toThrow(
      /Okänd Skatteverket-tjänst/,
    )
  })
})

describe('parseConnectorCode', () => {
  it('reads a CONNECTOR_* code from a broker error body', () => {
    expect(parseConnectorCode('{"error":"x","code":"CONNECTOR_KEY_INVALID"}')).toBe(
      'CONNECTOR_KEY_INVALID',
    )
  })

  it('ignores non-connector codes and non-JSON bodies', () => {
    expect(parseConnectorCode('{"error":"invalid_scope","code":"MISSING_SCOPE"}')).toBeNull()
    expect(parseConnectorCode('The required scopes are not authorized')).toBeNull()
    expect(parseConnectorCode('')).toBeNull()
  })
})

describe('skatteverketConnectorMode (re-export sanity)', () => {
  it('is null without a key, non-null with a key and no own credentials', () => {
    expect(skatteverketConnectorMode()).toBeNull()
    process.env.GNUBOK_CONNECTOR_KEY = 'gnubok_ck_test'
    process.env.GNUBOK_CONNECT_URL = 'https://app.hosted.example'
    expect(skatteverketConnectorMode()).toEqual(CONNECTOR)
  })
})

describe('startConnectorAuthorization', () => {
  it('POSTs the broker contract and unwraps { data }', async () => {
    const fetchMock = mockFetchJson(200, {
      data: {
        authorize_url: 'https://peroauth2.test.skatteverket.se/oauth2/v1/per/authorize?x=1',
        redirect_uri: 'https://app.hosted.example/api/extensions/ext/skatteverket/callback',
        connector_state: 'signed-cs',
      },
    })

    const started = await startConnectorAuthorization(CONNECTOR, {
      companyRef: 'company-1',
      returnUrl: 'https://instans.example.se/api/extensions/ext/skatteverket/callback',
      state: 'inst-state',
      codeChallenge: 'challenge-1234567890',
    })

    expect(started).toEqual({
      authorizeUrl: 'https://peroauth2.test.skatteverket.se/oauth2/v1/per/authorize?x=1',
      redirectUri: 'https://app.hosted.example/api/extensions/ext/skatteverket/callback',
      connectorState: 'signed-cs',
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://app.hosted.example/api/connect/skv/oauth/authorize-url')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gnubok_ck_test')
    expect(JSON.parse(init.body as string)).toEqual({
      company_ref: 'company-1',
      return_url: 'https://instans.example.se/api/extensions/ext/skatteverket/callback',
      state: 'inst-state',
      code_challenge: 'challenge-1234567890',
    })
  })

  it('throws with status + body on a broker refusal (quota, key)', async () => {
    mockFetchJson(403, { error: 'quota', code: 'CONNECTOR_QUOTA_EXCEEDED' })
    await expect(
      startConnectorAuthorization(CONNECTOR, {
        companyRef: 'c',
        returnUrl: 'https://i.example/cb',
        state: 's',
        codeChallenge: 'challenge-1234567890',
      }),
    ).rejects.toThrow(/403[\s\S]*CONNECTOR_QUOTA_EXCEEDED/)
  })

  it('throws on a malformed broker response', async () => {
    mockFetchJson(200, { data: { authorize_url: 'https://x.example' } })
    await expect(
      startConnectorAuthorization(CONNECTOR, {
        companyRef: 'c',
        returnUrl: 'https://i.example/cb',
        state: 's',
        codeChallenge: 'challenge-1234567890',
      }),
    ).rejects.toThrow(/oväntat svar/)
  })
})

describe('exchangeConnectorCode / refreshConnectorToken', () => {
  it('sends the authorization_code grant with connector_state and no client credentials', async () => {
    const fetchMock = mockFetchJson(200, {
      data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'momsdeklaration' },
    })

    const data = await exchangeConnectorCode(CONNECTOR, {
      code: 'auth-code',
      redirectUri: 'https://app.hosted.example/api/extensions/ext/skatteverket/callback',
      codeVerifier: 'verifier-1',
      connectorState: 'signed-cs',
    })

    expect(data.access_token).toBe('at')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://app.hosted.example/api/connect/skv/oauth/token')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code',
      redirect_uri: 'https://app.hosted.example/api/extensions/ext/skatteverket/callback',
      code_verifier: 'verifier-1',
      connector_state: 'signed-cs',
    })
    // The whole point of the broker: Arcim's client credentials never appear
    // in anything the instance sends.
    expect(init.body as string).not.toMatch(/client_id|client_secret/)
  })

  it('sends the refresh_token grant and unwraps { data }', async () => {
    const fetchMock = mockFetchJson(200, {
      data: { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600, scope: 's' },
    })

    const data = await refreshConnectorToken(CONNECTOR, 'rt1')
    expect(data).toEqual({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600, scope: 's' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt1',
    })
  })

  it('surfaces the broker 404 CONNECTOR_NOT_OWNED dialect in the error message', async () => {
    // api-client's dead-refresh-token classifier matches on exactly this
    // shape (status 404 + CONNECTOR_NOT_OWNED) to map it to SESSION_EXPIRED.
    mockFetchJson(404, { error: 'Unknown connection for this key', code: 'CONNECTOR_NOT_OWNED' })
    await expect(refreshConnectorToken(CONNECTOR, 'rt-dead')).rejects.toThrow(
      /refresh failed \(404\)[\s\S]*CONNECTOR_NOT_OWNED/,
    )
  })
})
