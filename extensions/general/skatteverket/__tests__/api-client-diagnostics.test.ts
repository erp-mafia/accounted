import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const records = vi.hoisted(
  () => [] as Parameters<typeof import('@/lib/logger').createTestLogger>[1],
)

// Use the real record builder, including production PII redaction.
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string) => actual.createTestLogger(module, records),
  }
})

vi.mock('../lib/token-store', () => ({
  getTokens: vi.fn(async () => ({
    access_token: 'private-user-bearer',
    refresh_token: 'private-refresh',
    expires_at: Date.now() + 60 * 60_000,
    refresh_count: 0,
    scope: 'agd agdredovisningperiod',
  })),
  storeTokens: vi.fn(),
  deleteTokens: vi.fn(),
}))

vi.mock('../lib/system-auth/token-provider', () => ({
  getSystemAccessToken: vi.fn(async () => 'private-system-bearer'),
  invalidateSystemToken: vi.fn(),
}))

import { agiGetKvittenser } from '../lib/agi-client'
import { skvRequestWithAuth, SkatteverketAuthError, type SkvAuth } from '../lib/api-client'

const employer = '165561234567'
const receiptPath = `/arbetsgivare/${employer}/redovisningsperioder/202609/kvittenser`
const userAuth: SkvAuth = {
  mode: 'user',
  supabase: {} as Extract<SkvAuth, { mode: 'user' }>['supabase'],
  userId: 'user-1',
  companyId: 'company-1',
}

beforeEach(() => {
  records.length = 0
  vi.stubEnv('SKATTEVERKET_DISABLED', '')
  vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_ID', 'private-gateway-id')
  vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_SECRET', 'private-gateway-secret')
  vi.stubEnv('SKATTEVERKET_OAUTH2_CLIENT_ID', '')
  vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
  vi.stubEnv('CONNECT_SKV_CANARY_COMPANIES', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function respond(status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ error: 'Invalid client id or secret' }),
    { status, headers: { 'WWW-Authenticate': 'Client-ID-Enforcement' } },
  )))
}

function authRecord(status: number) {
  const record = records.find((r) => r.msg === `${status} from Skatteverket API`)
  expect(record).toBeDefined()
  return record!
}

describe('SKV authentication diagnostics after redaction', () => {
  it.each([
    [401, 'api.skatteverket.se'],
    [403, 'api.skatteverket.se'],
    [401, 'api.test.skatteverket.se'],
    [403, 'api.test.skatteverket.se'],
  ])('preserves the actual receipt destination for %s from %s', async (status, host) => {
    vi.stubEnv('SKATTEVERKET_AGD_PERIOD_API_BASE_URL',
      `https://${host}/arbetsgivardeklaration/hanteraredovisningsperiod/v1`)
    respond(status)

    await expect(agiGetKvittenser(userAuth, employer, '202609'))
      .rejects.toBeInstanceOf(SkatteverketAuthError)

    expect(authRecord(status)).toMatchObject({
      url: '[REDACTED]',
      requestHost: host,
      apiService: 'agd-period',
      gatewayRoute: 'direct',
      authMode: 'user',
    })
    const logged = JSON.stringify(records)
    for (const secret of [employer, 'private-gateway-id', 'private-gateway-secret', 'private-user-bearer', 'private-refresh']) {
      expect(logged).not.toContain(secret)
    }
  })

  it('reports the connector destination without inferring its upstream environment', async () => {
    vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_ID', '')
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'private-connector-key')
    vi.stubEnv('GNUBOK_CONNECT_URL', 'https://broker.example')
    vi.stubEnv('SKATTEVERKET_AGD_PERIOD_API_BASE_URL', '')
    respond(401)

    await expect(agiGetKvittenser(userAuth, employer, '202609'))
      .rejects.toBeInstanceOf(SkatteverketAuthError)

    expect(authRecord(401)).toMatchObject({
      url: '[REDACTED]',
      requestHost: 'broker.example',
      apiService: 'agd-period',
      gatewayRoute: 'connector',
    })
    expect(JSON.stringify(records)).not.toMatch(/private-connector-key|private-user-bearer|api\.test\.skatteverket\.se/)
  })

  it('reports system requests as direct even when user requests use the connector', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'private-connector-key')
    vi.stubEnv('CONNECT_SKV_CANARY_COMPANIES', 'company-1')
    vi.stubEnv('SKATTEVERKET_AGD_PERIOD_API_BASE_URL',
      'https://api.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1')
    respond(401)

    await expect(agiGetKvittenser({ mode: 'system' }, employer, '202609'))
      .rejects.toMatchObject({ code: 'SYSTEM_AUTH_FAILED' })

    expect(authRecord(401)).toMatchObject({
      requestHost: 'api.skatteverket.se',
      apiService: 'agd-period',
      gatewayRoute: 'direct',
      authMode: 'system',
    })
    expect(JSON.stringify(records)).not.toContain('private-system-bearer')
  })

  it('does not let an unmapped direct API obscure the original auth failure', async () => {
    respond(401)

    await expect(skvRequestWithAuth(userAuth, 'GET', receiptPath, undefined, {
      baseUrl: 'https://custom.example/unmapped',
    })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })

    expect(authRecord(401)).toMatchObject({
      requestHost: 'custom.example',
      apiService: 'unknown',
      gatewayRoute: 'direct',
    })
  })

  it.each([200, 400, 404])('leaves HTTP %s responses and logging unchanged', async (status) => {
    respond(status)
    const response = await skvRequestWithAuth(userAuth, 'GET', receiptPath, undefined, {
      baseUrl: 'https://api.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1',
    })
    expect(response.status).toBe(status)
    expect(records).toEqual([])
  })
})
