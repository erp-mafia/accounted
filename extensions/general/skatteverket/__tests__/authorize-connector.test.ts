/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The route is exercised through the extension registration; the connector
// seam and the paywall gate are mocked so the test pins ONLY the /authorize
// wiring: what is stored, and where the browser is sent.
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

import { skatteverketExtension } from '../index'
import { buildAuthorizeUrl } from '../lib/oauth'

function authorizeRoute() {
  const route = skatteverketExtension.apiRoutes?.find(
    (r) => r.method === 'GET' && r.path === '/authorize',
  )
  expect(route, 'GET /authorize must be registered').toBeDefined()
  return route!
}

function makeCtx() {
  const stored: Record<string, string> = {}
  const cleared: string[] = []
  return {
    stored,
    cleared,
    ctx: {
      userId: 'user-1',
      companyId: 'company-1',
      supabase: {} as any,
      settings: {
        set: vi.fn(async (key: string, value: string) => {
          stored[key] = value
        }),
        clear: vi.fn(async (key: string) => {
          cleared.push(key)
        }),
        get: vi.fn(async () => null),
      },
    } as any,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://instans.example.se'
  delete process.env.NEXT_PUBLIC_SKV_OAUTH_BASE_URL
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

  it('starts the consent through the broker and stores its redirect_uri + connector_state', async () => {
    const { ctx, stored } = makeCtx()
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
        state: stored.oauth_state,
        codeChallenge: 'pkce-c',
      },
    )
    // The BROKER's redirect_uri (what SKV saw) is what the token exchange
    // must repeat, so it replaces the locally computed one.
    expect(stored.oauth_redirect_uri).toBe(
      'https://app.hosted.example/api/extensions/ext/skatteverket/callback',
    )
    expect(stored.oauth_connector_state).toBe('signed-cs')
    expect(stored.oauth_code_verifier).toBe('pkce-v')
    expect(buildAuthorizeUrl).not.toHaveBeenCalled()
  })

  it('answers 502 with operator guidance when the broker refuses, storing no flow state', async () => {
    mockStartAuth.mockRejectedValueOnce(new Error('Connector authorize-url failed (403): quota'))
    const { ctx, stored } = makeCtx()
    const res = await authorizeRoute().handler(
      new Request('https://instans.example.se/api/extensions/ext/skatteverket/authorize'),
      ctx,
    )

    expect(res.status).toBe(502)
    const body = await (res as Response).json()
    expect(body.error).toMatch(/GNUBOK_CONNECTOR_KEY/)
    expect(Object.keys(stored)).toHaveLength(0)
  })
})

describe('skatteverket /authorize: direct mode', () => {
  it('builds the authorize URL locally and clears any stale connector state', async () => {
    mockConnectorMode.mockReturnValue(null)
    const { ctx, stored, cleared } = makeCtx()
    const res = await authorizeRoute().handler(
      new Request('https://instans.example.se/api/extensions/ext/skatteverket/authorize'),
      ctx,
    )

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://skv.test/authorize?direct=1')
    expect(mockStartAuth).not.toHaveBeenCalled()
    expect(stored.oauth_redirect_uri).toBe(
      'https://instans.example.se/api/extensions/ext/skatteverket/callback',
    )
    // A row surviving from a connector-era flow must not leak into a direct
    // exchange.
    expect(cleared).toContain('oauth_connector_state')
  })
})
