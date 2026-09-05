import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { createMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * Locks the tenant boundary on the unauthenticated OAuth callback
 * (GET /callback, skipAuth: true).
 *
 * The callback used to decode `state` as plain base64url JSON and trust
 * `consentId` / `provider` straight out of it. Nothing was signed and no
 * server-side session row was checked, so anyone who learned a victim's consent
 * id (it is handed to the browser in the success redirect and postMessage)
 * could run OAuth against their OWN provider account and call the callback with
 * `state=base64url({consentId: victim})`. The attacker's provider tokens landed
 * on the victim's consent, and the victim's next migration imported the
 * attacker's ledger.
 *
 * The callback now resolves everything from a server-written provider_otc row
 * that it consumes atomically. These tests pin that: nothing from the query
 * string reaches exchangeAuthToken, and every state failure looks identical
 * from outside.
 */

vi.mock('../lib/migration-orchestrator', () => ({
  executeMigration: vi.fn().mockResolvedValue({}),
}))

// index.ts imports many helpers from provider-client at module load; stub the
// whole module. The two error classes are real classes because index.ts
// branches on `instanceof`.
vi.mock('../lib/provider-client', () => ({
  createConsent: vi.fn(),
  getConsent: vi.fn(),
  listConsents: vi.fn(),
  generateOtc: vi.fn(),
  consumeOAuthState: vi.fn(),
  mintHandoff: vi.fn(),
  consumeHandoff: vi.fn(),
  getAuthUrl: vi.fn(),
  exchangeAuthToken: vi.fn(),
  submitProviderToken: vi.fn(),
  acceptConsent: vi.fn(),
  deleteConsent: vi.fn(),
  resolveConsent: vi.fn(),
  fetchCompanyInfoDirect: vi.fn(),
  ProviderTokenInvalidError: class ProviderTokenInvalidError extends Error {},
  ProviderCompanyMismatchError: class ProviderCompanyMismatchError extends Error {},
  ConsentNotFoundError: class ConsentNotFoundError extends Error {},
}))

// The /connect handler unconditionally imports this module (for its
// pending-consent token check); the real one pulls in next/headers.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/branding/resolve', () => ({ resolveBrandByHost: vi.fn().mockResolvedValue(null) }))

// The callback also binds the completing browser session to the user recorded
// on the state row. That check has its own tests
// (oauth-callback-initiator.test.ts); here it always passes so these tests
// stay about the state token itself.
vi.mock('@/lib/auth/oauth-flow-binding', () => ({
  requireFlowInitiator: vi.fn(),
  FLOW_INITIATOR_MISMATCH_MESSAGE: 'initiator mismatch',
}))

import { arcimMigrationExtension } from '../index'
import { requireFlowInitiator } from '@/lib/auth/oauth-flow-binding'
import { resolveBrandByHost } from '@/lib/branding/resolve'
import {
  consumeOAuthState,
  mintHandoff,
  consumeHandoff,
  exchangeAuthToken,
  getConsent,
  createConsent,
  listConsents,
  generateOtc,
  getAuthUrl,
  ConsentNotFoundError,
} from '../lib/provider-client'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>

const findRoute = (method: string, path: string) =>
  (arcimMigrationExtension.apiRoutes ?? []).find(
    (r) => r.method === method && r.path === path,
  )!

const callbackHandler = findRoute('GET', '/callback').handler as RouteHandler
const previewHandler = findRoute('GET', '/preview').handler as RouteHandler

// Every state row below was minted by 'user-1', and 'user-1' is the one
// completing the flow. Set per test, after each describe's clearAllMocks.
beforeEach(() => {
  ;(requireFlowInitiator as Mock).mockResolvedValue({ ok: true, userId: 'user-1' })
})

const APP_URL = 'https://app.example.test'

/** The exact string the callback shows for every state failure. */
const GENERIC_REJECTION = 'Ingen giltig migrationssession hittades'

function callbackRequest(params: Record<string, string>) {
  return createMockRequest(
    'http://localhost/api/extensions/ext/arcim-migration/callback',
    { searchParams: params },
  )
}

/** The forged payload the old implementation would have trusted. */
function forgedLegacyState(consentId: string, provider: string) {
  return Buffer.from(JSON.stringify({ consentId, provider })).toString('base64url')
}

describe('white-label OAuth callback handoff', () => {
  const BRAND_ORIGIN = 'https://solbo.accounted.se'
  const path = '/api/extensions/ext/arcim-migration/callback'
  const state = { consentId: 'consent-1', provider: 'fortnox', userId: 'user-1', origin: BRAND_ORIGIN } as const
  const request = (origin: string, params: Record<string, string>) =>
    createMockRequest(`${origin}${path}`, { searchParams: params })
  const storedHandoff = { ...state, providerCode: 'stored-code', providerError: null }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
    vi.stubEnv('FORTNOX_REDIRECT_URI', '')
    vi.stubEnv('VISMA_REDIRECT_URI', '')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(consumeOAuthState).mockResolvedValue(state)
    vi.mocked(mintHandoff).mockResolvedValue({ code: 'fresh-handoff', consentId: 'consent-1', expiresAt: '' })
    vi.mocked(consumeHandoff).mockResolvedValue(storedHandoff)
    vi.mocked(requireFlowInitiator).mockResolvedValue({ ok: true, userId: 'user-1' })
    vi.mocked(resolveBrandByHost).mockResolvedValue(null)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('completes same-origin connects directly and targets that origin', async () => {
    vi.mocked(consumeOAuthState).mockResolvedValue({ ...state, origin: APP_URL })
    const response = await callbackHandler(request(APP_URL, { state: 'state', code: 'code' }))
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(mintHandoff).not.toHaveBeenCalled()
    expect(exchangeAuthToken).toHaveBeenCalledWith('consent-1', 'fortnox', 'code', `${APP_URL}${path}`)
    expect(html).toContain(`}, "${APP_URL}")`)
    expect(html).toContain(`${APP_URL}/import?migration=connected`)
  })

  it('hands off without requiring an app-domain session or exposing the provider code', async () => {
    vi.mocked(requireFlowInitiator).mockResolvedValue({ ok: false, reason: 'no_session', response: new Response(null, { status: 401 }) })
    const response = await callbackHandler(request(APP_URL, {
      state: 'one-time-state', code: 'secret-provider-code', origin: 'https://attacker.test',
    }))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${BRAND_ORIGIN}${path}?handoff=fresh-handoff`)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(consumeOAuthState).toHaveBeenCalledOnce()
    expect(mintHandoff).toHaveBeenCalledWith('consent-1', 'user-1', BRAND_ORIGIN, { providerCode: 'secret-provider-code' })
    expect(requireFlowInitiator).not.toHaveBeenCalled()
    expect(exchangeAuthToken).not.toHaveBeenCalled()
    expect(await response.text()).not.toContain('secret-provider-code')
  })

  it.each(['fortnox', 'visma'] as const)('finishes %s on the brand with stored credentials and the unchanged redirect URI', async (provider) => {
    const redirectUri = `${APP_URL}${path}?configured=1`
    vi.stubEnv(provider === 'fortnox' ? 'FORTNOX_REDIRECT_URI' : 'VISMA_REDIRECT_URI', redirectUri)
    vi.mocked(consumeHandoff).mockResolvedValue({ ...storedHandoff, provider })
    const req = request(BRAND_ORIGIN, {
      handoff: 'fresh-handoff', code: 'injected-code', error: 'injected-error',
      state: 'injected-state', provider: 'bokio', consentId: 'other-consent',
    })
    const response = await callbackHandler(req)
    const html = await response.text()
    expect(consumeHandoff).toHaveBeenCalledWith('fresh-handoff', BRAND_ORIGIN)
    expect(consumeOAuthState).not.toHaveBeenCalled()
    expect(mintHandoff).not.toHaveBeenCalled()
    expect(requireFlowInitiator).toHaveBeenCalledWith(req, 'user-1', { flow: 'arcim-migration.callback' })
    expect(exchangeAuthToken).toHaveBeenCalledWith('consent-1', provider, 'stored-code', redirectUri)
    expect(html).toContain(`}, "${BRAND_ORIGIN}")`)
    expect(html).toContain(`${BRAND_ORIGIN}/import?migration=connected`)
    expect(html).toContain('window.close()')
    expect(html).not.toContain('injected')
  })

  it('hands provider denial off and shows it on the brand without exchanging tokens', async () => {
    const first = await callbackHandler(request(APP_URL, { state: 'state', error: 'access_denied' }))
    expect(first.status).toBe(302)
    const result = vi.mocked(mintHandoff).mock.calls[0][3]
    expect(result.providerError).toContain('Du avbröt anslutningen')
    expect(requireFlowInitiator).not.toHaveBeenCalled()
    vi.mocked(consumeHandoff).mockResolvedValue({ ...storedHandoff, providerCode: null, providerError: result.providerError! })
    const second = await callbackHandler(request(BRAND_ORIGIN, { handoff: 'fresh-handoff' }))
    const html = await second.text()
    expect(requireFlowInitiator).toHaveBeenCalledOnce()
    expect(html).toContain('Du avbröt anslutningen')
    expect(html).toContain(`}, "${BRAND_ORIGIN}")`)
    expect(html).toContain(`${BRAND_ORIGIN}/import?migration=error`)
    expect(html).not.toContain('window.close')
    expect(exchangeAuthToken).not.toHaveBeenCalled()
  })

  it('safely embeds provider error text in both HTML and script contexts', async () => {
    vi.mocked(consumeHandoff).mockResolvedValue({
      ...storedHandoff, providerCode: null, providerError: '</script><img src=x onerror=alert(1)>',
    })
    const html = await (await callbackHandler(request(BRAND_ORIGIN, { handoff: 'fresh-handoff' }))).text()
    expect(html).not.toContain('<img')
    expect(html).toContain('\\u003c/script>')
    expect(html).toContain('&lt;/script&gt;')
  })

  it('rejects a replayed first hop before minting a second handoff', async () => {
    vi.mocked(consumeOAuthState).mockResolvedValueOnce(state).mockResolvedValueOnce(null)
    expect((await callbackHandler(request(APP_URL, { state: 'state', code: 'code' }))).status).toBe(302)
    const replay = await callbackHandler(request(APP_URL, { state: 'state', code: 'code' }))
    expect(await replay.text()).toContain(GENERIC_REJECTION)
    expect(mintHandoff).toHaveBeenCalledOnce()
  })

  it('rejects replayed handoffs after exactly one exchange', async () => {
    vi.mocked(consumeHandoff).mockResolvedValueOnce(storedHandoff).mockResolvedValueOnce(null)
    await callbackHandler(request(BRAND_ORIGIN, { handoff: 'fresh-handoff' }))
    const replay = await callbackHandler(request(BRAND_ORIGIN, { handoff: 'fresh-handoff' }))
    expect(await replay.text()).toContain(GENERIC_REJECTION)
    expect(exchangeAuthToken).toHaveBeenCalledOnce()
  })

  it.each(['expired', 'unknown', 'wrong-origin'])('rejects %s handoffs without exchanging', async (token) => {
    vi.mocked(consumeHandoff).mockResolvedValue(null)
    const response = await callbackHandler(request(BRAND_ORIGIN, { handoff: token }))
    expect(await response.text()).toContain(GENERIC_REJECTION)
    expect(exchangeAuthToken).not.toHaveBeenCalled()
    expect(requireFlowInitiator).not.toHaveBeenCalled()
  })

  it.each(['no_session', 'mismatch'] as const)('refuses hop 2 with %s, including provider-error handoffs', async (reason) => {
    vi.mocked(requireFlowInitiator).mockResolvedValue({ ok: false, reason, response: new Response(null, { status: 403 }), sessionUserId: 'other-user' })
    for (const providerError of [null, 'provider rejected']) {
      vi.mocked(consumeHandoff).mockResolvedValue({ ...storedHandoff, providerError })
      const html = await (await callbackHandler(request(BRAND_ORIGIN, { handoff: 'token' }))).text()
      expect(html).toContain('arcim-oauth-error')
      expect(html).not.toContain('consent-1')
      expect(html).not.toContain('provider rejected')
    }
    expect(exchangeAuthToken).not.toHaveBeenCalled()
  })

  it('refuses a legacy row with no initiator before minting a handoff', async () => {
    vi.mocked(consumeOAuthState).mockResolvedValue({ ...state, userId: null })
    const response = await callbackHandler(request(APP_URL, { state: 'state', code: 'code' }))
    expect(await response.text()).toContain(GENERIC_REJECTION)
    expect(mintHandoff).not.toHaveBeenCalled()
  })

  it.each([
    [APP_URL, false, APP_URL],
    [BRAND_ORIGIN, true, BRAND_ORIGIN],
    ['https://unknown.accounted.se', false, APP_URL],
    ['http://solbo.accounted.se', true, APP_URL],
    ['https://solbo.accounted.se:444', true, APP_URL],
  ])('connect from %s stores only an allowed origin', async (origin, knownBrand, expected) => {
    vi.mocked(resolveBrandByHost).mockResolvedValue(knownBrand ? { domain: 'solbo.accounted.se' } as Awaited<ReturnType<typeof resolveBrandByHost>> : null)
    vi.mocked(listConsents).mockResolvedValue([])
    vi.mocked(createConsent).mockResolvedValue({ id: 'consent-new' } as Awaited<ReturnType<typeof createConsent>>)
    vi.mocked(generateOtc).mockResolvedValue({ code: 'state', consentId: 'consent-new', expiresAt: '' })
    vi.mocked(getAuthUrl).mockResolvedValue({ url: 'https://provider.test/login' })
    const { supabase } = createMockSupabase()
    ;(supabase as unknown as { auth: unknown }).auth = {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    }
    const connect = findRoute('POST', '/connect').handler as RouteHandler
    const response = await connect(createMockRequest(`${origin}/api/extensions/ext/arcim-migration/connect`, {
      method: 'POST', body: { provider: 'fortnox', origin: 'https://attacker.test' },
    }), { supabase, companyId: 'company-1' } as unknown as ExtensionContext)
    expect(response.status).toBe(200)
    expect(generateOtc).toHaveBeenCalledWith('consent-new', 'user-1', expected)
  })

  it.each([
    ['solbo.accounted.se', BRAND_ORIGIN],
    ['unknown.accounted.se', APP_URL],
    ['invalid host', APP_URL],
  ])('reconnect records the validated request Host %s', async (host, expected) => {
    vi.mocked(resolveBrandByHost).mockImplementation(async (value) =>
      value === 'solbo.accounted.se' ? { domain: value } as Awaited<ReturnType<typeof resolveBrandByHost>> : null)
    vi.mocked(listConsents).mockResolvedValue([{ id: 'consent-1', provider: 'fortnox', status: 1 }] as Awaited<ReturnType<typeof listConsents>>)
    vi.mocked(generateOtc).mockResolvedValue({ code: 'state', consentId: 'consent-1', expiresAt: '' })
    vi.mocked(getAuthUrl).mockResolvedValue({ url: 'https://provider.test/login' })
    const ctx = {
      companyId: 'company-1',
      supabase: { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) } },
    } as unknown as ExtensionContext
    const connect = findRoute('POST', '/connect').handler as RouteHandler
    const response = await connect(createMockRequest(`${APP_URL}/api/extensions/ext/arcim-migration/connect`, {
      method: 'POST', headers: { host }, body: { provider: 'fortnox', reconnect: true },
    }), ctx)
    expect(response.status).toBe(200)
    expect(generateOtc).toHaveBeenCalledWith('consent-1', 'user-1', expected)
  })
})

describe('GET /callback: OAuth state binding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
    // The exchange redirect_uri now consults the per-provider override; keep
    // these tests on the NEXT_PUBLIC_APP_URL fallback regardless of local env.
    vi.stubEnv('FORTNOX_REDIRECT_URI', '')
    vi.stubEnv('VISMA_REDIRECT_URI', '')
    // The callback route is dispatched without an ExtensionContext (skipAuth
    // routes get no ctx), so console is the logger. Keep the output quiet.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('rejects a forged state: an unknown token never reaches token exchange', async () => {
    ;(consumeOAuthState as Mock).mockResolvedValue(null)

    const res = await callbackHandler(
      callbackRequest({
        code: 'provider-auth-code',
        state: forgedLegacyState('victim-consent-id', 'fortnox'),
      }),
    )
    const html = await res.text()

    expect(exchangeAuthToken).not.toHaveBeenCalled()
    expect(html).toContain(GENERIC_REJECTION)
    // The response must not echo anything the attacker put in the state.
    expect(html).not.toContain('victim-consent-id')
  })

  it('rejects an expired state with the same generic message as a forged one', async () => {
    // consumeOAuthState collapses expired into "no row": the expiry predicate
    // lives in the UPDATE's WHERE clause (see provider-client tests).
    ;(consumeOAuthState as Mock).mockResolvedValue(null)

    const res = await callbackHandler(
      callbackRequest({ code: 'provider-auth-code', state: 'expired-token' }),
    )
    const html = await res.text()

    expect(exchangeAuthToken).not.toHaveBeenCalled()
    expect(html).toContain(GENERIC_REJECTION)
  })

  it('rejects a replayed state: the second callback with the same token fails', async () => {
    // First delivery consumes the row, second finds nothing left to consume.
    ;(consumeOAuthState as Mock)
      .mockResolvedValueOnce({ consentId: 'consent-1', provider: 'fortnox', userId: 'user-1' })
      .mockResolvedValueOnce(null)

    const first = await callbackHandler(
      callbackRequest({ code: 'provider-auth-code', state: 'one-time-token' }),
    )
    const second = await callbackHandler(
      callbackRequest({ code: 'provider-auth-code', state: 'one-time-token' }),
    )

    expect(await first.text()).toContain('Anslutningen lyckades')
    expect(await second.text()).toContain(GENERIC_REJECTION)
    // Exactly one exchange: the replay bought the attacker nothing.
    expect(exchangeAuthToken).toHaveBeenCalledTimes(1)
    expect(consumeOAuthState).toHaveBeenNthCalledWith(1, 'one-time-token')
    expect(consumeOAuthState).toHaveBeenNthCalledWith(2, 'one-time-token')
  })

  it('takes consent and provider from the state ROW, never from the query string', async () => {
    ;(consumeOAuthState as Mock).mockResolvedValue({
      consentId: 'consent-owned-by-caller',
      provider: 'visma',
      userId: 'user-1',
    })

    // The token names a different consent and provider. It must be ignored:
    // the row wins.
    const res = await callbackHandler(
      callbackRequest({
        code: 'provider-auth-code',
        state: forgedLegacyState('victim-consent-id', 'fortnox'),
      }),
    )

    expect(exchangeAuthToken).toHaveBeenCalledTimes(1)
    expect(exchangeAuthToken).toHaveBeenCalledWith(
      'consent-owned-by-caller',
      'visma',
      'provider-auth-code',
      `${APP_URL}/api/extensions/ext/arcim-migration/callback`,
    )
    expect(await res.text()).toContain('consent-owned-by-caller')
  })
})

/**
 * The callback's no-opener arm used to be near-dead: the wizard only ever
 * reached this route through a popup, which always has a window.opener.
 * ArcimMigrationWorkspace now falls back to a full-page OAuth flow when the
 * popup is blocked (a discarded window.open return value made a blocked popup
 * look exactly like a successful one), so that arm is a live user path and the
 * only way a popup-blocked user finishes the migration.
 *
 * These pin the URL it navigates to, because the wizard reads it on the other
 * end: `/import?migration=...` sets mode='migration'
 * (app/(dashboard)/import/page.tsx:1990) and handleOAuthReturn consumes
 * `consentId` / `reason` from there. Dropping the arm, or renaming a param,
 * would strand every popup-blocked user on this HTML page.
 */
describe('GET /callback: full-page fallback when there is no opener', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  /** The URL the page navigates to when window.opener is absent. */
  function fallbackNavigation(html: string): URL {
    // Both arms are emitted; the opener arm postMessages instead of navigating.
    expect(html).toContain('window.opener')
    // replace(), not href: the callback URL carries a spent one-time state and
    // must not stay in session history. See the replay describe below.
    const match = html.match(/window\.location\.replace\("([^"]+)"\)/)
    expect(match, 'callback HTML has no no-opener navigation').not.toBeNull()
    return new URL(match![1])
  }

  it('sends a successful connect back to the wizard with the consent id', async () => {
    ;(consumeOAuthState as Mock).mockResolvedValue({
      consentId: 'consent-1',
      provider: 'fortnox',
      userId: 'user-1',
    })

    const res = await callbackHandler(
      callbackRequest({ code: 'provider-auth-code', state: 'one-time-token' }),
    )
    const target = fallbackNavigation(await res.text())

    expect(target.origin).toBe(APP_URL)
    expect(target.pathname).toBe('/import')
    expect(target.searchParams.get('migration')).toBe('connected')
    expect(target.searchParams.get('consentId')).toBe('consent-1')
  })

  it('sends a failure back to the wizard with the reason attached', async () => {
    ;(consumeOAuthState as Mock).mockResolvedValue(null)

    const res = await callbackHandler(
      callbackRequest({ code: 'provider-auth-code', state: 'forged-token' }),
    )
    const target = fallbackNavigation(await res.text())

    expect(target.pathname).toBe('/import')
    expect(target.searchParams.get('migration')).toBe('error')
    expect(target.searchParams.get('reason')).toContain(GENERIC_REJECTION)
  })

  it('includes the consent id when a full-page provider error can be resumed', async () => {
    ;(consumeOAuthState as Mock).mockResolvedValue({
      consentId: 'consent-1',
      provider: 'fortnox',
      userId: 'user-1',
    })

    const res = await callbackHandler(
      callbackRequest({
        error: 'access_denied',
        error_description: 'User denied consent',
        state: 'one-time-token',
      }),
    )
    const target = fallbackNavigation(await res.text())

    expect(target.searchParams.get('migration')).toBe('error')
    expect(target.searchParams.get('consentId')).toBe('consent-1')
    expect(exchangeAuthToken).not.toHaveBeenCalled()
  })
})

/**
 * The redirect_uri sent in the authorization request and the one sent in the
 * token exchange must be byte-identical (RFC 6749 §4.1.3) or the provider
 * rejects the code exchange. These broke apart once already: the authorize leg
 * honored the FORTNOX_REDIRECT_URI override while the exchange hardcoded the
 * NEXT_PUBLIC_APP_URL fallback, so when the app moved to app.accounted.se and
 * the env var still pointed at app.gnubok.se, every Fortnox connect died at
 * the exchange with no visible error (the error postMessage was then dropped
 * by the opener's origin check). Both legs now resolve through
 * resolveArcimCallbackUrl; these tests pin the symmetry.
 */
describe('OAuth redirect_uri symmetry between authorize and exchange', () => {
  const OVERRIDE_URI = 'https://dev-tunnel.example.test/api/extensions/ext/arcim-migration/callback'

  const connectHandler = findRoute('POST', '/connect').handler as RouteHandler

  function connectCtx(): ExtensionContext {
    const { supabase } = createMockSupabase()
    ;(supabase as unknown as { auth: unknown }).auth = {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    }
    return { supabase, companyId: 'company-1' } as unknown as ExtensionContext
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
    vi.stubEnv('FORTNOX_REDIRECT_URI', OVERRIDE_URI)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(listConsents as Mock).mockResolvedValue([])
    ;(createConsent as Mock).mockResolvedValue({ id: 'consent-new' })
    ;(generateOtc as Mock).mockResolvedValue({ code: 'otc-code-1' })
    ;(getAuthUrl as Mock).mockResolvedValue({ url: 'https://apps.fortnox.se/oauth-v1/auth?x=1' })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('authorize leg passes the env-override redirect URI to getAuthUrl', async () => {
    const res = await connectHandler(
      createMockRequest('http://localhost/api/extensions/ext/arcim-migration/connect', {
        method: 'POST',
        body: { provider: 'fortnox' },
      }),
      connectCtx(),
    )

    expect(res.status).toBe(200)
    expect(getAuthUrl).toHaveBeenCalledWith(
      'fortnox',
      'otc-code-1',
      OVERRIDE_URI,
      // A first connect never asks for the voucher-attachment scopes: those
      // carry a Fortnox licence requirement and belong to the opt-in underlag
      // reconnect only.
      { documentScopes: undefined },
    )
  })

  // The underlag follow-up is the only caller allowed to widen the consent.
  it('reconnect asks for the attachment scopes only when the underlag flow requests them', async () => {
    ;(listConsents as Mock).mockResolvedValue([
      { id: 'consent-1', provider: 'fortnox', status: 1 },
    ])

    const reconnect = (documentScopes?: boolean) =>
      connectHandler(
        createMockRequest('http://localhost/api/extensions/ext/arcim-migration/connect', {
          method: 'POST',
          body: { provider: 'fortnox', reconnect: true, ...(documentScopes === undefined ? {} : { documentScopes }) },
        }),
        connectCtx(),
      )

    expect((await reconnect(true)).status).toBe(200)
    expect(getAuthUrl).toHaveBeenLastCalledWith(
      'fortnox',
      'otc-code-1',
      OVERRIDE_URI,
      { documentScopes: true },
    )

    expect((await reconnect()).status).toBe(200)
    expect(getAuthUrl).toHaveBeenLastCalledWith(
      'fortnox',
      'otc-code-1',
      OVERRIDE_URI,
      { documentScopes: false },
    )
  })

  it('exchange leg passes the SAME env-override redirect URI to exchangeAuthToken', async () => {
    ;(consumeOAuthState as Mock).mockResolvedValue({
      consentId: 'consent-new',
      provider: 'fortnox',
      userId: 'user-1',
    })

    await callbackHandler(
      callbackRequest({ code: 'provider-auth-code', state: 'one-time-token' }),
    )

    expect(exchangeAuthToken).toHaveBeenCalledWith(
      'consent-new',
      'fortnox',
      'provider-auth-code',
      OVERRIDE_URI,
    )
  })
})

/**
 * The error page must stay open: its postMessage is dropped whenever the
 * popup's origin differs from the opener's, and a window.close() right after
 * turns that into "I approve in Fortnox and then nothing happens". The success
 * page still closes itself.
 */
describe('GET /callback: error popup stays open, success popup closes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('keeps the error popup open with the reason visible', async () => {
    ;(consumeOAuthState as Mock).mockResolvedValue(null)

    const res = await callbackHandler(
      callbackRequest({ code: 'provider-auth-code', state: 'bad-token' }),
    )
    const html = await res.text()

    expect(html).toContain('Anslutningen misslyckades')
    expect(html).not.toContain('window.close')
  })

  it('still closes the success popup', async () => {
    ;(consumeOAuthState as Mock).mockResolvedValue({
      consentId: 'consent-1',
      provider: 'fortnox',
      userId: 'user-1',
    })

    const res = await callbackHandler(
      callbackRequest({ code: 'provider-auth-code', state: 'one-time-token' }),
    )
    const html = await res.text()

    expect(html).toContain('Anslutningen lyckades')
    expect(html).toContain('window.close()')
  })
})

describe('GET /preview: cross-tenant consent status oracle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function buildCtx(): ExtensionContext {
    const { supabase } = createMockSupabase()
    ;(supabase as unknown as { auth: unknown }).auth = {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    }
    return { supabase, companyId: 'company-1' } as unknown as ExtensionContext
  }

  it('scopes the consent read to the caller company', async () => {
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 5, provider: 'fortnox' })

    await previewHandler(
      createMockRequest('http://localhost/api/extensions/ext/arcim-migration/preview', {
        searchParams: { consentId: 'consent-1' },
      }),
      buildCtx(),
    )

    expect(getConsent).toHaveBeenCalledWith('consent-1', 'company-1')
  })

  it('answers 404 without a status for a consent owned by another company', async () => {
    ;(getConsent as Mock).mockRejectedValue(new ConsentNotFoundError())

    const res = await previewHandler(
      createMockRequest('http://localhost/api/extensions/ext/arcim-migration/preview', {
        searchParams: { consentId: 'other-tenants-consent' },
      }),
      buildCtx(),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: Record<string, unknown> }
    }>(res)

    expect(status).toBe(404)
    expect(body.error.code).toBe('PROVIDER_CONSENT_NOT_FOUND')
    // No consent state may leak: not the numeric status, not the provider.
    // 404 with no state is exactly what a nonexistent consent returns too.
    expect(body.error.details ?? {}).not.toHaveProperty('status')
    expect(body.error.details ?? {}).not.toHaveProperty('provider')
  })
})

/**
 * A callback URL is single-use: the state it carries is spent the moment
 * consumeOAuthState returns. Prod caught the consequence of leaving it in
 * session history: a callback that had already succeeded was delivered a
 * second time 19 seconds later, and the user was told "Ingen giltig
 * migrationssession hittades" about a connection that had just worked.
 *
 * The page therefore replaces its history entry instead of pushing one, and
 * the response is no-store so no Back/reload can serve it from cache. The
 * state check itself is deliberately untouched: the callback is
 * unauthenticated, so it still answers consumed, expired, forged and unknown
 * with the same sentence.
 */
describe('GET /callback: the spent callback URL cannot come back', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('sends no-store and replaces history on a successful callback', async () => {
    ;(consumeOAuthState as Mock).mockResolvedValue({
      consentId: 'consent-1',
      provider: 'fortnox',
      userId: 'user-1',
    })

    const res = await callbackHandler(
      callbackRequest({ code: 'provider-auth-code', state: 'one-time-token' }),
    )
    const html = await res.text()

    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(html).toContain('window.location.replace(')
    expect(html).not.toContain('window.location.href')
  })

  it('sends no-store and replaces history on a rejected callback too', async () => {
    ;(consumeOAuthState as Mock).mockResolvedValue(null)

    const res = await callbackHandler(
      callbackRequest({ code: 'provider-auth-code', state: 'spent-token' }),
    )
    const html = await res.text()

    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(html).toContain('window.location.replace(')
    expect(html).not.toContain('window.location.href')
    // The anti-oracle property stands: a consumed state still reads exactly
    // like a forged one.
    expect(html).toContain(GENERIC_REJECTION)
  })
})
