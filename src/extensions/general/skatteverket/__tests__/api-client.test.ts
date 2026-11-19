import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the token-store to bypass DB and supply a fresh access token.
const deleteTokensMock = vi.fn()
vi.mock('../lib/token-store', () => ({
  getTokens: vi.fn(async () => ({
    access_token: 'test-access',
    refresh_token: 'test-refresh',
    expires_at: Date.now() + 60 * 60_000,
    refresh_count: 0,
    scope: 'momsdeklaration',
    row_id: 'row-live',
    stored_at: Date.now(),
  })),
  storeTokens: vi.fn(),
  deleteTokens: (...args: unknown[]) => deleteTokensMock(...args),
}))

// Mock oauth so a refresh attempt (shouldn't fire) is harmless.
vi.mock('../lib/oauth', () => ({
  refreshAccessToken: vi.fn(async () => ({
    access_token: 'refreshed',
    refresh_token: 'refreshed-r',
    expires_at: Date.now() + 60 * 60_000,
    refresh_count: 1,
  })),
  exchangeCodeForTokens: vi.fn(),
}))

// The transport writes an audit row per call; these tests are about the call
// itself, so the writer is stubbed (transport-audit.test.ts covers the rows).
vi.mock('../lib/audit', () => ({ writeSkatteverketAudit: vi.fn() }))

import { skvRequest, skvRequestWithAuth, SkatteverketAuthError, isApigwClientRefusal } from '../lib/api-client'
import { __resetSystemTokenCacheForTests } from '../lib/system-auth/token-provider'
import { getOmbudRoleDescriptions, listOmbudGrants } from '../lib/ombud-client'

const fakeSupabase = {} as unknown as Parameters<typeof skvRequest>[0]

const AUDIT = { endpoint: 'test' }
const SYSTEM_AUDIT = { endpoint: 'test', companyId: 'comp-1', userId: null }

beforeEach(() => {
  process.env.SKATTEVERKET_APIGW_CLIENT_ID = 'gw-id'
  process.env.SKATTEVERKET_APIGW_CLIENT_SECRET = 'gw-secret'
  process.env.SKATTEVERKET_API_BASE_URL = 'https://api.test.example/x'
  vi.restoreAllMocks()
})

function mockFetchStatus(status: number, body = '', headers?: HeadersInit) {
  global.fetch = vi.fn(async () =>
    new Response(body, { status, statusText: String(status), headers })
  ) as unknown as typeof fetch
}

