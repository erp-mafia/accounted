/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

// The flow store is exercised in lib/auth/__tests__/oauth-flows.test.ts and
// tests/pg/oauth-flows.pg.test.ts; here it is a seam so these tests pin the
// callback's routing, binding and delivery only. Host and origin resolution
// stay real (with the brands table mocked) because the hop decision is the
// thing under test.
const {
  mockPeekState,
  mockPeekHandoff,
  mockConsumeState,
  mockConsumeHandoff,
  mockMintHandoff,
  mockResolveBrandByHost,
} = vi.hoisted(() => ({
  mockPeekState: vi.fn(),
  mockPeekHandoff: vi.fn(),
  mockConsumeState: vi.fn(),
  mockConsumeHandoff: vi.fn(),
  mockMintHandoff: vi.fn(),
  mockResolveBrandByHost: vi.fn(),
}))
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandByHost: mockResolveBrandByHost,
  // requireFlowInitiator's login redirect (unused by this callback, which
  // answers its own error page) resolves hosts through the same table.
  resolveBrandResultByHost: async (host: string) => ({
    brand: await mockResolveBrandByHost(host),
    lookupFailed: false,
  }),
}))
vi.mock('@/lib/auth/oauth-flows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/oauth-flows')>()
  return {
    ...actual,
    peekOAuthFlowState: mockPeekState,
    peekOAuthFlowHandoff: mockPeekHandoff,
    consumeOAuthFlowState: mockConsumeState,
    consumeOAuthFlowHandoff: mockConsumeHandoff,
    mintOAuthFlowHandoff: mockMintHandoff,
    createOAuthFlow: vi.fn(),
    purgeExpiredOAuthFlows: vi.fn(),
  }
})

import { after } from 'next/server'
import { skatteverketExtension } from '../index'
import { exchangeCodeForTokens } from '../lib/oauth'
import { storeTokens } from '../lib/token-store'
import { runPostConnectRefresh } from '../lib/post-connect-refresh'
import type { OAuthFlow, OAuthFlowHandoff } from '@/lib/auth/oauth-flows'

const mockExchange = vi.mocked(exchangeCodeForTokens)
const mockStoreTokens = vi.mocked(storeTokens)
const mockRefresh = vi.mocked(runPostConnectRefresh)

const STATE = 'state-1'
const HANDOFF = 'handoff-1'
const OAUTH_HOST = 'https://oauth.example'
const APP = 'https://app.example'
const BRAND = 'https://brand.example'

function flowOn(origin: string, overrides: Partial<OAuthFlow> = {}): OAuthFlow {
  return {
    id: STATE,
    kind: 'skatteverket',
    companyId: 'company-1',
    userId: 'user-1',
    origin,
    redirectUri: `${OAUTH_HOST}/api/extensions/ext/skatteverket/callback`,
    codeVerifier: 'verifier-1',
    connectorState: null,
    returnTo: '/settings/tax',
    ...overrides,
  }
}

function handoffOn(origin: string, overrides: Partial<OAuthFlowHandoff> = {}): OAuthFlowHandoff {
  return { ...flowOn(origin), providerCode: 'abc', providerError: null, ...overrides }
}

/** A live state row: peek sees its identity, consume returns the flow. */
function stateIs(flow: OAuthFlow) {
  mockPeekState.mockResolvedValue({ userId: flow.userId, origin: flow.origin })
  mockConsumeState.mockResolvedValue(flow)
}

/** A live handoff row: peek sees its identity, consume returns the result. */
function handoffIs(handoff: OAuthFlowHandoff) {
  mockPeekHandoff.mockResolvedValue({ userId: handoff.userId, origin: handoff.origin })
  mockConsumeHandoff.mockResolvedValue(handoff)
}

/** Service client: only the membership check runs through it here. */
function makeServiceSupabase(options: { isMember?: boolean } = {}) {
  const isMember = options.isMember ?? true
  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: isMember ? { user_id: 'user-1' } : null })),
  }
  return { from: vi.fn(() => chain) }
}

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

function callbackRequest(origin: string, params: string) {
  return new Request(`${origin}/api/extensions/ext/skatteverket/callback?${params}`)
}

