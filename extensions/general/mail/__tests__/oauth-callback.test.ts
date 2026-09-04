import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'

/**
 * The Gmail OAuth callback must be completed by the user who started it.
 *
 * The signed state carries userId + companyId and proves the flow was started
 * by us for that user. It does not prove that the browser now finishing it is
 * that user: Google's authorize URL is shareable, so a victim lured into
 * approving a consent someone else started would have THEIR mailbox saved
 * (with the service client, no RLS) under the initiator's company. The
 * callback now binds the completion to the initiator's own cookie session
 * before the code is exchanged. The binding helper is the real one; only the
 * session behind it is faked.
 */

vi.mock('@/lib/mail-search/service', () => ({ registerMailSearchService: vi.fn() }))
vi.mock('../lib/search-service', () => ({ GmailSearchService: class GmailSearchService {} }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({})) }))

vi.mock('../lib/google-oauth', () => ({
  buildAuthorizationUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  getGoogleOAuthEnv: vi.fn(() => ({})),
  isGoogleMailConfigured: vi.fn(() => true),
}))

vi.mock('../lib/connections', () => ({
  disconnect: vi.fn(),
  listConnections: vi.fn(),
  saveConnection: vi.fn(),
}))

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: mockCreateClient,
  createServiceClient: vi.fn(),
}))

import { mailExtension } from '../index'
import { createOAuthState } from '../lib/crypto'
import { exchangeCodeForTokens } from '../lib/google-oauth'
import { saveConnection } from '../lib/connections'

const APP_URL = 'https://app.example'
const CALLBACK_PATH = '/api/extensions/ext/mail/oauth/callback'

const callbackRoute = () =>
  mailExtension.apiRoutes!.find((r) => r.method === 'GET' && r.path === '/oauth/callback')!

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

function callbackRequest(state: string) {
  const url = new URL(`${APP_URL}${CALLBACK_PATH}`)
  url.searchParams.set('code', 'google-code')
  url.searchParams.set('state', state)
  return new Request(url.toString())
}

describe('mail GET /oauth/callback: the completing session must be the initiator', () => {
  let state: string

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
    // 32 bytes of hex so createOAuthState/verifyOAuthState use a real key.
    vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', '00'.repeat(32))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    state = createOAuthState('user-1', 'company-1')
    ;(exchangeCodeForTokens as Mock).mockResolvedValue({
      refreshToken: 'refresh-1',
      accessToken: 'access-1',
      expiresAt: '2030-01-01T00:00:00Z',
      email: 'ekonomi@example.se',
      scopes: 'gmail.readonly',
    })
    ;(saveConnection as Mock).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('saves the grant for the state user when the session is that user', async () => {
    useSession('user-1')

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=connected`)
    expect(exchangeCodeForTokens).toHaveBeenCalledTimes(1)
    expect(saveConnection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: 'company-1',
        userId: 'user-1',
        provider: 'gmail',
        emailAddress: 'ekonomi@example.se',
      }),
    )
  })

  it('refuses a completion by a different signed-in user: no exchange, no save', async () => {
    // The victim (user-2) was lured into approving user-1's consent.
    useSession('user-2')

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=mismatch`)
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
    expect(saveConnection).not.toHaveBeenCalled()
  })

  it('sends a session-less completion to login with the callback as next, saving nothing', async () => {
    useSession(null)

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.status).toBe(307)
    const location = new URL(res.headers.get('location') as string)
    expect(location.origin).toBe(APP_URL)
    expect(location.pathname).toBe('/login')
    // Same-origin relative path + query: the only form the login page's
    // safeReturnTo accepts. Signing in re-runs the callback with the same
    // code and (still unexpired) state.
    const next = location.searchParams.get('next') as string
    expect(next.startsWith(`${CALLBACK_PATH}?`)).toBe(true)
    expect(new URL(next, APP_URL).searchParams.get('state')).toBe(state)
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
    expect(saveConnection).not.toHaveBeenCalled()
  })

  it('still rejects a forged or expired state before ever reading the session', async () => {
    useSession('user-1')

    const res = await callbackRoute().handler(callbackRequest('not-a-real-state'))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=expired`)
    expect(mockCreateClient).not.toHaveBeenCalled()
    expect(saveConnection).not.toHaveBeenCalled()
  })
})