describe('skvRequest: error mapping', () => {
  it('maps empty 401 → ACCESS_DENIED (likely missing APIGW subscription)', async () => {
    mockFetchStatus(401)
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('ACCESS_DENIED')
      expect((e as SkatteverketAuthError).message).toMatch(/Utvecklarportalen|prenumeration/i)
    }
  })

  it('maps 401 with body text → SESSION_EXPIRED with a clean Swedish message (no body leak)', async () => {
    mockFetchStatus(401, 'token expired')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
      expect((e as SkatteverketAuthError).message).toMatch(/Sessionen har gått ut/)
      // The verdict names the stored token the call went out with, so a cron
      // flags that row only while it is still that token.
      expect((e as SkatteverketAuthError).tokenRow).toEqual({ userId: 'user-1', version: { rowId: 'row-live', refreshCount: 0 } })
      // Audit V16.1: the raw response body must NOT be concatenated into the
      // user-facing message: that information stays in server-side logs.
      expect((e as SkatteverketAuthError).message).not.toContain('token expired')
    }
  })

  it('maps 401 with "Token has been revoked." body → TOKEN_REVOKED and clears local row', async () => {
    deleteTokensMock.mockClear()
    mockFetchStatus(401, '{"error":"Token has been revoked."}')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('TOKEN_REVOKED')
      expect((e as SkatteverketAuthError).message).toMatch(/återkallat/i)
      // Only the row the call went out with: not one another process stored meanwhile.
      expect(deleteTokensMock).toHaveBeenCalledWith(fakeSupabase, 'user-1', 'comp-1', 'row-live')
    }
  })

  it('maps 401 with WWW-Authenticate insufficient_scope → MISSING_SCOPE', async () => {
    mockFetchStatus(401, '', {
      'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="agd"',
    })
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('MISSING_SCOPE')
    }
  })

  it('maps 403 with Behörighet body → BEHORIGHET_SAKNAS', async () => {
    mockFetchStatus(403, 'Behörighet saknas för aktören')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('BEHORIGHET_SAKNAS')
    }
  })

  // B07: the skattekonto API says "this person is not authorized for the
  // company" as felkod 6, without the word Behörighet. It used to fall to the
  // generic ACCESS_DENIED ("Kontakta support") and an hourly cron error.
  it('maps 403 felkod 6 "Auktorisation saknas" → BEHORIGHET_SAKNAS', async () => {
    mockFetchStatus(403, '{\n  "felkod": 6,\n  "felmeddelande": "Auktorisation saknas"\n}')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('BEHORIGHET_SAKNAS')
      expect((e as SkatteverketAuthError).message).toMatch(/firmatecknare/)
    }
  })

  // #1155: the MuleSoft APIGW contract error wears scope wording but is our
  // subscription gap (#973), not the user's token. It used to match the
  // `required scope` substring test and surface as MISSING_SCOPE, which is in
  // RECONSENT_ERROR_CODES: every reconnect ran runPostConnectRefresh ->
  // syncSkattekonto -> 403 and instantly re-flagged the row, so the reconnect
  // banner could never be cleared.
  it('maps the APIGW "required scopes are not authorized" 403 → ACCESS_DENIED, not MISSING_SCOPE', async () => {
    mockFetchStatus(403, '{"error": "The required scopes are not authorized"}')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('ACCESS_DENIED')
      expect((e as SkatteverketAuthError).message).toMatch(/APIGW|Utvecklarportalen/)
    }
  })

  // The same body has two causes (subscription gap #973, missing token scope
  // like the AGI kvittens one), and the gateway never says which. A message
  // naming only the subscription sent a real prod filing down a dead end: the
  // fix was a scope, so every minute spent in Utvecklarportalen was wasted.
  it('names BOTH causes and the refused service on the gateway 403', async () => {
    mockFetchStatus(403, '{"error": "The required scopes are not authorized"}')
    try {
      // The real shape of the incident: the kvittens read on the hantera API.
      await skvRequest(
        fakeSupabase, 'user-1', 'comp-1', 'GET',
        '/arbetsgivare/165560000000/redovisningsperioder/202608/kvittenser',
        AUDIT,
        undefined,
        { baseUrl: 'https://api.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1' },
      )
      expect.fail('expected throw')
    } catch (e) {
      const { message } = e as SkatteverketAuthError
      expect(message).toMatch(/prenumeration/)
      expect(message).toMatch(/scope/)
      // Which service refused. Naming it is the whole point: the sibling
      // inlamning API kept working, so "Skatteverket said no" is not a clue.
      expect(message).toContain('arbetsgivardeklaration/hanteraredovisningsperiod/v1')
    }
  })

  it('still maps a real token-scope rejection → MISSING_SCOPE', async () => {
    // Body shape from SKV's AGI Tjänstebeskrivning v1.7 §4.1.2.2.
    mockFetchStatus(
      403,
      '{"error":"invalid_scope","description":"The required scope agd has been requested for that access token."}',
    )
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('MISSING_SCOPE')
    }
  })

  it('maps the SKV scope sentence alone (no invalid_scope code) → MISSING_SCOPE', async () => {
    mockFetchStatus(403, 'The required scope agd has been requested for that access token.')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('MISSING_SCOPE')
    }
  })

  it('treats the APIGW contract wording on a 401 as a gateway issue, even with an OAuth challenge header', async () => {
    // SESSION_EXPIRED and MISSING_SCOPE are both reconsent codes, so either
    // verdict would re-arm the banner. The gateway signature wins over the
    // WWW-Authenticate scope marker when both are present.
    mockFetchStatus(401, '{"error": "The required scopes are not authorized"}', {
      'WWW-Authenticate': 'Bearer error="invalid_scope"',
    })
    try {
      await skvRequest(
        fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT, undefined,
        { baseUrl: 'https://api.skatteverket.se/arbetsgivardeklaration/inlamning/v1' },
      )
      expect.fail('expected throw')
    } catch (e) {
      const { code, message } = e as SkatteverketAuthError
      expect(code).toBe('ACCESS_DENIED')
      // Same shared message as the 403 contract path: both causes named plus
      // the refused service, so the 401 shape cannot drift into vaguer text.
      expect(message).toMatch(/prenumeration/)
      expect(message).toMatch(/scope/)
      expect(message).toContain('arbetsgivardeklaration/inlamning/v1')
    }
  })

  // The production response for the AGI hantera API (#973, #2226): MuleSoft's
  // Client ID Enforcement policy refusing the APIGW client before any bearer
  // is read. Same code as before (every ACCESS_DENIED consumer stays correct),
  // but tagged, because it is the one refusal no connection can change and
  // callers must be able to stop asking.
  it('tags the Client-ID-Enforcement 401 as APIGW_CLIENT_REFUSED', async () => {
    process.env.SKATTEVERKET_API_BASE_URL =
      'https://api.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1'
    mockFetchStatus(401, '{\n  "error": "Invalid client id or secret"\n}', {
      'WWW-Authenticate': 'Client-ID-Enforcement',
    })
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('ACCESS_DENIED')
      expect((e as SkatteverketAuthError).detail).toBe('APIGW_CLIENT_REFUSED')
      expect(isApigwClientRefusal(e)).toBe(true)
      expect((e as SkatteverketAuthError).message).toContain(
        'arbetsgivardeklaration/hanteraredovisningsperiod/v1',
      )
    }
  })

  it('tags it from the challenge header alone (the gateway often sends no body)', async () => {
    mockFetchStatus(401, '', { 'WWW-Authenticate': 'Client-ID-Enforcement' })
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(isApigwClientRefusal(e)).toBe(true)
    }
  })

  it('does not tag the other ACCESS_DENIED causes', async () => {
    for (const [status, body] of [
      [401, ''],
      [403, '{"error": "The required scopes are not authorized"}'],
      [403, 'Forbidden'],
    ] as const) {
      mockFetchStatus(status, body)
      try {
        await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
        expect.fail('expected throw')
      } catch (e) {
        expect((e as SkatteverketAuthError).code).toBe('ACCESS_DENIED')
        expect(isApigwClientRefusal(e)).toBe(false)
      }
    }
    expect(isApigwClientRefusal(new Error('boom'))).toBe(false)
  })

  it('maps generic 403 → ACCESS_DENIED', async () => {
    mockFetchStatus(403, 'Forbidden')
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('ACCESS_DENIED')
    }
  })

  it('maps 429 → RATE_LIMITED (new behavior)', async () => {
    mockFetchStatus(429)
    try {
      await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('RATE_LIMITED')
      // Swedish message: UI surfaces it directly.
      expect((e as SkatteverketAuthError).message).toMatch(/Skatteverket/)
      expect((e as SkatteverketAuthError).message).toMatch(/igen/i)
    }
  })

  it('returns the response for 5xx (caller decides retry)', async () => {
    mockFetchStatus(503, 'Service Unavailable')
    const res = await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
    expect(res.status).toBe(503)
  })

  it('returns the response for success', async () => {
    mockFetchStatus(200, '{"ok":true}')
    const res = await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ ok: true })
  })
})

