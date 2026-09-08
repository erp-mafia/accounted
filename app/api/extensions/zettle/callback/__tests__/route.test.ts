import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'

const mockExchangeCodeForTokens = vi.fn()
const mockFetchUserSelf = vi.fn()
vi.mock('@/extensions/general/zettle/lib/oauth', () => ({
  exchangeCodeForTokens: (...args: unknown[]) => mockExchangeCodeForTokens(...args),
  fetchUserSelf: (...args: unknown[]) => mockFetchUserSelf(...args),
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

vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')

import { GET } from '../route'

const CONNECTION_ID = 'connection-1'
const OAUTH_STATE = 'state-token-1'

function makeRequest(params: Record<string, string>) {
  const url = new URL('http://localhost:3000/api/extensions/zettle/callback')
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return new Request(url.toString())
}

function mockChain(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'update', 'insert']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  chain.single = vi
    .fn()
    .mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  chain.maybeSingle = vi
    .fn()
    .mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  chain.then = (resolve: (v: unknown) => void) =>
    resolve({ data: result.data ?? null, error: result.error ?? null })
  return chain
}

describe('GET /api/extensions/zettle/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockExchangeCodeForTokens.mockResolvedValue({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 7200,
    })
    mockFetchUserSelf.mockResolvedValue({ organizationUuid: 'org-uuid-1' })
  })

  it('activates only while the pending oauth_state still matches', async () => {
    const findChain = mockChain({
      data: { id: CONNECTION_ID, user_id: 'user-1', company_id: 'company-1' },
    })
    const replayChain = mockChain({ error: null })
    const activateChain = mockChain({
      data: {
        id: CONNECTION_ID,
        company_id: 'company-1',
        user_id: 'user-1',
        organization_uuid: 'org-uuid-1',
      },
    })
    mockFrom
      .mockReturnValueOnce(findChain)
      .mockReturnValueOnce(replayChain)
      .mockReturnValueOnce(activateChain)

    const response = await GET(makeRequest({ code: 'ac_123', state: OAUTH_STATE }))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/import?mode=zettle&zettle_connected=true',
    )

    const eqCalls = (activateChain.eq as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c as [string, string],
    )
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ['id', CONNECTION_ID],
        ['status', 'pending'],
        ['oauth_state', OAUTH_STATE],
      ]),
    )
    expect(activateChain.maybeSingle).toHaveBeenCalled()
  })

  it('refuses activation when /connect invalidated the pending row mid-callback', async () => {
    // Lookup still sees the original pending row (TOCTOU), then a concurrent
    // POST /connect flips it to error and clears oauth_state before activate.
    const findChain = mockChain({
      data: { id: CONNECTION_ID, user_id: 'user-1', company_id: 'company-1' },
    })
    const replayChain = mockChain({ error: null })
    const activateChain = mockChain({ data: null, error: null })
    mockFrom
      .mockReturnValueOnce(findChain)
      .mockReturnValueOnce(replayChain)
      .mockReturnValueOnce(activateChain)

    const response = await GET(makeRequest({ code: 'ac_123', state: OAUTH_STATE }))

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/import?mode=zettle&zettle_error=invalid_state',
    )
    const eqCalls = (activateChain.eq as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c as [string, string],
    )
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ['status', 'pending'],
        ['oauth_state', OAUTH_STATE],
      ]),
    )
    // Must not fall through into the conflict/error cleanup update.
    expect(mockFrom).toHaveBeenCalledTimes(3)
  })

  it('redirects with invalid_state when the oauth state is unknown', async () => {
    mockFrom.mockReturnValueOnce(mockChain({ data: null, error: { code: 'PGRST116' } }))

    const response = await GET(makeRequest({ code: 'ac_123', state: 'unknown-state' }))

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/import?mode=zettle&zettle_error=invalid_state',
    )
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled()
  })
})