async function expectErrorPage(
  response: Response,
  containing?: string,
  options: { closesTab?: boolean } = {},
) {
  expect(response.status).toBe(200)
  const html = await response.text()
  expect(html).toContain('skatteverket-oauth-error')
  // Once the flow is known the message reaches the opener for certain, so
  // the tab stays open and the reason stays diagnosable. Before the flow is
  // known the target is a guess: the tab closes so a brand opener that never
  // hears the message is still reset by its closed-tab watcher.
  if (options.closesTab) expect(html).toContain('window.close()')
  else expect(html).not.toContain('window.close()')
  if (containing) expect(html).toContain(containing)
  return html
}

describe('skatteverket OAuth callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Hosted shape: the OAuth redirect_uri is pinned to a different host than
    // the app (app.gnubok.se vs app.accounted.se), so hop 1 lands on a host
    // that never carries the app's session cookies.
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
    vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', OAUTH_HOST)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockCreateServiceClient.mockReturnValue(makeServiceSupabase() as any)
    mockCreateClient.mockResolvedValue(makeCookieClient('user-1') as any)
    mockResolveBrandByHost.mockImplementation(async (host: string) =>
      host === 'brand.example' ? { domain: 'brand.example' } : null,
    )
    mockPeekState.mockResolvedValue(null)
    mockPeekHandoff.mockResolvedValue(null)
    mockConsumeState.mockResolvedValue(null)
    mockConsumeHandoff.mockResolvedValue(null)
    mockMintHandoff.mockResolvedValue('handoff-minted')
    mockRefresh.mockResolvedValue({ synced: true, reconciled: 0 } as any)
    mockExchange.mockResolvedValue({
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: Date.now() + 3_600_000,
      refresh_count: 0,
      scope: 'momsdeklaration skahmst agd',
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  describe('hop 1 on the registered OAuth host', () => {
    it('consumes the state, stashes the code and redirects to the initiating brand origin', async () => {
      stateIs(flowOn(BRAND))

      const response = await callbackRoute().handler(
        callbackRequest(OAUTH_HOST, `code=abc&state=${STATE}`),
      )

      expect(response.status).toBe(302)
      const location = new URL(response.headers.get('location') as string)
      expect(location.origin).toBe(BRAND)
      expect(location.pathname).toBe('/api/extensions/ext/skatteverket/callback')
      expect(location.searchParams.get('handoff')).toBe('handoff-minted')
      // Provider credentials never enter the hop-2 URL.
      expect(location.searchParams.has('code')).toBe(false)
      expect(location.searchParams.has('state')).toBe(false)
      expect(response.headers.get('cache-control')).toBe('no-store')

      expect(mockConsumeState).toHaveBeenCalledWith(expect.anything(), STATE, 'skatteverket')
      expect(mockMintHandoff).toHaveBeenCalledWith(expect.anything(), flowOn(BRAND), { providerCode: 'abc' })
      // No session can exist here, so none is read, and nothing is exchanged.
      expect(mockCreateClient).not.toHaveBeenCalled()
      expect(mockExchange).not.toHaveBeenCalled()
      expect(mockStoreTokens).not.toHaveBeenCalled()
    })

    it('hands a plain app user to the app origin the same way', async () => {
      stateIs(flowOn(APP))

      const response = await callbackRoute().handler(
        callbackRequest(OAUTH_HOST, `code=abc&state=${STATE}`),
      )

      expect(response.status).toBe(302)
      expect(new URL(response.headers.get('location') as string).origin).toBe(APP)
      expect(mockExchange).not.toHaveBeenCalled()
    })

    it('carries a provider denial through the handoff instead of answering on the wrong origin', async () => {
      stateIs(flowOn(BRAND))

      const response = await callbackRoute().handler(
        callbackRequest(OAUTH_HOST, `error=access_denied&error_description=Avbrutet&state=${STATE}`),
      )

      expect(response.status).toBe(302)
      expect(new URL(response.headers.get('location') as string).origin).toBe(BRAND)
      expect(mockMintHandoff).toHaveBeenCalledWith(expect.anything(), flowOn(BRAND), { providerError: 'Avbrutet' })
      expect(mockExchange).not.toHaveBeenCalled()
    })

    it('answers the error page for an unknown, expired or replayed state without minting anything', async () => {
      const response = await callbackRoute().handler(
        callbackRequest(OAUTH_HOST, 'code=abc&state=wrong-state'),
      )

      const html = await expectErrorPage(response, 'ogiltig eller förbrukad state', { closesTab: true })
      // Nothing better than the canonical app origin is known for a rejected
      // state; the request's own host is never trusted.
      expect(html).toContain(JSON.stringify(APP))
      expect(mockConsumeState).not.toHaveBeenCalled()
      expect(mockMintHandoff).not.toHaveBeenCalled()
      expect(mockExchange).not.toHaveBeenCalled()
    })

    it('answers the error page when neither code nor error nor state is present', async () => {
      const response = await callbackRoute().handler(callbackRequest(OAUTH_HOST, 'state=only'))
      await expectErrorPage(response, 'Saknar auktoriseringskod', { closesTab: true })
      expect(mockConsumeState).not.toHaveBeenCalled()
    })
  })

  describe('hop 2 on the initiating origin', () => {
    it('binds to the initiator, then claims the handoff for this origin and exchanges the stashed code', async () => {
      handoffIs(handoffOn(BRAND, { connectorState: 'signed-cs' }))
      // A refresh that never settles: if the handler regressed to awaiting
      // it, this test would hang into the vitest timeout instead of passing.
      let refreshStarted = false
      mockRefresh.mockImplementation(() => {
        refreshStarted = true
        return new Promise(() => {})
      })

      const response = await callbackRoute().handler(callbackRequest(BRAND, `handoff=${HANDOFF}`))

      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain('skatteverket-oauth-success')
      expect(html).toContain('window.close()')
      // Both the postMessage target and the no-opener fallback are the
      // origin the flow started on, so the opener tab actually hears it.
      expect(html).toContain(`postMessage({ type: 'skatteverket-oauth-success' }, ${JSON.stringify(BRAND)})`)
      expect(html).toContain(JSON.stringify(`${BRAND}/settings/tax?skv_connected=true`))
      expect(html).not.toContain(APP)

      expect(mockPeekHandoff).toHaveBeenCalledWith(expect.anything(), HANDOFF, BRAND, 'skatteverket')
      expect(mockConsumeHandoff).toHaveBeenCalledWith(expect.anything(), HANDOFF, BRAND, 'skatteverket')
      // The identity check ran before the row was spent.
      expect(mockCreateClient.mock.invocationCallOrder[0]).toBeLessThan(
        mockConsumeHandoff.mock.invocationCallOrder[0]!,
      )
      // The exchange repeats what SKV saw: the registered redirect_uri, the
      // PKCE verifier and the connector state, all from the row.
      expect(mockExchange).toHaveBeenCalledWith(
        'abc',
        `${OAUTH_HOST}/api/extensions/ext/skatteverket/callback`,
        'verifier-1',
        'signed-cs',
      )
      expect(mockStoreTokens).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        expect.objectContaining({ access_token: 'at' }),
        'company-1',
      )
      expect(refreshStarted).toBe(true)
      expect(vi.mocked(after)).toHaveBeenCalledTimes(1)
    })

    it('still succeeds when after() is unavailable (outside a request scope)', async () => {
      handoffIs(handoffOn(BRAND))
      vi.mocked(after).mockImplementation(() => {
        throw new Error('after called outside request scope')
      })

      const response = await callbackRoute().handler(callbackRequest(BRAND, `handoff=${HANDOFF}`))

      expect(response.status).toBe(200)
      expect(await response.text()).toContain('skatteverket-oauth-success')
    })

    it('shows the provider denial on the initiating origin', async () => {
      handoffIs(handoffOn(BRAND, { providerCode: null, providerError: 'Avbrutet' }))

      const response = await callbackRoute().handler(callbackRequest(BRAND, `handoff=${HANDOFF}`))

      const html = await expectErrorPage(response, 'Avbrutet')
      expect(html).toContain(JSON.stringify(BRAND))
      expect(mockExchange).not.toHaveBeenCalled()
    })

    it('rejects an unknown, expired, replayed or wrong-origin handoff', async () => {
      const response = await callbackRoute().handler(callbackRequest(BRAND, `handoff=${HANDOFF}`))

      await expectErrorPage(response, 'ogiltig eller förbrukad state', { closesTab: true })
      expect(mockCreateClient).not.toHaveBeenCalled()
      expect(mockConsumeHandoff).not.toHaveBeenCalled()
      expect(mockExchange).not.toHaveBeenCalled()
    })

    it('sends a session-less arrival to login on the initiating origin, leaving the handoff claimable', async () => {
      handoffIs(handoffOn(BRAND))
      mockCreateClient.mockResolvedValue(makeCookieClient(null) as any)

      const response = await callbackRoute().handler(callbackRequest(BRAND, `handoff=${HANDOFF}`))

      expect(response.status).toBe(307)
      const location = new URL(response.headers.get('location') as string)
      expect(location.origin).toBe(BRAND)
      expect(location.pathname).toBe('/login')
      // Signing in re-runs this exact URL: the row was only peeked, not spent.
      expect(location.searchParams.get('next')).toBe(
        `/api/extensions/ext/skatteverket/callback?handoff=${HANDOFF}`,
      )
      expect(mockConsumeHandoff).not.toHaveBeenCalled()
      expect(mockExchange).not.toHaveBeenCalled()
      expect(mockStoreTokens).not.toHaveBeenCalled()
    })

    it('refuses a different signed-in user without burning the flow for its initiator', async () => {
      // The victim (user-2) was lured into approving user-1's consent.
      handoffIs(handoffOn(BRAND))
      mockCreateClient.mockResolvedValue(makeCookieClient('user-2') as any)

      const response = await callbackRoute().handler(callbackRequest(BRAND, `handoff=${HANDOFF}`))

      const html = await expectErrorPage(response, 'annat användarkonto')
      // Delivered to the initiating origin the row names, and the row is not
      // consumed: user-1 can still finish, user-2 cannot burn it.
      expect(html).toContain(JSON.stringify(BRAND))
      expect(mockConsumeHandoff).not.toHaveBeenCalled()
      // Refused before the exchange: the one-shot code is not burned and no
      // token is written under the initiator's id.
      expect(mockExchange).not.toHaveBeenCalled()
      expect(mockStoreTokens).not.toHaveBeenCalled()
      expect(mockRefresh).not.toHaveBeenCalled()
    })

    it('answers the error page when the handoff is claimed by a concurrent delivery after the identity check', async () => {
      mockPeekHandoff.mockResolvedValue({ userId: 'user-1', origin: BRAND })
      mockConsumeHandoff.mockResolvedValue(null)

      const response = await callbackRoute().handler(callbackRequest(BRAND, `handoff=${HANDOFF}`))

      await expectErrorPage(response, 'ogiltig eller förbrukad state', { closesTab: true })
      expect(mockExchange).not.toHaveBeenCalled()
    })

    it('rejects the flow when the initiator is no longer a member of the company', async () => {
      handoffIs(handoffOn(BRAND))
      mockCreateServiceClient.mockReturnValue(makeServiceSupabase({ isMember: false }) as any)

      const response = await callbackRoute().handler(callbackRequest(BRAND, `handoff=${HANDOFF}`))

      await expectErrorPage(response, 'Behörighet saknas')
      // Rejected before the exchange so the one-shot code is not burned. (#1091)
      expect(mockExchange).not.toHaveBeenCalled()
      expect(mockStoreTokens).not.toHaveBeenCalled()
    })

    it('answers the error page on the initiating origin when the token exchange fails', async () => {
      handoffIs(handoffOn(BRAND))
      mockExchange.mockRejectedValueOnce(new Error('exchange boom'))

      const response = await callbackRoute().handler(callbackRequest(BRAND, `handoff=${HANDOFF}`))

      const html = await expectErrorPage(response, 'exchange boom')
      expect(html).toContain(JSON.stringify(`${BRAND}/settings/tax?skv_error=exchange%20boom`))
      expect(mockRefresh).not.toHaveBeenCalled()
    })
  })

  describe('single hop when the callback host is the app host (self-hosted)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', APP)
    })

    it('binds and exchanges directly without a handoff', async () => {
      stateIs(flowOn(APP, { redirectUri: `${APP}/api/extensions/ext/skatteverket/callback` }))

      const response = await callbackRoute().handler(callbackRequest(APP, `code=abc&state=${STATE}`))

      expect(response.status).toBe(200)
      expect(await response.text()).toContain('skatteverket-oauth-success')
      expect(mockMintHandoff).not.toHaveBeenCalled()
      expect(mockExchange).toHaveBeenCalledWith(
        'abc',
        `${APP}/api/extensions/ext/skatteverket/callback`,
        'verifier-1',
        undefined,
      )
    })

    it('shows the provider denial directly', async () => {
      stateIs(flowOn(APP))

      const response = await callbackRoute().handler(
        callbackRequest(APP, `error=access_denied&error_description=Avbrutet&state=${STATE}`),
      )

      await expectErrorPage(response, 'Avbrutet')
      expect(mockMintHandoff).not.toHaveBeenCalled()
      expect(mockExchange).not.toHaveBeenCalled()
    })

    it('finishes behind a proxy that rewrites Host and drops x-forwarded-proto', async () => {
      // nginx defaults: Next sees http://127.0.0.1:3000 on every hop while
      // /authorize recorded the configured https app origin. Hop 1 compares
      // hosts (mismatch, so it hands off to the public origin) and hop 2
      // resolves the internal host back to the app origin for the claim.
      stateIs(flowOn(APP))
      const hop1 = await callbackRoute().handler(callbackRequest('http://127.0.0.1:3000', `code=abc&state=${STATE}`))
      expect(hop1.status).toBe(302)
      expect(new URL(hop1.headers.get('location') as string).origin).toBe(APP)

      handoffIs(handoffOn(APP))
      const hop2 = await callbackRoute().handler(callbackRequest('http://127.0.0.1:3000', `handoff=${HANDOFF}`))
      expect(hop2.status).toBe(200)
      expect(await hop2.text()).toContain('skatteverket-oauth-success')
      expect(mockConsumeHandoff).toHaveBeenCalledWith(expect.anything(), HANDOFF, APP, 'skatteverket')
    })

    it('treats a proxy-reported http scheme on the app host as the same hop', async () => {
      stateIs(flowOn(APP))
      const response = await callbackRoute().handler(callbackRequest('http://app.example', `code=abc&state=${STATE}`))
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('skatteverket-oauth-success')
      expect(mockMintHandoff).not.toHaveBeenCalled()
    })

    it('sends a session-less completion to login before spending the state', async () => {
      stateIs(flowOn(APP))
      mockCreateClient.mockResolvedValue(makeCookieClient(null) as any)

      const response = await callbackRoute().handler(callbackRequest(APP, `code=abc&state=${STATE}`))

      expect(response.status).toBe(307)
      const location = new URL(response.headers.get('location') as string)
      expect(location.origin).toBe(APP)
      expect(location.pathname).toBe('/login')
      expect(location.searchParams.get('next')).toBe(
        `/api/extensions/ext/skatteverket/callback?code=abc&state=${STATE}`,
      )
      expect(mockConsumeState).not.toHaveBeenCalled()
      expect(mockExchange).not.toHaveBeenCalled()
    })

    it('refuses a different signed-in user here too, leaving the state for its initiator', async () => {
      stateIs(flowOn(APP))
      mockCreateClient.mockResolvedValue(makeCookieClient('user-2') as any)

      const response = await callbackRoute().handler(callbackRequest(APP, `code=abc&state=${STATE}`))

      await expectErrorPage(response, 'annat användarkonto')
      expect(mockConsumeState).not.toHaveBeenCalled()
      expect(mockExchange).not.toHaveBeenCalled()
    })
  })
})

