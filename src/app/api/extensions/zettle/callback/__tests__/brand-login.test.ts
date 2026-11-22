import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Zettle redirects every authorization to the one registered callback on the
 * canonical host, while the session cookie is host-only. A merchant who
 * started on a white-label domain therefore arrives signed out, and the login
 * bounce must go to the brand host the flow started on (where the session
 * lives), not to the canonical login. The success and denial redirects are
 * covered in route.test.ts.
 */

const mockExchangeCodeForTokens = vi.fn()
vi.mock('@/extensions/general/zettle/lib/oauth', () => ({
  exchangeCodeForTokens: (...args: unknown[]) => mockExchangeCodeForTokens(...args),
  fetchUserSelf: vi.fn(),
}))
vi.mock('@/extensions/general/zettle/lib/credentials', () => ({
  encryptCredential: (value: string) => `enc:${value}`,
}))

const { mockFrom, mockGetUser } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockGetUser: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn().mockResolvedValue({ from: mockFrom }),
  createClient: vi.fn().mockResolvedValue({ auth: { getUser: mockGetUser } }),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { get: vi.fn(() => ({ id: 'zettle' })) },
}))

// Only this host resolves in the brands table: a registered white-label domain.
const BRAND_HOST = 'brand.testbrand.example'
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandByHost: vi.fn(async (host: string) => (host === BRAND_HOST ? { domain: host } : null)),
  resolveBrandResultByHost: vi.fn(async (host: string) => ({
    brand: host === BRAND_HOST ? { domain: host } : null,
    lookupFailed: false,
  })),
}))

vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')

import { GET } from '../route'

const OAUTH_STATE = 'state-token-1'

function pendingRow(returnOrigin: string | null) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'update', 'insert']) chain[m] = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue({
    data: { id: 'connection-1', user_id: 'user-1', company_id: 'company-1', return_origin: returnOrigin },
    error: null,
  })
  return chain
}

function callback() {
  return new Request(
    `http://localhost:3000/api/extensions/zettle/callback?code=zc_1&state=${OAUTH_STATE}`,
  )
}

describe('GET /api/extensions/zettle/callback without a session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
  })

  it('sends the merchant to the login on the brand host the flow started on, consuming nothing', async () => {
    const chain = pendingRow(`https://${BRAND_HOST}`)
    mockFrom.mockReturnValue(chain)

    const response = await GET(callback())

    const location = new URL(response.headers.get('location') || '')
    expect(location.origin).toBe(`https://${BRAND_HOST}`)
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('next')).toBe(
      `/api/extensions/zettle/callback?code=zc_1&state=${OAUTH_STATE}`,
    )
    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(chain.insert).not.toHaveBeenCalled()
    expect(chain.update).not.toHaveBeenCalled()
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled()
  })

  it('keeps the canonical login for a flow with no recorded origin', async () => {
    mockFrom.mockReturnValue(pendingRow(null))

    const response = await GET(callback())

    const location = new URL(response.headers.get('location') || '')
    expect(location.origin).toBe('http://localhost:3000')
    expect(location.pathname).toBe('/login')
  })
})