describe('skvRequest: gateway credentials', () => {
  it('refuses redirects, so a 307/308 never resends Client_Secret and the bearer', async () => {
    mockFetchStatus(200, '{}')
    await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
    const [, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Client_Secret).toBe('gw-secret')
    expect(init.redirect).toBe('error')
  })
})

// accounted#21: the direct path sends the bearer, Client_Secret and the
// filing, so a plaintext base URL must fail before anything leaves.
describe('skvRequest: base URL must be https', () => {
  const fetchMock = () => global.fetch as unknown as ReturnType<typeof vi.fn>

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses an http SKATTEVERKET_API_BASE_URL without calling fetch', async () => {
    process.env.SKATTEVERKET_API_BASE_URL = 'http://api.test.example/x'
    mockFetchStatus(200, '{}')
    await expect(skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)).rejects.toThrow(
      /must be https/,
    )
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  it('refuses an http per-service base URL (skattekonto, AGI, ombud) the same way', async () => {
    mockFetchStatus(200, '{}')
    await expect(
      skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/saldo', AUDIT, undefined, {
        baseUrl: 'http://api.test.example/beskattning/skattekonto/v2',
      }),
    ).rejects.toThrow(/must be https/)
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  it('sends to an https base URL', async () => {
    mockFetchStatus(200, '{}')
    await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
    expect(fetchMock().mock.calls[0][0]).toBe('https://api.test.example/x/x')
  })

  it('accepts a localhost mock only outside production', async () => {
    process.env.SKATTEVERKET_API_BASE_URL = 'http://localhost:4010/x'
    mockFetchStatus(200, '{}')
    await skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)
    expect(fetchMock().mock.calls[0][0]).toBe('http://localhost:4010/x/x')

    vi.stubEnv('NODE_ENV', 'production')
    mockFetchStatus(200, '{}')
    await expect(skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)).rejects.toThrow(
      /must be https/,
    )
    expect(fetchMock()).not.toHaveBeenCalled()
  })
})

