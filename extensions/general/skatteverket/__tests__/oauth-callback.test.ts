/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// after() must be observable: the callback hands it the eager refresh
// promise so the serverless function stays alive past the response.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: vi.fn() }
})

vi.mock('../lib/oauth', () => ({
  buildAuthorizeUrl: vi.fn().mockReturnValue('https://skv.test/authorize'),
  generatePkcePair: vi.fn().mockReturnValue({ verifier: 'v', challenge: 'c' }),
  exchangeCodeForTokens: vi.fn(),
}))

vi.mock('../lib/token-store', () => ({
  storeTokens: vi.fn().mockResolvedValue(undefined),
  getTokens: vi.fn().mockResolvedValue(null),
  deleteTokens: vi.fn().mockResolvedValue(undefined),
  getTokenHealth: vi.fn().mockResolvedValue(null),
  markNeedsReconsent: vi.fn().mockResolvedValue(undefined),
  RECONSENT_ERROR_CODES: ['SESSION_EXPIRED', 'REFRESH_EXHAUSTED', 'MISSING_SCOPE', 'TOKEN_CORRUPTED'],
}))

vi.mock('../lib/post-connect-refresh', () => ({
  runPostConnectRefresh: vi.fn(),
}))

const { mockCreateClient, mockCreateServiceClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockCreateServiceClient: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: mockCreateClient,
  createServiceClient: mockCreateServiceClient,
}))

import { after } from 'next/server'
import { skatteverketExtension } from '../index'
import { exchangeCodeForTokens } from '../lib/oauth'
import { storeTokens } from '../lib/token-store'
import { runPostConnectRefresh } from '../lib/post-connect-refresh'

const mockExchange = vi.mocked(exchangeCodeForTokens)
const mockStoreTokens = vi.mocked(storeTokens)
const mockRefresh = vi.mocked(runPostConnectRefresh)

const STATE = 'state-1'

/**
 * Service-client mock covering the callback's extension_data access:
 * awaiting the query chain directly returns the oauth_state row listing
 * (the company resolution), .maybeSingle() returns the per-key setting for
 * whichever key the chain last filtered on, and the post-exchange cleanup
 * delete resolves via .in().
 */
function makeServiceSupabase(
  overrides: Record<string, string | null> = {},
  options: { isMember?: boolean } = {},
) {
  const values: Record<string, string | null> = {
    oauth_state: STATE,
    oauth_user_id: 'user-1',
    oauth_redirect_uri: 'https://app.example/api/extensions/ext/skatteverket/callback',
    oauth_code_verifier: 'verifier-1',
    oauth_return_to: '/settings/tax',
    ...overrides,
  }
  const isMember = options.isMember ?? true
  const gte = vi.fn()
  const inCalls: string[][] = []
  const from = vi.fn((table: string) => {
    let key: string | null = null
    const chain: any = {
      select: vi.fn(() => chain),
      delete: vi.fn(() => chain),
      eq: vi.fn((col: string, val: string) => {
        if (col === 'key') key = val
        return chain
      }),
      gte: gte.mockImplementation(() => chain),
      in: vi.fn((_col: string, keys: string[]) => {
        inCalls.push(keys)
        return Promise.resolve({ error: null })
      }),
      maybeSingle: vi.fn(async () => {
        if (table === 'company_members') {
          return { data: isMember ? { user_id: values.oauth_user_id ?? 'user-1' } : null }
        }
        return {
          data: key !== null && values[key] != null ? { value: values[key] } : null,
        }
      }),
      then: (resolve: any, reject: any) => {
        const rows =
          values.oauth_state != null
            ? [{ company_id: 'company-1', value: values.oauth_state }]
            : []
        return Promise.resolve({ data: rows }).then(resolve, reject)
      },
    }
    return chain
  })
  return { from, gte, inCalls }
}

/** Cookie-bound client: only consulted by the legacy session fallback. */
function makeCookieClient(userId: string | null) {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: userId ? { id: userId } : null } })),
    },
  }
}

function callbackRoute() {
  const route = skatteverketExtension.apiRoutes?.find(
    (r) => r.method === 'GET' && r.path === '/callback',
  )
  expect(route, 'GET /callback must be registered').toBeDefined()
  expect(route!.skipAuth).toBe(true)
  return route!
}

