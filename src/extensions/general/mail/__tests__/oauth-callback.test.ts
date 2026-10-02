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

// The scope check (lacksGmailScope) is the real one; only the network calls
// are faked.
vi.mock('../lib/google-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/google-oauth')>()),
  buildAuthorizationUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  getGoogleOAuthEnv: vi.fn(() => ({})),
  isGoogleMailConfigured: vi.fn(() => true),
  revokeGoogleToken: vi.fn(),
}))

vi.mock('../lib/connections', () => ({
  SCOPE_MISSING: 'scope_missing',
  disconnect: vi.fn(),
  listConnections: vi.fn(),
  saveConnection: vi.fn(),
}))

// The mailbox address comes from Gmail's profile endpoint (gmail.readonly),
// not from an id_token: the consent request carries that one scope only.
vi.mock('../lib/gmail-client', () => ({
  getMailboxAddress: vi.fn(),
}))

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: mockCreateClient,
  createServiceClient: vi.fn(),
}))

import { mailExtension } from '../index'
import { createOAuthState } from '../lib/crypto'
import { GMAIL_READONLY_SCOPE, exchangeCodeForTokens, revokeGoogleToken } from '../lib/google-oauth'
import { getMailboxAddress } from '../lib/gmail-client'
import { saveConnection } from '../lib/connections'

const APP_URL = 'https://app.example'
const CALLBACK_PATH = '/api/extensions/ext/mail/oauth/callback'

const callbackRoute = () =>
  mailExtension.apiRoutes!.find((r) => r.method === 'GET' && r.path === '/oauth/callback')!

/** The browser completing the callback is signed in as `userId` (or nobody). */
/**
 * The browser completing the callback is signed in as `userId` (or nobody),
 * with `role` in the state's company, which RLS shows unless it is archived.
 */