// Connector branch: a self-hosted instance's SKV consent, started through the
// /api/connect/skv broker. The callback must NOT exchange the code here; it
// bounces the browser back to the instance with the code + original state.
describe('skatteverket OAuth callback: connector branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = APP
    process.env.CONNECTOR_STATE_SECRET = 'test-secret'
  })

  it('redirects a valid connector state back to the instance without exchanging the code', async () => {
    const { signConnectorState } = await import('@/lib/connect/hosted/state')
    const signed = signConnectorState({ kid: 'k1', svc: 'skv', ret: 'https://bokforing.example.se/skv/cb', st: 'inst-state', cref: 'company-1' })
    const route = callbackRoute()
    const res = await route.handler(callbackRequest(APP, `code=auth-code&state=${encodeURIComponent(signed)}`))
    expect(res.status).toBe(307)
    const loc = new URL(res.headers.get('location') as string)
    expect(loc.origin + loc.pathname).toBe('https://bokforing.example.se/skv/cb')
    expect(loc.searchParams.get('code')).toBe('auth-code')
    expect(loc.searchParams.get('state')).toBe('inst-state')
    expect(loc.searchParams.get('connector_state')).toBe(signed)
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
    expect(mockPeekState).not.toHaveBeenCalled()
    expect(mockConsumeState).not.toHaveBeenCalled()
  })

  it('rejects a connector state for the wrong service', async () => {
    const { signConnectorState } = await import('@/lib/connect/hosted/state')
    const signed = signConnectorState({ kid: 'k1', svc: 'bank', ret: 'https://bokforing.example.se/cb', st: 's', cref: 'c' })
    const route = callbackRoute()
    const res = await route.handler(callbackRequest(APP, `code=c&state=${encodeURIComponent(signed)}`))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location') as string).searchParams.get('connector_error')).toBe('wrong_service')
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
  })
})
