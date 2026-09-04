import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'

// Mock dependencies: factory must not reference outer variables
const mockExchangeCodeForAccount = vi.fn()
const mockFetchAccountDisplayName = vi.fn()
vi.mock('@/extensions/general/stripe/lib/connect', () => ({
  exchangeCodeForAccount: (...args: unknown[]) => mockExchangeCodeForAccount(...args),
  fetchAccountDisplayName: (...args: unknown[]) => mockFetchAccountDisplayName(...args),
}))

const { mockFrom, mockGetUser } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  // The cookie session the callback binds the completion to. Every pending
  // row in this suite belongs to 'user-1', so that is the default session.
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
  const url = new URL('http://localhost:3000/api/extensions/stripe/callback')
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
  // For chains ending without .single() (the insert and the error-path updates)
  chain.then = (resolve: (v: unknown) => void) =>
    resolve({ data: result.data ?? null, error: result.error ?? null })
  return chain
}

describe('GET /api/extensions/stripe/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockExchangeCodeForAccount.mockResolvedValue({
      stripeAccountId: 'acct_123',
      livemode: false,
    })
    mockFetchAccountDisplayName.mockResolvedValue('Test Shop')
  })

  it('activates the connection and turns the transaction feed on by default', async () => {
    const findChain = mockChain({
      data: { id: CONNECTION_ID, user_id: 'user-1', company_id: 'company-1' },
    })
    const replayChain = mockChain({ error: null })
    const activateChain = mockChain({
      data: {
        id: CONNECTION_ID,
        company_id: 'company-1',
        user_id: 'user-1',
        stripe_account_id: 'acct_123',
        livemode: false,
      },
    })
    mockFrom
      .mockReturnValueOnce(findChain)
      .mockReturnValueOnce(replayChain)
      .mockReturnValueOnce(activateChain)

    const response = await GET(makeRequest({ code: 'ac_123', state: OAUTH_STATE }))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/import?mode=stripe&stripe_connected=true',
    )

    // Feed-only product: a completed OAuth must leave the nightly sync armed,
    // otherwise a connected account silently ingests nothing.
    const activatePayload = (activateChain.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(activatePayload).toMatchObject({
      stripe_account_id: 'acct_123',
      livemode: false,
      display_name: 'Test Shop',
      status: 'active',
      oauth_state: null,
      transaction_sync_enabled: true,
    })
  })

  it('redirects with an error and never activates when the state is unknown', async () => {
    mockFrom.mockReturnValueOnce(mockChain({ data: null, error: { code: 'PGRST116' } }))

    const response = await GET(makeRequest({ code: 'ac_123', state: 'unknown-state' }))

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/import?mode=stripe&stripe_error=invalid_state',
    )
    expect(mockExchangeCodeForAccount).not.toHaveBeenCalled()
  })

  it('redirects with an error when the authorization code was already used', async () => {
    mockFrom
      .mockReturnValueOnce(
        mockChain({ data: { id: CONNECTION_ID, user_id: 'user-1', company_id: 'company-1' } }),
      )
      .mockReturnValueOnce(mockChain({ error: { code: '23505' } }))

    const response = await GET(makeRequest({ code: 'ac_123', state: OAUTH_STATE }))

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/import?mode=stripe&stripe_error=invalid_state',
    )
    expect(mockExchangeCodeForAccount).not.toHaveBeenCalled()
  })

  it('reports the conflict when the Stripe account is already connected', async () => {
    mockFrom
      .mockReturnValueOnce(
        mockChain({ data: { id: CONNECTION_ID, user_id: 'user-1', company_id: 'company-1' } }),
      )
      .mockReturnValueOnce(mockChain({ error: null }))
      .mockReturnValueOnce(mockChain({ data: null, error: { code: '23505', message: 'dup' } }))
      .mockReturnValueOnce(mockChain({ error: null }))

    const response = await GET(makeRequest({ code: 'ac_123', state: OAUTH_STATE }))

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/import?mode=stripe&stripe_error=account_already_connected',
    )
  })

  it('redirects without touching Stripe when parameters are missing', async () => {
    const response = await GET(makeRequest({ state: OAUTH_STATE }))

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/import?mode=stripe&stripe_error=missing_parameters',
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  // The state token proves the callback belongs to a flow WE started, not that
  // the browser completing it is the initiator's. A victim lured into
  // approving a Connect someone else started must not have their Stripe
  // account attached to that someone's company.
  describe('initiator binding', () => {
    const PENDING_ROW = { id: CONNECTION_ID, user_id: 'user-1', company_id: 'company-1' }

    it('refuses a consent completed by a different user without burning the code or marking the row', async () => {
      const findChain = mockChain({ data: PENDING_ROW })
      mockFrom.mockReturnValue(findChain)
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-2' } }, error: null })

      const response = await GET(makeRequest({ code: 'ac_123', state: OAUTH_STATE }))

      expect(response.status).toBe(307)
      const location = decodeURIComponent(response.headers.get('location') || '')
      expect(location.startsWith('http://localhost:3000/import?mode=stripe&stripe_error=')).toBe(true)
      // The panel shows an unknown stripe_error value verbatim, so the param
      // carries the Swedish explanation itself.
      expect(location).toContain('annat användarkonto')
      expect(location).not.toContain('stripe_connected')

      // Only the lookup touched the database: no oauth_used_codes insert (the
      // code stays valid for the initiator), no update on the row.
      expect(mockFrom).toHaveBeenCalledTimes(1)
      expect(findChain.insert).not.toHaveBeenCalled()
      expect(findChain.update).not.toHaveBeenCalled()
      expect(mockExchangeCodeForAccount).not.toHaveBeenCalled()
    })

    it('sends an anonymous browser to /login with the callback URL preserved', async () => {
      const findChain = mockChain({ data: PENDING_ROW })
      mockFrom.mockReturnValue(findChain)
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

      const response = await GET(makeRequest({ code: 'ac_123', state: OAUTH_STATE }))

      expect(response.status).toBe(307)
      const location = new URL(response.headers.get('location') || '')
      expect(location.origin).toBe('http://localhost:3000')
      expect(location.pathname).toBe('/login')
      expect(location.searchParams.get('next')).toBe(
        `/api/extensions/stripe/callback?code=ac_123&state=${OAUTH_STATE}`,
      )

      expect(mockFrom).toHaveBeenCalledTimes(1)
      expect(findChain.insert).not.toHaveBeenCalled()
      expect(findChain.update).not.toHaveBeenCalled()
      expect(mockExchangeCodeForAccount).not.toHaveBeenCalled()
    })

    it('does not consult the session for an unknown state (nothing to bind to)', async () => {
      mockFrom.mockReturnValueOnce(mockChain({ data: null, error: { code: 'PGRST116' } }))

      await GET(makeRequest({ code: 'ac_123', state: 'unknown-state' }))

      expect(mockGetUser).not.toHaveBeenCalled()
    })
  })
})
