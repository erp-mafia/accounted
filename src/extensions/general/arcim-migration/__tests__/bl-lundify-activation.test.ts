import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockRequest } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import { getErrorEntry } from '@/lib/errors/structured-errors'

/**
 * Björn Lundén through Lundify's activation redirect (issue #2323).
 *
 * BL sends the customer back to our callback as
 * `?publicKey={User-Key}&extra={state}` instead of OAuth's code/state. The
 * callback folds that into the same server-written state row the OAuth
 * providers use, then runs the User-Key through the SAME probe-then-store
 * path as the manual field (submitProviderToken), owned by the consent's own
 * company. These tests pin that nothing about the state handling loosened for
 * BL, and that the activation URL /connect hands out follows BL's format.
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
  mintHandoff: vi.fn(),
  consumeHandoff: vi.fn(),
  getAuthUrl: vi.fn(),
  exchangeAuthToken: vi.fn(),
  submitProviderToken: vi.fn(),
  acceptConsent: vi.fn(),
  deleteConsent: vi.fn(),
  resolveConsent: vi.fn(),
  fetchCompanyInfoDirect: vi.fn(),
  ProviderTokenInvalidError: class ProviderTokenInvalidError extends Error {
    constructor(message: string, public readonly kind: string = 'credentials') {
      super(message)
    }
  },
  ProviderCompanyMismatchError: class ProviderCompanyMismatchError extends Error {},
  ConsentNotFoundError: class ConsentNotFoundError extends Error {},
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/branding/resolve', () => ({ resolveBrandByHost: vi.fn().mockResolvedValue(null) }))

vi.mock('@/lib/auth/oauth-flow-binding', () => ({
  requireFlowInitiator: vi.fn(),
  FLOW_INITIATOR_MISMATCH_MESSAGE: 'initiator mismatch',
}))

import { arcimMigrationExtension } from '../index'
import { requireFlowInitiator } from '@/lib/auth/oauth-flow-binding'
import {
  consumeOAuthState,
  exchangeAuthToken,
  submitProviderToken,
  createConsent,
  listConsents,
  generateOtc,
  getAuthUrl,
  ProviderTokenInvalidError,
} from '../lib/provider-client'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>

const findRoute = (method: string, path: string) =>
  (arcimMigrationExtension.apiRoutes ?? []).find(
    (r) => r.method === method && r.path === path,
  )!

const callbackHandler = findRoute('GET', '/callback').handler as RouteHandler
const connectHandler = findRoute('POST', '/connect').handler as RouteHandler

const APP_URL = 'https://app.example.test'
const CALLBACK_PATH = '/api/extensions/ext/arcim-migration/callback'
const ACTIVATION_KEY = '36b2bf61-0514-4825-a8a5-08cf151176f2'
const USER_KEY = '1f0e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f'

const blState = {
  consentId: 'consent-bl',
  provider: 'bjornlunden',
  companyId: 'company-1',
  userId: 'user-1',
  origin: APP_URL,
} as const

const ctxFor = (userId: string) => ({
  companyId: 'company-1',
  supabase: { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId } } }) } },
}) as unknown as ExtensionContext

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
  vi.stubEnv('FORTNOX_REDIRECT_URI', '')
  vi.stubEnv('VISMA_REDIRECT_URI', '')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(requireFlowInitiator).mockResolvedValue({ ok: true, userId: 'user-1' })
  vi.mocked(consumeOAuthState).mockResolvedValue(blState)
  vi.mocked(submitProviderToken).mockResolvedValue({ success: true, consentId: 'consent-bl' })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /connect for Björn Lundén', () => {
  beforeEach(() => {
    vi.mocked(listConsents).mockResolvedValue([])
    vi.mocked(createConsent).mockResolvedValue({ id: 'consent-bl' } as Awaited<ReturnType<typeof createConsent>>)
    vi.mocked(generateOtc).mockResolvedValue({ code: 'otc-code', consentId: 'consent-bl', expiresAt: '' })
  })

  const connect = (body: Record<string, unknown>) =>
    connectHandler(
      createMockRequest(`${APP_URL}/api/extensions/ext/arcim-migration/connect`, { method: 'POST', body }),
      ctxFor('user-1'),
    )

  it('hands out a Lundify activation URL bound to a fresh state row when BL issued a key', async () => {
    vi.stubEnv('BJORN_LUNDEN_ACTIVATION_KEY', ACTIVATION_KEY)

    const response = await connect({ provider: 'bjornlunden' })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.authType).toBe('token')
    expect(body.consentId).toBe('consent-bl')
    // The state is minted for THIS consent and user, like the OAuth providers.
    expect(generateOtc).toHaveBeenCalledWith('consent-bl', 'user-1', APP_URL)
    expect(body.activationUrl).toBe(
      `https://lundify.com/activate-integration/${ACTIVATION_KEY}/${encodeURIComponent(`${APP_URL}${CALLBACK_PATH}`)}?extra=otc-code`,
    )
    // Not an OAuth provider: no authorization URL is built.
    expect(getAuthUrl).not.toHaveBeenCalled()
  })

  it('keeps the manual User-Key path only when no activation key is configured', async () => {
    vi.stubEnv('BJORN_LUNDEN_ACTIVATION_KEY', '')

    const body = await (await connect({ provider: 'bjornlunden' })).json()

    expect(body.authType).toBe('token')
    expect(body).not.toHaveProperty('activationUrl')
    expect(generateOtc).not.toHaveBeenCalled()
  })

  it('offers the activation URL on reconnect against the stale consent', async () => {
    vi.stubEnv('BJORN_LUNDEN_ACTIVATION_KEY', ACTIVATION_KEY)
    vi.mocked(listConsents).mockResolvedValue([
      { id: 'consent-stale', provider: 'bjornlunden', status: 1 },
    ] as Awaited<ReturnType<typeof listConsents>>)
    vi.mocked(generateOtc).mockResolvedValue({ code: 'otc-2', consentId: 'consent-stale', expiresAt: '' })

    const body = await (await connect({ provider: 'bjornlunden', reconnect: true })).json()

    expect(body).toMatchObject({ consentId: 'consent-stale', authType: 'token', reconnect: true })
    expect(generateOtc).toHaveBeenCalledWith('consent-stale', 'user-1', APP_URL)
    expect(body.activationUrl).toContain('?extra=otc-2')
    expect(createConsent).not.toHaveBeenCalled()
  })

  it('does not hand other token providers an activation URL', async () => {
    vi.stubEnv('BJORN_LUNDEN_ACTIVATION_KEY', ACTIVATION_KEY)

    const body = await (await connect({ provider: 'bokio' })).json()

    expect(body.authType).toBe('token')
    expect(body).not.toHaveProperty('activationUrl')
    expect(generateOtc).not.toHaveBeenCalled()
  })
})

describe('GET /callback from Lundify (publicKey + extra)', () => {
  const request = (params: Record<string, string>) =>
    createMockRequest(`${APP_URL}${CALLBACK_PATH}`, { searchParams: params })

  it('resolves the consent from the state row and stores the User-Key through submitProviderToken', async () => {
    const req = request({ publicKey: USER_KEY, extra: 'otc-code' })
    const response = await callbackHandler(req)
    const html = await response.text()

    expect(response.status).toBe(200)
    // `extra` IS the state: the same atomic consumption as OAuth's `state`.
    expect(consumeOAuthState).toHaveBeenCalledWith('otc-code')
    // The completing session must be the initiator, exactly like OAuth.
    expect(requireFlowInitiator).toHaveBeenCalledWith(req, 'user-1', { flow: 'arcim-migration.callback' })
    // Same probe-then-store as the manual field; owner = the consent's company
    // read server-side, never anything from the query string.
    expect(submitProviderToken).toHaveBeenCalledWith(
      'consent-bl',
      'bjornlunden',
      'client_credentials',
      USER_KEY,
      'company-1',
    )
    expect(exchangeAuthToken).not.toHaveBeenCalled()
    expect(html).toContain('arcim-oauth-success')
    expect(html).toContain(`${APP_URL}/import?migration=connected&consentId=consent-bl`)
  })

  it('shows the registry sentence when the company has not activated the integration', async () => {
    vi.mocked(submitProviderToken).mockRejectedValue(
      new ProviderTokenInvalidError('no scopes', 'integration-not-activated'),
    )

    const html = await (await callbackHandler(request({ publicKey: USER_KEY, extra: 'otc-code' }))).text()

    expect(html).toContain('arcim-oauth-error')
    expect(html).toContain(getErrorEntry('BL_INTEGRATION_NOT_ACTIVATED')!.message_sv)
    expect(html).not.toContain('no scopes')
  })

  it('shows the registry sentence when BL knows no company for the key', async () => {
    vi.mocked(submitProviderToken).mockRejectedValue(
      new ProviderTokenInvalidError('HTTP 500', 'company-key-not-found'),
    )

    const html = await (await callbackHandler(request({ publicKey: USER_KEY, extra: 'otc-code' }))).text()

    expect(html).toContain(getErrorEntry('BL_COMPANY_KEY_NOT_FOUND')!.message_sv)
  })

  it('rejects a publicKey without our state before touching any row', async () => {
    const html = await (await callbackHandler(request({ publicKey: USER_KEY }))).text()

    expect(html).toContain('saknade code eller state')
    expect(consumeOAuthState).not.toHaveBeenCalled()
    expect(submitProviderToken).not.toHaveBeenCalled()
  })

  it('rejects a forged or replayed extra with the generic message and stores nothing', async () => {
    vi.mocked(consumeOAuthState).mockResolvedValue(null)

    const html = await (await callbackHandler(request({ publicKey: USER_KEY, extra: 'forged' }))).text()

    expect(html).toContain('Ingen giltig migrationssession hittades')
    expect(submitProviderToken).not.toHaveBeenCalled()
    expect(requireFlowInitiator).not.toHaveBeenCalled()
  })

  it('refuses a completing session that is not the initiator', async () => {
    vi.mocked(requireFlowInitiator).mockResolvedValue({
      ok: false,
      reason: 'mismatch',
      response: new Response(null, { status: 403 }),
      sessionUserId: 'other-user',
    })

    const html = await (await callbackHandler(request({ publicKey: USER_KEY, extra: 'otc-code' }))).text()

    expect(html).toContain('initiator mismatch')
    expect(submitProviderToken).not.toHaveBeenCalled()
  })

  it('does not let a publicKey override an OAuth code on the same request', async () => {
    vi.mocked(consumeOAuthState).mockResolvedValue({ ...blState, provider: 'fortnox' })

    await callbackHandler(request({ code: 'oauth-code', state: 'otc-code', publicKey: USER_KEY, extra: 'other' }))

    expect(consumeOAuthState).toHaveBeenCalledWith('otc-code')
    expect(exchangeAuthToken).toHaveBeenCalledWith('consent-bl', 'fortnox', 'oauth-code', `${APP_URL}${CALLBACK_PATH}`)
    expect(submitProviderToken).not.toHaveBeenCalled()
  })
})
