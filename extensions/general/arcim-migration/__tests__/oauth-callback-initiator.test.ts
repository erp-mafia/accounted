import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { createMockRequest } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * Binds the OAuth callback to the user who STARTED the flow.
 *
 * oauth-callback-state.test.ts pins that the callback trusts nothing but the
 * server-written state row. That row proves the callback belongs to a flow we
 * started; it does not say who is finishing it. The authorize URL is
 * shareable, so a victim lured into approving a Fortnox/Visma consent that an
 * attacker started would have their provider account bound to the attacker's
 * consent, and the attacker's next migration would import the victim's ledger.
 *
 * The state row now records the initiator (provider_otc.user_id, written by
 * generateOtc from /connect) and the callback requires the completing
 * browser's own session to be that user before the code is exchanged. The
 * binding helper is the real one; only the cookie session behind it is faked.
 */

vi.mock('../lib/migration-orchestrator', () => ({
  executeMigration: vi.fn().mockResolvedValue({}),
}))

vi.mock('../lib/provider-client', () => ({
  createConsent: vi.fn(),
  getConsent: vi.fn(),
  listConsents: vi.fn(),
  generateOtc: vi.fn(),
  consumeOAuthState: vi.fn(),
  getAuthUrl: vi.fn(),
  exchangeAuthToken: vi.fn(),
  submitProviderToken: vi.fn(),
  acceptConsent: vi.fn(),
  deleteConsent: vi.fn(),
  resolveConsent: vi.fn(),
  fetchCompanyInfoDirect: vi.fn(),
  ProviderTokenInvalidError: class ProviderTokenInvalidError extends Error {},
  // Mirrors the real constructor and message so the callback's mapping from
  // this error to the Swedish registry sentence is exercised for real.
  ProviderCompanyMismatchError: class ProviderCompanyMismatchError extends Error {
    constructor(
      public readonly expectedOrgNumber: string,
      public readonly actualOrgNumber: string,
      public readonly actualCompanyName: string | null,
    ) {
      super(
        `Provider company mismatch: credentials open ${actualOrgNumber}, ` +
          `but the target company is ${expectedOrgNumber}`,
      )
    }
  },
  ConsentNotFoundError: class ConsentNotFoundError extends Error {},
}))

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: mockCreateClient,
  createServiceClient: vi.fn(),
}))

import { arcimMigrationExtension } from '../index'
import {
  consumeOAuthState,
  exchangeAuthToken,
  generateOtc,
  getAuthUrl,
  listConsents,
  createConsent,
  ProviderCompanyMismatchError,
} from '../lib/provider-client'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>

const findRoute = (method: string, path: string) =>
  (arcimMigrationExtension.apiRoutes ?? []).find((r) => r.method === method && r.path === path)!

const callbackHandler = findRoute('GET', '/callback').handler as RouteHandler
const connectHandler = findRoute('POST', '/connect').handler as RouteHandler

const APP_URL = 'https://app.example.test'
const STATE_REJECTED = 'Ingen giltig migrationssession hittades'

/** The browser completing the callback is signed in as `userId` (or nobody). */
function useSession(userId: string | null) {
  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
        error: null,
      }),
    },
  })
}

function callbackRequest(params: Record<string, string>) {
  return createMockRequest(`${APP_URL}/api/extensions/ext/arcim-migration/callback`, {
    searchParams: params,
  })
}

function connectCtx(userId = 'user-1'): ExtensionContext {
  return {
    supabase: { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId } } }) } },
    companyId: 'company-1',
    userId,
  } as unknown as ExtensionContext
}