describe('SkatteverketAuthError', () => {
  it('exposes the new TOKEN_CORRUPTED and RATE_LIMITED codes', () => {
    const a = new SkatteverketAuthError('msg', 'TOKEN_CORRUPTED')
    const b = new SkatteverketAuthError('msg', 'RATE_LIMITED')
    expect(a.code).toBe('TOKEN_CORRUPTED')
    expect(b.code).toBe('RATE_LIMITED')
  })
})

describe('skvRequestWithAuth: system mode', () => {
  beforeEach(() => {
    process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'on'
    process.env.SKATTEVERKET_SYSTEM_AUTH_MECHANISM = 'stub'
    __resetSystemTokenCacheForTests()
    deleteTokensMock.mockClear()
  })

  afterEach(() => {
    delete process.env.SKATTEVERKET_SYSTEM_AUTH_MODE
    delete process.env.SKATTEVERKET_SYSTEM_AUTH_MECHANISM
  })

  it('sends the system token and returns success responses', async () => {
    mockFetchStatus(200, '{"ok":true}')
    const res = await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x', SYSTEM_AUDIT)
    expect(res.status).toBe(200)
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((call[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer stub-system-token',
    })
  })

  describe('gateway keys', () => {
    afterEach(() => {
      delete process.env.SKATTEVERKET_SYSTEM_APIGW_CLIENT_ID
      delete process.env.SKATTEVERKET_SYSTEM_APIGW_CLIENT_SECRET
    })

    const headersOfLastCall = () =>
      ((global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as RequestInit).headers as Record<string, string>

    it("system calls carry the system application's own pair when it is configured", async () => {
      process.env.SKATTEVERKET_SYSTEM_APIGW_CLIENT_ID = 'sys-gw-id'
      process.env.SKATTEVERKET_SYSTEM_APIGW_CLIENT_SECRET = 'sys-gw-secret'
      mockFetchStatus(200, '{}')
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x', SYSTEM_AUDIT)
      expect(headersOfLastCall()).toMatchObject({ Client_Id: 'sys-gw-id', Client_Secret: 'sys-gw-secret' })
    })

    it('a lone system id or secret falls back to the shared pair, never a mix', async () => {
      process.env.SKATTEVERKET_SYSTEM_APIGW_CLIENT_ID = 'sys-gw-id'
      mockFetchStatus(200, '{}')
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x', SYSTEM_AUDIT)
      expect(headersOfLastCall()).toMatchObject({ Client_Id: 'gw-id', Client_Secret: 'gw-secret' })
    })

    it('BankID (user) calls keep the shared pair even when a system pair exists', async () => {
      process.env.SKATTEVERKET_SYSTEM_APIGW_CLIENT_ID = 'sys-gw-id'
      process.env.SKATTEVERKET_SYSTEM_APIGW_CLIENT_SECRET = 'sys-gw-secret'
      mockFetchStatus(200, '{}')
      await skvRequest(fakeSupabase, 'user-1', 'company-1', 'GET', '/x', AUDIT)
      expect(headersOfLastCall()).toMatchObject({ Client_Id: 'gw-id', Client_Secret: 'gw-secret' })
    })
  })

  it('401 in system mode -> SYSTEM_AUTH_FAILED and NEVER touches the user token table', async () => {
    mockFetchStatus(401, '{"error":"Token has been revoked."}')
    try {
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x', SYSTEM_AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('SYSTEM_AUTH_FAILED')
    }
    // The revoked-body branch deletes the user row in user mode; system
    // mode must never reach it.
    expect(deleteTokensMock).not.toHaveBeenCalled()
  })

  it('a Client-ID-Enforcement 401 in system mode keeps SYSTEM_AUTH_FAILED and carries the tag', async () => {
    // The gateway never looked at the bearer, so switching credential changes
    // nothing: the tag is what stops a caller from trying the other one.
    mockFetchStatus(401, '{"error": "Invalid client id or secret"}', {
      'WWW-Authenticate': 'Client-ID-Enforcement',
    })
    try {
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x', SYSTEM_AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('SYSTEM_AUTH_FAILED')
      expect(isApigwClientRefusal(e)).toBe(true)
    }
    expect(deleteTokensMock).not.toHaveBeenCalled()
  })

  it('403 in system mode -> OMBUD_GRANT_MISSING (company-level)', async () => {
    mockFetchStatus(403, 'Forbidden')
    try {
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x', SYSTEM_AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('OMBUD_GRANT_MISSING')
    }
    expect(deleteTokensMock).not.toHaveBeenCalled()
  })

  it('403 invalid_scope in system mode -> SYSTEM_AUTH_FAILED (config, not grant)', async () => {
    mockFetchStatus(403, '{"error":"invalid_scope"}')
    try {
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x', SYSTEM_AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('SYSTEM_AUTH_FAILED')
      expect((e as SkatteverketAuthError).message).toMatch(/SKATTEVERKET_SYSTEM_SCOPES/)
    }
  })

  it('403 APIGW contract error in system mode names both knobs', async () => {
    // Still SYSTEM_AUTH_FAILED (run-level config either way). This assertion
    // is the inverse of what it was: #1250 removed the SKATTEVERKET_SYSTEM_SCOPES
    // mention on the reasoning that the gateway, not the scope list, had
    // refused. Production later proved the body cannot distinguish the two, so
    // naming one and hiding the other is a coin flip presented as a diagnosis.
    mockFetchStatus(403, '{"error": "The required scopes are not authorized"}')
    try {
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x', SYSTEM_AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('SYSTEM_AUTH_FAILED')
      expect((e as SkatteverketAuthError).message).toMatch(/prenumeration/)
      expect((e as SkatteverketAuthError).message).toMatch(/SKATTEVERKET_SYSTEM_SCOPES/)
    }
  })

  it('unconfigured system auth -> SYSTEM_AUTH_FAILED before any fetch', async () => {
    process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'off'
    global.fetch = vi.fn() as unknown as typeof fetch
    try {
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x', SYSTEM_AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect((e as SkatteverketAuthError).code).toBe('SYSTEM_AUTH_FAILED')
    }
    expect(global.fetch).not.toHaveBeenCalled()
  })

  // Ombudshantering answers a GET without Content-Type with 400 "Required
  // header 'Content-Type' not specified" (test service, 2026-11-03). The
  // other services never asked for it on a GET, and Skatteverket warns that
  // headers outside a service's list can block a call, so only the register
  // gets it.
  describe('Content-Type on a body-less GET', () => {
    const headersOfLastCall = () =>
      ((global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as RequestInit).headers as Record<string, string>

    it('the register GETs (/roller, /ombud/autentisieratOmbud) carry Content-Type: application/json', async () => {
      mockFetchStatus(200, '[]')
      await getOmbudRoleDescriptions()
      expect(headersOfLastCall()).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json' })
      mockFetchStatus(200, '[]')
      await listOmbudGrants({}, 'ombud_register')
      expect(headersOfLastCall()).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json' })
    })

    it('a GET on the other services still carries none', async () => {
      mockFetchStatus(200, '{}')
      await skvRequestWithAuth({ mode: 'system' }, 'GET', '/x', SYSTEM_AUDIT)
      expect(headersOfLastCall()).not.toHaveProperty('Content-Type')
      expect(headersOfLastCall()).not.toHaveProperty('Accept')
    })
  })
})

describe('refresh-token dead-session classification', () => {
  // SKV's per-flow refresh tokens live 65 minutes, so crons always find a
  // dead token. SKV reports that in several dialects (404 id_not_found,
  // 400 "Refresh Token status is expired", 400 invalid_grant); all must
  // surface as the SESSION_EXPIRED SkatteverketAuthError (which cron
  // quiet-buckets and the UI reconnect flow understand), not as a raw
  // Error that error-logs every run. Unique userIds per test: the
  // module-level refresh coalescing map is keyed by userId.
  //
  // A session left overnight, the case these dialects come from: the row was
  // stored hours ago, longer than a refresh token has ever been seen working,
  // so nobody can have refreshed it, and the dead-token path looks at the
  // stored token once, without waiting.
  const expiredTokens = {
    access_token: 'stale',
    refresh_token: 'dead-refresh',
    expires_at: Date.now() - 2 * 60 * 60_000,
    refresh_count: 1,
    scope: 'momsdeklaration',
    row_id: 'row-1',
    stored_at: Date.now() - 3 * 60 * 60_000,
  }

  it('classifies 404 id_not_found as SESSION_EXPIRED', async () => {
    const { getTokens } = await import('../lib/token-store')
    const { refreshAccessToken } = await import('../lib/oauth')
    // getValidToken reads once, refreshTokenForUser re-reads - queue both.
    // ... and the dead-token path looks once more for a token another
    // process may have stored: here nobody did.
    vi.mocked(getTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(
      new Error(
        'Skatteverket token refresh failed (404): {\n  "error":"id_not_found",\n  "error_description":"The refresh token is not found"\n}\n',
      ),
    )

    try {
      await skvRequest(fakeSupabase, 'user-404', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
      expect((e as SkatteverketAuthError).message).toMatch(/Sessionen har gått ut/)
    }
  })

  it('classifies 400 "Refresh Token status is expired" as SESSION_EXPIRED', async () => {
    // Exact prod payload observed 2026-07-24: the AGI kvittenser cron hit
    // this every 15 minutes and error-logged it because only the 404
    // dialect was classified.
    const { getTokens } = await import('../lib/token-store')
    const { refreshAccessToken } = await import('../lib/oauth')
    vi.mocked(getTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(
      new Error(
        'Skatteverket token refresh failed (400): {\n  "error":"access_denied",\n  "error_description":"Refresh Token status is expired"\n}\n',
      ),
    )

    try {
      await skvRequest(fakeSupabase, 'user-400-expired', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
      expect((e as SkatteverketAuthError).message).toMatch(/Sessionen har gått ut/)
    }
  })

  it('classifies 400 invalid_grant as SESSION_EXPIRED', async () => {
    const { getTokens } = await import('../lib/token-store')
    const { refreshAccessToken } = await import('../lib/oauth')
    vi.mocked(getTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(
      new Error('Skatteverket token refresh failed (400): {"error": "invalid_grant"}'),
    )

    try {
      await skvRequest(fakeSupabase, 'user-400-grant', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SkatteverketAuthError)
      expect((e as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
    }
  })

  describe('when another process refreshed the same token first', () => {
    // The skattekonto sync and the AGI and VAT kvittens crons run in separate
    // processes in the same minute. Skatteverket rotates the refresh token on
    // first use, so the second to refresh is told its copy is dead while the
    // connection lives on under the token the first one stored.
    const DEAD = 'Skatteverket token refresh failed (400): {"error": "invalid_grant"}'
    // Stored 61 minutes ago: inside a refresh token's 65, so another process
    // can have refreshed it a moment ago.
    const raced = { ...expiredTokens, expires_at: Date.now() - 60_000, stored_at: Date.now() - 61 * 60_000 }
    const storedByWinner = {
      access_token: 'winner-access',
      refresh_token: 'rotated-refresh',
      expires_at: Date.now() + 60 * 60_000,
      refresh_count: 2,
      scope: 'momsdeklaration',
      row_id: 'row-2',
      stored_at: Date.now(),
    }
    const bearerSent = () =>
      new Headers((vi.mocked(global.fetch).mock.calls[0][1] as RequestInit).headers).get('Authorization')

    it('uses the token the other process stored instead of calling the session expired', async () => {
      const { getTokens, storeTokens } = await import('../lib/token-store')
      const { refreshAccessToken } = await import('../lib/oauth')
      vi.mocked(getTokens)
        .mockResolvedValueOnce(raced)
        .mockResolvedValueOnce(raced)
        .mockResolvedValueOnce(storedByWinner)
      vi.mocked(refreshAccessToken).mockRejectedValueOnce(new Error(DEAD))
      vi.mocked(storeTokens).mockClear()
      mockFetchStatus(200, '{}')

      const response = await skvRequest(fakeSupabase, 'user-race-won', 'comp-1', 'GET', '/x', AUDIT)

      expect(response.status).toBe(200)
      expect(bearerSent()).toBe('Bearer winner-access')
      expect(storeTokens).not.toHaveBeenCalled()
    })

    it('waits out the other process while its row is being replaced (delete, then insert)', async () => {
      const { getTokens } = await import('../lib/token-store')
      const { refreshAccessToken } = await import('../lib/oauth')
      vi.mocked(getTokens)
        .mockResolvedValueOnce(raced)
        .mockResolvedValueOnce(raced)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(storedByWinner)
      vi.mocked(refreshAccessToken).mockRejectedValueOnce(new Error(DEAD))
      mockFetchStatus(200, '{}')

      await skvRequest(fakeSupabase, 'user-race-mid-store', 'comp-1', 'GET', '/x', AUDIT)

      expect(bearerSent()).toBe('Bearer winner-access')
    })

    it('is SESSION_EXPIRED when nobody stored a newer token, and names the stored token it was decided on', async () => {
      const { getTokens } = await import('../lib/token-store')
      const { refreshAccessToken } = await import('../lib/oauth')
      vi.mocked(getTokens)
        .mockResolvedValueOnce(raced)
        .mockResolvedValueOnce(raced)
        .mockResolvedValueOnce(raced)
        .mockResolvedValueOnce(raced)
      vi.mocked(refreshAccessToken).mockRejectedValueOnce(new Error(DEAD))

      const thrown = await skvRequest(fakeSupabase, 'user-race-none', 'comp-1', 'GET', '/x', AUDIT).then(
        () => null,
        (e: unknown) => e,
      )

      expect(thrown).toBeInstanceOf(SkatteverketAuthError)
      expect((thrown as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
      // markNeedsReconsent flags only this row, and only while it is this token.
      expect((thrown as SkatteverketAuthError).tokenRow).toEqual({
        userId: 'user-race-none',
        version: { rowId: 'row-1', refreshCount: 1 },
      })
    })

    it('does not wait for a second look when the row is older than a refresh token has ever worked: nobody can have refreshed it', async () => {
      // The wait was paid on every dead-token call, interactive and MCP ones
      // included, though a session left overnight cannot be in a race.
      const { getTokens } = await import('../lib/token-store')
      const { refreshAccessToken } = await import('../lib/oauth')
      vi.mocked(getTokens).mockClear()
      vi.mocked(getTokens)
        .mockResolvedValueOnce(expiredTokens)
        .mockResolvedValueOnce(expiredTokens)
        .mockResolvedValueOnce(expiredTokens)
      vi.mocked(refreshAccessToken).mockRejectedValueOnce(new Error(DEAD))

      const thrown = await skvRequest(fakeSupabase, 'user-overnight', 'comp-1', 'GET', '/x', AUDIT).then(
        () => null,
        (e: unknown) => e,
      )

      expect((thrown as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
      // The second look comes after the wait: three reads mean there was none.
      expect(getTokens).toHaveBeenCalledTimes(3)
    })

    it('still takes the second look for a row stored 90 minutes ago: refresh tokens were seen working for two hours', async () => {
      // Past the documented 65 minutes but inside the observed two hours: the
      // winner of a race may still be storing, and an MCP or interactive user
      // would be told to log in with BankID on a live session.
      const { getTokens } = await import('../lib/token-store')
      const { refreshAccessToken } = await import('../lib/oauth')
      const ninetyMinutesOld = { ...raced, stored_at: Date.now() - 90 * 60_000 }
      vi.mocked(getTokens)
        .mockResolvedValueOnce(ninetyMinutesOld)
        .mockResolvedValueOnce(ninetyMinutesOld)
        .mockResolvedValueOnce(ninetyMinutesOld)
        .mockResolvedValueOnce(storedByWinner)
      vi.mocked(refreshAccessToken).mockRejectedValueOnce(new Error(DEAD))
      mockFetchStatus(200, '{}')

      await skvRequest(fakeSupabase, 'user-race-ninety', 'comp-1', 'GET', '/x', AUDIT)

      expect(bearerSent()).toBe('Bearer winner-access')
    })

    it('names the token it stored when the call after its own refresh is refused', async () => {
      // The flag after a refused call must compare on the row this process
      // stored, not on the one it refreshed away.
      const { getTokens, storeTokens } = await import('../lib/token-store')
      const { refreshAccessToken } = await import('../lib/oauth')
      vi.mocked(getTokens).mockResolvedValueOnce(raced).mockResolvedValueOnce(raced)
      vi.mocked(refreshAccessToken).mockResolvedValueOnce({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_at: Date.now() + 60 * 60_000,
        refresh_count: 2,
        scope: 'momsdeklaration',
      })
      vi.mocked(storeTokens).mockResolvedValueOnce('row-stored')
      mockFetchStatus(401, 'token expired')

      const thrown = await skvRequest(fakeSupabase, 'user-after-refresh', 'comp-1', 'GET', '/x', AUDIT).then(
        () => null,
        (e: unknown) => e,
      )

      expect((thrown as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
      expect((thrown as SkatteverketAuthError).tokenRow).toEqual({
        userId: 'user-after-refresh',
        version: { rowId: 'row-stored', refreshCount: 2 },
      })
    })

    it('keeps the verdict when the second look cannot read the stored token', async () => {
      const { getTokens } = await import('../lib/token-store')
      const { refreshAccessToken } = await import('../lib/oauth')
      vi.mocked(getTokens)
        .mockResolvedValueOnce(raced)
        .mockResolvedValueOnce(raced)
        .mockRejectedValueOnce(new Error('connection reset'))
      vi.mocked(refreshAccessToken).mockRejectedValueOnce(new Error(DEAD))

      const thrown = await skvRequest(fakeSupabase, 'user-race-unreadable', 'comp-1', 'GET', '/x', AUDIT).then(
        () => null,
        (e: unknown) => e,
      )

      expect((thrown as SkatteverketAuthError).code).toBe('SESSION_EXPIRED')
      expect((thrown as SkatteverketAuthError).tokenRow?.version).toEqual({ rowId: 'row-1', refreshCount: 1 })
    })
  })

  it('leaves config-shaped 400s (invalid_client) as raw errors', async () => {
    // invalid_client means OUR client credentials are broken; telling the
    // user to reconnect cannot fix it and would re-create the
    // self-perpetuating reconnect banner (2026-07 MISSING_SCOPE incident).
    const { getTokens } = await import('../lib/token-store')
    const { refreshAccessToken } = await import('../lib/oauth')
    vi.mocked(getTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(
      new Error('Skatteverket token refresh failed (400): {"error":"invalid_client"}'),
    )

    try {
      await skvRequest(fakeSupabase, 'user-400-client', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).not.toBeInstanceOf(SkatteverketAuthError)
      expect((e as Error).message).toMatch(/invalid_client/)
    }
  })

  it('re-throws other refresh failures untouched', async () => {
    const { getTokens } = await import('../lib/token-store')
    const { refreshAccessToken } = await import('../lib/oauth')
    vi.mocked(getTokens)
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(expiredTokens)
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(
      new Error('Skatteverket token refresh failed (500): upstream unavailable'),
    )

    try {
      await skvRequest(fakeSupabase, 'user-500', 'comp-1', 'GET', '/x', AUDIT)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).not.toBeInstanceOf(SkatteverketAuthError)
      expect((e as Error).message).toMatch(/500/)
    }
  })
})

describe('skvRequest: rate limit under concurrency', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // B07: the skattekonto cron now syncs several companies at once. The old
  // limiter spaced each caller from the previous CLAIM, so four concurrent
  // calls all left within ~260 ms; slots must be 250 ms apart.
  it('spaces concurrent calls 250 ms apart instead of bursting', async () => {
    vi.useFakeTimers()
    // Start well past any slot an earlier test reserved.
    vi.setSystemTime(Date.now() + 60_000)
    const sentAt: number[] = []
    global.fetch = vi.fn(async () => {
      sentAt.push(Date.now())
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const calls = Promise.all(
      Array.from({ length: 4 }, () => skvRequest(fakeSupabase, 'user-1', 'comp-1', 'GET', '/x', AUDIT)),
    )
    await vi.advanceTimersByTimeAsync(2_000)
    await calls

    expect(sentAt).toHaveLength(4)
    const gaps = sentAt.slice(1).map((t, i) => t - sentAt[i])
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(250)
  })
})
