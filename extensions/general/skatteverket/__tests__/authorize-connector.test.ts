/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The route is exercised through the extension registration; the connector
// seam, the paywall gate and the flow store are mocked so the test pins ONLY
// the /authorize wiring: what is recorded, and where the browser is sent.
const { mockConnectorMode, mockStartAuth } = vi.hoisted(() => ({
  mockConnectorMode: vi.fn(),
  mockStartAuth: vi.fn(),
}))
vi.mock('../lib/connector-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/connector-mode')>()
  return {
    ...actual,
    skatteverketConnectorMode: mockConnectorMode,
    startConnectorAuthorization: mockStartAuth,
  }
})

vi.mock('../lib/oauth', () => ({
  buildAuthorizeUrl: vi.fn().mockReturnValue('https://skv.test/authorize?direct=1'),
  generatePkcePair: vi.fn().mockReturnValue({ verifier: 'pkce-v', challenge: 'pkce-c' }),
  exchangeCodeForTokens: vi.fn(),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: vi.fn(async () => null),
}))

const { mockCreateFlow, mockPurge, mockResolveOrigin, mockNewId } = vi.hoisted(() => ({
  mockCreateFlow: vi.fn(),
  mockPurge: vi.fn(),
  mockResolveOrigin: vi.fn(),
  mockNewId: vi.fn(),
}))
vi.mock('@/lib/auth/oauth-flows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/oauth-flows')>()
  return {
    ...actual,
    createOAuthFlow: mockCreateFlow,
    purgeExpiredOAuthFlows: mockPurge,
    resolveOAuthOrigin: mockResolveOrigin,
    newOAuthFlowId: mockNewId,
  }
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => ({ tag: 'service' })),
}))

import { skatteverketExtension } from '../index'
import { buildAuthorizeUrl } from '../lib/oauth'

function authorizeRoute() {
  const route = skatteverketExtension.apiRoutes?.find(
    (r) => r.method === 'GET' && r.path === '/authorize',
  )
  expect(route, 'GET /authorize must be registered').toBeDefined()
  return route!
}

const ctx = {
  userId: 'user-1',
  companyId: 'company-1',
  supabase: {} as any,
  settings: { set: vi.fn(), clear: vi.fn(), get: vi.fn(async () => null) },
} as any

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://instans.example.se'
  delete process.env.NEXT_PUBLIC_SKV_OAUTH_BASE_URL
  mockNewId.mockReturnValue('state-fixed')
  mockResolveOrigin.mockResolvedValue('https://instans.example.se')
  mockPurge.mockResolvedValue(undefined)
  mockCreateFlow.mockResolvedValue(undefined)
})

describe('skatteverket /authorize: connector mode', () => {
  beforeEach(() => {
    mockConnectorMode.mockReturnValue({
      baseUrl: 'https://app.hosted.example/api/connect/skv',
      key: 'gnubok_ck_test',
    })
    mockStartAuth.mockResolvedValue({
      authorizeUrl: 'https://peroauth2.test.skatteverket.se/oauth2/v1/per/authorize?broker=1',
      redirectUri: 'https://app.hosted.example/api/extensions/ext/skatteverket/callback',
      connectorState: 'signed-cs',
    })
  })

  it('starts the consent through the broker and records its redirect_uri + connector_state on the flow', async () => {
    const res = await authorizeRoute().handler(
      new Request('https://instans.example.se/api/extensions/ext/skatteverket/authorize'),
      ctx,
    )

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(
      'https://peroauth2.test.skatteverket.se/oauth2/v1/per/authorize?broker=1',
    )

    expect(mockStartAuth).toHaveBeenCalledWith(
      { baseUrl: 'https://app.hosted.example/api/connect/skv', key: 'gnubok_ck_test' },
      {
        companyRef: 'company-1',
        // The instance's own callback: where the hosted SKV callback bounces
        // the browser back to.
        returnUrl: 'https://instans.example.se/api/extensions/ext/skatteverket/callback',
        state: 'state-fixed',
        codeChallenge: 'pkce-c',
      },
    )
    // The BROKER's redirect_uri (what SKV saw) is what the token exchange
    // must repeat, so it replaces the locally computed one.
    expect(mockCreateFlow).toHaveBeenCalledWith(
      { tag: 'service' },
      {
        id: 'state-fixed',
        kind: 'skatteverket',
        companyId: 'company-1',
        userId: 'user-1',
        origin: 'https://instans.example.se',
        redirectUri: 'https://app.hosted.example/api/extensions/ext/skatteverket/callback',
        codeVerifier: 'pkce-v',
        connectorState: 'signed-cs',
        returnTo: null,
      },
    )
    expect(buildAuthorizeUrl).not.toHaveBeenCalled()
    // Nothing goes through extension settings any more.
    expect(ctx.settings.set).not.toHaveBeenCalled()
  })

  it('answers 502 with operator guidance when the broker refuses, recording no flow', async () => {
    mockStartAuth.mockRejectedValueOnce(new Error('Connector authorize-url failed (403): quota'))
    const res = await authorizeRoute().handler(
      new Request('https://instans.example.se/api/extensions/ext/skatteverket/authorize'),
      ctx,
    )

    expect(res.status).toBe(502)
    const body = await (res as Response).json()
    expect(body.error).toMatch(/GNUBOK_CONNECTOR_KEY/)
    expect(mockCreateFlow).not.toHaveBeenCalled()
  })
})

describe('skatteverket /authorize: direct mode', () => {
  beforeEach(() => {
    mockConnectorMode.mockReturnValue(null)
  })

  it('builds the authorize URL locally and records the validated origin, return path and PKCE verifier', async () => {
    process.env.NEXT_PUBLIC_SKV_OAUTH_BASE_URL = 'https://oauth.example'
    mockResolveOrigin.mockResolvedValue('https://brand.example')

    const res = await authorizeRoute().handler(
      new Request('https://brand.example/api/extensions/ext/skatteverket/authorize?return_to=%2Fsettings%2Ftax'),
      ctx,
    )

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://skv.test/authorize?direct=1')
    expect(mockStartAuth).not.toHaveBeenCalled()
    expect(buildAuthorizeUrl).toHaveBeenCalledWith(
      'https://oauth.example/api/extensions/ext/skatteverket/callback',
      'state-fixed',
      { codeChallenge: 'pkce-c' },
    )
    expect(mockCreateFlow).toHaveBeenCalledWith(
      { tag: 'service' },
      expect.objectContaining({
        id: 'state-fixed',
        origin: 'https://brand.example',
        redirectUri: 'https://oauth.example/api/extensions/ext/skatteverket/callback',
        codeVerifier: 'pkce-v',
        connectorState: null,
        returnTo: '/settings/tax',
      }),
    )
    // Expired rows are swept on the way in, best-effort.
    expect(mockPurge).toHaveBeenCalledTimes(1)
  })

  it('drops a return_to that is not an in-app path', async () => {
    await authorizeRoute().handler(
      new Request('https://instans.example.se/api/extensions/ext/skatteverket/authorize?return_to=//evil.example'),
      ctx,
    )
    expect(mockCreateFlow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ returnTo: null }),
    )
  })

  it('still starts the flow when the purge fails', async () => {
    mockPurge.mockRejectedValueOnce(new Error('purge boom'))
    const res = await authorizeRoute().handler(
      new Request('https://instans.example.se/api/extensions/ext/skatteverket/authorize'),
      ctx,
    )
    expect(res.status).toBe(307)
    expect(mockCreateFlow).toHaveBeenCalledTimes(1)
  })
})