describe('GET /callback: the completing session must be the initiator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
    vi.stubEnv('FORTNOX_REDIRECT_URI', '')
    vi.stubEnv('VISMA_REDIRECT_URI', '')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(consumeOAuthState as Mock).mockResolvedValue({
      consentId: 'consent-1',
      provider: 'fortnox',
      userId: 'user-1',
    })
    ;(exchangeAuthToken as Mock).mockResolvedValue({ success: true, consentId: 'consent-1' })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('finalises when the browser session belongs to the user who started the flow', async () => {
    useSession('user-1')

    const res = await callbackHandler(callbackRequest({ code: 'provider-auth-code', state: 'otc' }))
    const html = await res.text()

    expect(exchangeAuthToken).toHaveBeenCalledTimes(1)
    expect(exchangeAuthToken).toHaveBeenCalledWith(
      'consent-1',
      'fortnox',
      'provider-auth-code',
      `${APP_URL}/api/extensions/ext/arcim-migration/callback`,
    )
    expect(html).toContain('Anslutningen lyckades')
  })

  it('refuses a completion by a different signed-in user without exchanging the code', async () => {
    // The victim (user-2) was lured into approving user-1's consent.
    useSession('user-2')

    const res = await callbackHandler(callbackRequest({ code: 'provider-auth-code', state: 'otc' }))
    const html = await res.text()

    expect(exchangeAuthToken).not.toHaveBeenCalled()
    expect(html).toContain('Anslutningen misslyckades')
    expect(html).toContain('annat användarkonto')
    // The refused party learns nothing about the consent it tried to complete.
    expect(html).not.toContain('consent-1')
    // Error popups stay open (see oauth-callback-state.test.ts).
    expect(html).not.toContain('window.close')
  })

  it('refuses a completion with no session at all and asks for a fresh connect', async () => {
    useSession(null)

    const res = await callbackHandler(callbackRequest({ code: 'provider-auth-code', state: 'otc' }))
    const html = await res.text()

    expect(exchangeAuthToken).not.toHaveBeenCalled()
    // The state is already spent (consumed atomically before the check), so
    // the only way forward is a new connect, not a login-and-retry.
    expect(consumeOAuthState).toHaveBeenCalledWith('otc')
    expect(html).toContain('Logga in och starta om anslutningen')
    expect(html).not.toContain('consent-1')
  })

  it('refuses a state row that records no initiator, with the generic state rejection', async () => {
    // Rows minted before provider_otc.user_id existed: nobody to bind to.
    ;(consumeOAuthState as Mock).mockResolvedValue({
      consentId: 'consent-1',
      provider: 'fortnox',
      userId: null,
    })
    useSession('user-1')

    const res = await callbackHandler(callbackRequest({ code: 'provider-auth-code', state: 'otc' }))
    const html = await res.text()

    expect(exchangeAuthToken).not.toHaveBeenCalled()
    expect(mockCreateClient).not.toHaveBeenCalled()
    expect(html).toContain(STATE_REJECTED)
  })

  it('reports valid tokens for the WRONG company in Swedish and never claims success', async () => {
    useSession('user-1')
    ;(exchangeAuthToken as Mock).mockRejectedValue(
      new ProviderCompanyMismatchError('5560160680', '5567037485', 'Annat Bolag AB'),
    )

    const res = await callbackHandler(callbackRequest({ code: 'provider-auth-code', state: 'otc' }))
    const html = await res.text()

    expect(html).toContain('Anslutningen misslyckades')
    expect(html).toContain('Uppgifterna gäller ett annat företag')
    expect(html).not.toContain('Provider company mismatch')
    expect(html).not.toContain('Anslutningen lyckades')
  })
})

describe('POST /connect: the state row records who started the flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
    vi.stubEnv('FORTNOX_REDIRECT_URI', '')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(generateOtc as Mock).mockResolvedValue({ code: 'otc-code-1' })
    ;(getAuthUrl as Mock).mockResolvedValue({ url: 'https://apps.fortnox.se/oauth-v1/auth?x=1' })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('binds a first connect to the caller', async () => {
    ;(listConsents as Mock).mockResolvedValue([])
    ;(createConsent as Mock).mockResolvedValue({ id: 'consent-new' })

    const res = await connectHandler(
      createMockRequest(`${APP_URL}/api/extensions/ext/arcim-migration/connect`, {
        method: 'POST',
        body: { provider: 'fortnox' },
      }),
      connectCtx('user-1'),
    )

    expect(res.status).toBe(200)
    expect(generateOtc).toHaveBeenCalledWith('consent-new', 'user-1')
  })

  it('binds a reconnect of an existing consent to the caller too', async () => {
    ;(listConsents as Mock).mockResolvedValue([{ id: 'consent-1', provider: 'fortnox', status: 1 }])

    const res = await connectHandler(
      createMockRequest(`${APP_URL}/api/extensions/ext/arcim-migration/connect`, {
        method: 'POST',
        body: { provider: 'fortnox', reconnect: true },
      }),
      connectCtx('user-1'),
    )

    expect(res.status).toBe(200)
    expect(generateOtc).toHaveBeenCalledWith('consent-1', 'user-1')
  })
})