function useSession(
  userId: string | null,
  { role = 'owner', companyVisible = true }: { role?: string; companyVisible?: boolean } = {},
) {
  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
        error: null,
      }),
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.maybeSingle = () =>
        Promise.resolve(
          table === 'companies'
            ? { data: companyVisible ? { id: 'company-1' } : null, error: null }
            : { data: { role }, error: null },
        )
      return chain
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
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    vi.stubEnv('GOOGLE_MAIL_CONNECT_COMPANY_IDS', 'company-1')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    state = createOAuthState('user-1', 'company-1')
    ;(exchangeCodeForTokens as Mock).mockResolvedValue({
      refreshToken: 'refresh-1',
      accessToken: 'access-1',
      expiresAt: '2030-01-01T00:00:00Z',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    })
    ;(getMailboxAddress as Mock).mockResolvedValue('ekonomi@example.se')
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
    // The address is read with the freshly granted token, under the one scope.
    expect(getMailboxAddress).toHaveBeenCalledWith('access-1')
  })

  it('saves nothing when Gmail returns no address for the grant', async () => {
    useSession('user-1')
    ;(getMailboxAddress as Mock).mockResolvedValue(null)

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=no_address`)
    expect(saveConnection).not.toHaveBeenCalled()
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

describe('mail GET /oauth/callback: what Google returned decides what is saved', () => {
  let state: string

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
    vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', '00'.repeat(32))
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    vi.stubEnv('GOOGLE_MAIL_CONNECT_COMPANY_IDS', 'company-1')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    state = createOAuthState('user-1', 'company-1')
    useSession('user-1')
    ;(getMailboxAddress as Mock).mockResolvedValue('ekonomi@example.se')
    ;(saveConnection as Mock).mockResolvedValue(undefined)
    ;(revokeGoogleToken as Mock).mockResolvedValue({ outcome: 'revoked', status: 200, error: null })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  function grant(scopes: string[], refreshToken: string | null = 'refresh-1') {
    ;(exchangeCodeForTokens as Mock).mockResolvedValue({
      refreshToken,
      accessToken: 'access-1',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      scopes,
    })
  }

  it('refuses a grant whose Gmail box was unticked: saves nothing and revokes it', async () => {
    // Google's consent screen lets a person untick a scope and still approve.
    // Such a grant used to be saved as an active mailbox that failed every
    // search.
    grant(['openid', 'https://www.googleapis.com/auth/userinfo.email'])

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=scope_missing`)
    expect(saveConnection).not.toHaveBeenCalled()
    // Not even asked for the address: the profile call needs the scope too.
    expect(getMailboxAddress).not.toHaveBeenCalled()
    // The unused grant does not linger in the person's Google account.
    expect(revokeGoogleToken).toHaveBeenCalledWith('refresh-1')
  })

  it('revokes with the access token when the scope-less grant carried no refresh token', async () => {
    grant(['openid'], null)

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=scope_missing`)
    expect(revokeGoogleToken).toHaveBeenCalledWith('access-1')
  })

  it('still answers scope_missing when Google does not confirm the revocation', async () => {
    grant(['openid'])
    ;(revokeGoogleToken as Mock).mockResolvedValue({ outcome: 'failed', status: null, error: 'TimeoutError' })

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=scope_missing`)
    expect(saveConnection).not.toHaveBeenCalled()
  })

  it('keeps a grant that carries gmail.readonly next to other scopes', async () => {
    grant(['openid', GMAIL_READONLY_SCOPE, 'https://www.googleapis.com/auth/userinfo.email'])

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=connected`)
    expect(revokeGoogleToken).not.toHaveBeenCalled()
  })

  it('reads an unstated scope list as the scope requested (RFC 6749 5.1)', async () => {
    grant([])

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=connected`)
    expect(revokeGoogleToken).not.toHaveBeenCalled()
  })

  it('answers no_refresh_token, and leaves the existing grant alone', async () => {
    // Google withholds a refresh token when the account already holds a
    // grant for this client, which another company may be using: revoking
    // it here would disconnect that one.
    grant([GMAIL_READONLY_SCOPE], null)

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=no_refresh_token`)
    expect(saveConnection).not.toHaveBeenCalled()
    expect(revokeGoogleToken).not.toHaveBeenCalled()
  })

  it('answers denied when the person declined on Google, before anything else runs', async () => {
    const url = new URL(`${APP_URL}${CALLBACK_PATH}`)
    url.searchParams.set('error', 'access_denied')
    url.searchParams.set('state', state)

    const res = await callbackRoute().handler(new Request(url.toString()))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=denied`)
    expect(mockCreateClient).not.toHaveBeenCalled()
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
  })

  it('answers invalid for a callback missing its code or state', async () => {
    const noCode = new URL(`${APP_URL}${CALLBACK_PATH}`)
    noCode.searchParams.set('state', state)
    const noState = new URL(`${APP_URL}${CALLBACK_PATH}`)
    noState.searchParams.set('code', 'google-code')

    for (const url of [noCode, noState]) {
      const res = await callbackRoute().handler(new Request(url.toString()))
      expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=invalid`)
    }
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
    expect(saveConnection).not.toHaveBeenCalled()
  })

  it('re-checks the connect gate at completion: a company taken off it gets nothing saved', async () => {
    vi.stubEnv('GOOGLE_MAIL_CONNECT_COMPANY_IDS', 'another-company')
    grant([GMAIL_READONLY_SCOPE])

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=failed`)
    // Refused before the exchange, so no grant is even issued a token.
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
    expect(saveConnection).not.toHaveBeenCalled()
  })

  it('saves nothing for a company archived since the consent started', async () => {
    useSession('user-1', { companyVisible: false })
    grant([GMAIL_READONLY_SCOPE])

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=failed`)
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
    expect(saveConnection).not.toHaveBeenCalled()
  })

  it('saves nothing for someone who has become a viewer since the consent started', async () => {
    useSession('user-1', { role: 'viewer' })
    grant([GMAIL_READONLY_SCOPE])

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=failed`)
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
    expect(saveConnection).not.toHaveBeenCalled()
  })

  it('redeems the code with the PKCE verifier sealed in the state', async () => {
    const withVerifier = createOAuthState('user-1', 'company-1', 'verifier-from-start')
    grant([GMAIL_READONLY_SCOPE])

    await callbackRoute().handler(callbackRequest(withVerifier))

    expect(exchangeCodeForTokens).toHaveBeenCalledWith(expect.anything(), 'google-code', 'verifier-from-start')
  })

  it('still completes a flow started before PKCE, without a verifier', async () => {
    grant([GMAIL_READONLY_SCOPE])

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=connected`)
    expect(exchangeCodeForTokens).toHaveBeenCalledWith(expect.anything(), 'google-code', null)
  })

  it('answers failed when the code exchange itself fails, saving nothing', async () => {
    ;(exchangeCodeForTokens as Mock).mockRejectedValue(new Error('invalid_grant'))

    const res = await callbackRoute().handler(callbackRequest(state))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=failed`)
    expect(saveConnection).not.toHaveBeenCalled()
  })
})