function callbackRequest(params: string) {
  return new Request(
    `https://app.example/api/extensions/ext/skatteverket/callback?${params}`,
  )
}

describe('skatteverket OAuth callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateServiceClient.mockReturnValue(makeServiceSupabase() as any)
    // No session cookies by default: the callback is served on the pinned
    // OAuth host (app.gnubok.se), where the user-facing app's session does
    // not exist. Every happy-path test doubles as a cookie-free proof.
    mockCreateClient.mockResolvedValue(makeCookieClient(null) as any)
    mockExchange.mockResolvedValue({
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: Date.now() + 3_600_000,
      refresh_count: 0,
      scope: 'momsdeklaration skahmst agd',
    })
  })

  it('responds with the success page WITHOUT awaiting the post-connect refresh', async () => {
    // A refresh that never settles: if the handler regressed to awaiting it,
    // this test would hang into the vitest timeout instead of passing.
    let refreshStarted = false
    mockRefresh.mockImplementation(() => {
      refreshStarted = true
      return new Promise(() => {})
    })

    const response = await callbackRoute().handler(
      callbackRequest(`code=abc&state=${STATE}`),
    )

    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('skatteverket-oauth-success')
    expect(html).toContain('window.close()')

    expect(mockExchange).toHaveBeenCalledWith(
      'abc',
      'https://app.example/api/extensions/ext/skatteverket/callback',
      'verifier-1',
      undefined,
    )
    expect(mockStoreTokens).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.objectContaining({ access_token: 'at' }),
      'company-1',
    )
    // The stored oauth_user_id resolved the user; the cookie-bound client
    // must never be needed on the modern path.
    expect(mockCreateClient).not.toHaveBeenCalled()
    // The state lookup must be recency-bounded: an old state row (leaked or
    // phished authorize URL) must not stay completable indefinitely.
    const service = mockCreateServiceClient.mock.results[0]!.value
    expect(service.gte).toHaveBeenCalledWith('updated_at', expect.any(String))
    // The refresh was started eagerly and handed to after() so it survives
    // past the response; it must not gate the response itself.
    expect(refreshStarted).toBe(true)
    expect(vi.mocked(after)).toHaveBeenCalledTimes(1)
  })

  it('still succeeds when after() is unavailable (outside a request scope)', async () => {
    mockRefresh.mockResolvedValue({ synced: true, reconciled: 0 })
    vi.mocked(after).mockImplementation(() => {
      throw new Error('after called outside request scope')
    })

    const response = await callbackRoute().handler(
      callbackRequest(`code=abc&state=${STATE}`),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('skatteverket-oauth-success')
  })

  it('falls back to the session cookie for flows started before oauth_user_id shipped', async () => {
    mockCreateServiceClient.mockReturnValue(
      makeServiceSupabase({ oauth_user_id: null }) as any,
    )
    mockCreateClient.mockResolvedValue(makeCookieClient('legacy-user') as any)
    mockRefresh.mockResolvedValue({ synced: true, reconciled: 0 })

    const response = await callbackRoute().handler(
      callbackRequest(`code=abc&state=${STATE}`),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('skatteverket-oauth-success')
    expect(mockStoreTokens).toHaveBeenCalledWith(
      expect.anything(),
      'legacy-user',
      expect.objectContaining({ access_token: 'at' }),
      'company-1',
    )
  })

  it('returns the error page when neither a stored user id nor a session exists', async () => {
    mockCreateServiceClient.mockReturnValue(
      makeServiceSupabase({ oauth_user_id: null }) as any,
    )

    const response = await callbackRoute().handler(
      callbackRequest(`code=abc&state=${STATE}`),
    )

    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('skatteverket-oauth-error')
    expect(mockExchange).not.toHaveBeenCalled()
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('returns the error page on a state (CSRF) mismatch without exchanging the code', async () => {
    const response = await callbackRoute().handler(
      callbackRequest('code=abc&state=wrong-state'),
    )

    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('skatteverket-oauth-error')
    expect(mockExchange).not.toHaveBeenCalled()
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('returns the error page when the token exchange fails', async () => {
    mockExchange.mockRejectedValueOnce(new Error('exchange boom'))

    const response = await callbackRoute().handler(
      callbackRequest(`code=abc&state=${STATE}`),
    )

    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('skatteverket-oauth-error')
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('cleans up the ephemeral state rows (incl. oauth_user_id) when the exchange fails', async () => {
    const service = makeServiceSupabase()
    mockCreateServiceClient.mockReturnValue(service as any)
    mockExchange.mockRejectedValueOnce(new Error('exchange boom'))

    await callbackRoute().handler(callbackRequest(`code=abc&state=${STATE}`))

    // The failure path must delete the same ephemeral keys the success
    // path does: oauth_user_id holds a user identity and must not be
    // retained past the flow. (#1090)
    expect(service.inCalls).toHaveLength(1)
    expect(service.inCalls[0]).toEqual(
      expect.arrayContaining(['oauth_state', 'oauth_user_id', 'oauth_code_verifier']),
    )
  })

  it('passes a stored connector_state into the exchange and cleans it up (connector-mode instance)', async () => {
    const service = makeServiceSupabase({ oauth_connector_state: 'signed-cs' })
    mockCreateServiceClient.mockReturnValue(service as any)
    mockRefresh.mockResolvedValue({ synced: true, reconciled: 0 } as any)

    const response = await callbackRoute().handler(
      callbackRequest(`code=abc&state=${STATE}`),
    )

    expect(response.status).toBe(200)
    expect(mockExchange).toHaveBeenCalledWith(
      'abc',
      'https://app.example/api/extensions/ext/skatteverket/callback',
      'verifier-1',
      'signed-cs',
    )
    // The one-shot connector state must be deleted with the other flow rows.
    expect(service.inCalls[0]).toEqual(expect.arrayContaining(['oauth_connector_state']))
  })

  it('falls back to the bounced connector_state query param when no row was stored', async () => {
    mockRefresh.mockResolvedValue({ synced: true, reconciled: 0 } as any)

    const response = await callbackRoute().handler(
      callbackRequest(`code=abc&state=${STATE}&connector_state=bounced-cs`),
    )

    expect(response.status).toBe(200)
    expect(mockExchange).toHaveBeenCalledWith(
      'abc',
      'https://app.example/api/extensions/ext/skatteverket/callback',
      'verifier-1',
      'bounced-cs',
    )
  })

  it('rejects the flow when the stored user is no longer a member of the company', async () => {
    mockCreateServiceClient.mockReturnValue(
      makeServiceSupabase({}, { isMember: false }) as any,
    )

    const response = await callbackRoute().handler(
      callbackRequest(`code=abc&state=${STATE}`),
    )

    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('skatteverket-oauth-error')
    // Rejected before the exchange so the one-shot code is not burned,
    // and no token write is attempted. (#1091)
    expect(mockExchange).not.toHaveBeenCalled()
    expect(mockStoreTokens).not.toHaveBeenCalled()
  })
})

// Connector branch: a self-hosted instance's SKV consent, started through the
// /api/connect/skv broker. The callback must NOT exchange the code here; it
// bounces the browser back to the instance with the code + original state.
describe('skatteverket OAuth callback: connector branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example'
    process.env.CONNECTOR_STATE_SECRET = 'test-secret'
  })

  it('redirects a valid connector state back to the instance without exchanging the code', async () => {
    const { signConnectorState } = await import('@/lib/connect/hosted/state')
    const signed = signConnectorState({ kid: 'k1', svc: 'skv', ret: 'https://bokforing.example.se/skv/cb', st: 'inst-state', cref: 'company-1' })
    const route = callbackRoute()
    const res = await route.handler(callbackRequest(`code=auth-code&state=${encodeURIComponent(signed)}`))
    expect(res.status).toBe(307)
    const loc = new URL(res.headers.get('location') as string)
    expect(loc.origin + loc.pathname).toBe('https://bokforing.example.se/skv/cb')
    expect(loc.searchParams.get('code')).toBe('auth-code')
    expect(loc.searchParams.get('state')).toBe('inst-state')
    expect(loc.searchParams.get('connector_state')).toBe(signed)
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
  })

  it('rejects a connector state for the wrong service', async () => {
    const { signConnectorState } = await import('@/lib/connect/hosted/state')
    const signed = signConnectorState({ kid: 'k1', svc: 'bank', ret: 'https://bokforing.example.se/cb', st: 's', cref: 'c' })
    const route = callbackRoute()
    const res = await route.handler(callbackRequest(`code=c&state=${encodeURIComponent(signed)}`))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location') as string).searchParams.get('connector_error')).toBe('wrong_service')
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
  })
})

