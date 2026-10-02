/**
 * The mail routes as a browser reaches them: through the extension dispatcher
 * (app/api/extensions/ext/[...path]), which is where authentication and MFA
 * are enforced for every extension route. The handlers themselves never see a
 * request without a session, so a 401 is only meaningful at this level.
 *
 * The OAuth callback is the exception on purpose (skipAuth): Google's
 * redirect must not be answered with a JSON 401. It binds the completion to
 * the initiator's own session instead (oauth-callback.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const CONNECTION = '22222222-2222-4222-8222-222222222222'
const USER = 'user-1'
const APP_URL = 'https://app.example'

const { mockCreateClient, mockShouldEnforceMfa, serviceClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockShouldEnforceMfa: vi.fn(() => false),
  serviceClient: { from: vi.fn() },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: mockCreateClient,
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
// requireAuth asks mfaStepUpApplies (a user with a factor must reach AAL2),
// the page gate asks shouldEnforceMfa; one switch drives both here.
vi.mock('@/lib/auth/mfa', () => ({ shouldEnforceMfa: mockShouldEnforceMfa, mfaStepUpApplies: mockShouldEnforceMfa }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn(async () => COMPANY),
  getActiveCompanyId: vi.fn(async () => COMPANY),
}))
vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: vi.fn(
    (supabase: unknown, userId: string, companyId: string, extensionId: string, requestId: string) => ({
      supabase,
      userId,
      companyId,
      extensionId,
      requestId,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }),
  ),
}))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => serviceClient }))
vi.mock('../lib/connections', () => ({
  SCOPE_MISSING: 'scope_missing',
  disconnect: vi.fn(),
  findConnectionOwner: vi.fn(),
  listConnections: vi.fn(),
  saveConnection: vi.fn(),
}))
vi.mock('../lib/google-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/google-oauth')>()),
  exchangeCodeForTokens: vi.fn(),
  revokeGoogleToken: vi.fn(),
}))
vi.mock('../lib/gmail-client', () => ({ getMailboxAddress: vi.fn() }))

import { GET, POST, DELETE } from '@/app/api/extensions/ext/[...path]/route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { mailExtension } from '../index'
import { disconnect, findConnectionOwner, listConnections, saveConnection } from '../lib/connections'
import { exchangeCodeForTokens, GMAIL_READONLY_SCOPE } from '../lib/google-oauth'
import { getMailboxAddress } from '../lib/gmail-client'
import { createOAuthState, verifyOAuthState } from '../lib/crypto'

/** A cookie session for `userId` (or none), whose membership has `role`. */
function session(userId: string | null, role = 'owner') {
  const membership: Record<string, unknown> = {}
  membership.select = () => membership
  membership.eq = () => membership
  membership.maybeSingle = () => Promise.resolve({ data: { role }, error: null })
  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId, app_metadata: {} } : null },
        error: userId ? null : { message: 'Auth session missing' },
      }),
    },
    from: () => membership,
    // user_is_company_admin, the predicate isCompanyAdmin asks the database.
    rpc: vi.fn(async () => ({ data: role === 'owner' || role === 'admin', error: null })),
  })
}

function params(...path: string[]) {
  return { params: Promise.resolve({ path: ['mail', ...path] }) }
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`${APP_URL}/api/extensions/ext/mail${path}`, init)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockShouldEnforceMfa.mockReturnValue(false)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
  vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', '22'.repeat(32))
  vi.stubEnv('GOOGLE_MAIL_CLIENT_ID', 'client-id')
  vi.stubEnv('GOOGLE_MAIL_CLIENT_SECRET', 'client-secret')
  vi.stubEnv('GOOGLE_MAIL_CONNECT_COMPANY_IDS', COMPANY)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  extensionRegistry.clear()
  extensionRegistry.register(mailExtension)
  session(USER)
  ;(findConnectionOwner as Mock).mockResolvedValue({ connectedBy: USER })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/extensions/ext/mail/oauth/start', () => {
  it('answers 401 without a session and never mints a consent URL', async () => {
    session(null)
    const res = await POST(request('/oauth/start', { method: 'POST' }), params('oauth', 'start'))
    expect(res.status).toBe(401)
    expect(await res.json()).not.toHaveProperty('url')
  })

  it('answers 403 for a session that has not completed MFA', async () => {
    mockShouldEnforceMfa.mockReturnValue(true)
    const res = await POST(request('/oauth/start', { method: 'POST' }), params('oauth', 'start'))
    expect(res.status).toBe(403)
  })

  it('answers 403 to a viewer, who may not connect a mailbox to the books', async () => {
    session(USER, 'viewer')
    const res = await POST(request('/oauth/start', { method: 'POST' }), params('oauth', 'start'))
    expect(res.status).toBe(403)
    expect(await res.json()).not.toHaveProperty('url')
  })

  it('answers 400 when the deployment has no Gmail OAuth client', async () => {
    vi.stubEnv('GOOGLE_MAIL_CLIENT_ID', '')
    const res = await POST(request('/oauth/start', { method: 'POST' }), params('oauth', 'start'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'provider_not_configured' })
  })

  it('returns a consent URL bound to the signed-in user and the resolved company', async () => {
    const res = await POST(request('/oauth/start', { method: 'POST' }), params('oauth', 'start'))
    expect(res.status).toBe(200)

    const url = new URL((await res.json()).url as string)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    // Registered in the Google console: the slug and the path are pinned.
    expect(url.searchParams.get('redirect_uri')).toBe(`${APP_URL}/api/extensions/ext/mail/oauth/callback`)
    expect(url.searchParams.get('scope')).toBe(GMAIL_READONLY_SCOPE)
    const verified = verifyOAuthState(url.searchParams.get('state') as string)
    expect(verified).toMatchObject({ userId: USER, companyId: COMPANY })
    // PKCE: an S256 challenge goes out, and the verifier stays sealed in the
    // state. That the challenge is the S256 of that verifier is pinned in
    // lib/__tests__/crypto.test.ts against RFC 7636's own example.
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(verified!.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe('GET /api/extensions/ext/mail/oauth/callback', () => {
  function callback(state: string) {
    const url = new URL(`${APP_URL}/api/extensions/ext/mail/oauth/callback`)
    url.searchParams.set('code', 'google-code')
    url.searchParams.set('state', state)
    return new Request(url.toString())
  }

  it('is reached without a session, and sends that browser to sign in instead of a JSON 401', async () => {
    session(null)
    const res = await GET(callback(createOAuthState(USER, COMPANY)), params('oauth', 'callback'))

    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location') as string).pathname).toBe('/login')
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
    expect(saveConnection).not.toHaveBeenCalled()
  })

  it('answers invalid for a callback without a code', async () => {
    const url = new URL(`${APP_URL}/api/extensions/ext/mail/oauth/callback`)
    url.searchParams.set('state', createOAuthState(USER, COMPANY))
    const res = await GET(new Request(url.toString()), params('oauth', 'callback'))
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=invalid`)
  })

  it('saves the grant for the company the flow was started in', async () => {
    ;(exchangeCodeForTokens as Mock).mockResolvedValue({
      refreshToken: 'refresh-1',
      accessToken: 'access-1',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      scopes: [GMAIL_READONLY_SCOPE],
    })
    ;(getMailboxAddress as Mock).mockResolvedValue('ekonomi@example.se')

    const res = await GET(callback(createOAuthState(USER, COMPANY)), params('oauth', 'callback'))

    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/mail?mail=connected`)
    expect(saveConnection).toHaveBeenCalledWith(
      serviceClient,
      expect.objectContaining({ companyId: COMPANY, userId: USER, emailAddress: 'ekonomi@example.se' }),
    )
  })
})

describe('GET /api/extensions/ext/mail/connections', () => {
  it('answers 401 without a session', async () => {
    session(null)
    const res = await GET(request('/connections'), params('connections'))
    expect(res.status).toBe(401)
    expect(listConnections).not.toHaveBeenCalled()
  })

  it('lists the mailboxes of the resolved company only', async () => {
    ;(listConnections as Mock).mockResolvedValue([{ id: CONNECTION, status: 'active' }])
    const res = await GET(request('/connections'), params('connections'))
    expect(res.status).toBe(200)
    expect((await res.json()).data.connections).toHaveLength(1)
    expect(listConnections).toHaveBeenCalledWith(serviceClient, COMPANY)
  })
})

describe('DELETE /api/extensions/ext/mail/connections', () => {
  it('answers 401 without a session and disconnects nothing', async () => {
    session(null)
    const res = await DELETE(request(`/connections?id=${CONNECTION}`, { method: 'DELETE' }), params('connections'))
    expect(res.status).toBe(401)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('answers 403 to a viewer who did not connect the mailbox, and disconnects nothing', async () => {
    session(USER, 'viewer')
    ;(findConnectionOwner as Mock).mockResolvedValue({ connectedBy: 'colleague' })
    const res = await DELETE(request(`/connections?id=${CONNECTION}`, { method: 'DELETE' }), params('connections'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'disconnect_not_allowed' })
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('answers 403 to a plain member cutting off a colleague\'s mailbox', async () => {
    session(USER, 'member')
    ;(findConnectionOwner as Mock).mockResolvedValue({ connectedBy: 'colleague' })
    const res = await DELETE(request(`/connections?id=${CONNECTION}`, { method: 'DELETE' }), params('connections'))
    expect(res.status).toBe(403)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('lets the person who connected the mailbox disconnect it, whatever their role now', async () => {
    // Reducing access is always safe for the owner of the grant.
    session(USER, 'viewer')
    ;(findConnectionOwner as Mock).mockResolvedValue({ connectedBy: USER })
    const res = await DELETE(request(`/connections?id=${CONNECTION}`, { method: 'DELETE' }), params('connections'))
    expect(res.status).toBe(200)
    expect(disconnect).toHaveBeenCalledWith(serviceClient, COMPANY, CONNECTION, USER)
  })

  it('lets an admin disconnect a colleague\'s mailbox, and one whose connector was erased', async () => {
    session(USER, 'admin')
    for (const connectedBy of ['colleague', null]) {
      ;(findConnectionOwner as Mock).mockResolvedValue({ connectedBy })
      const res = await DELETE(request(`/connections?id=${CONNECTION}`, { method: 'DELETE' }), params('connections'))
      expect(res.status).toBe(200)
    }
    expect(disconnect).toHaveBeenCalledTimes(2)
  })

  it('answers 404 for a mailbox this company does not have', async () => {
    ;(findConnectionOwner as Mock).mockResolvedValue(null)
    const res = await DELETE(request(`/connections?id=${CONNECTION}`, { method: 'DELETE' }), params('connections'))
    expect(res.status).toBe(404)
    expect(findConnectionOwner).toHaveBeenCalledWith(serviceClient, COMPANY, CONNECTION)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('answers 400 without an id', async () => {
    const res = await DELETE(request('/connections', { method: 'DELETE' }), params('connections'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing_id' })
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('answers 400 for an id that is not a connection id', async () => {
    const res = await DELETE(request('/connections?id=not-a-uuid', { method: 'DELETE' }), params('connections'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_id' })
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('disconnects within the resolved company, as the signed-in user', async () => {
    const res = await DELETE(request(`/connections?id=${CONNECTION}`, { method: 'DELETE' }), params('connections'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { disconnected: true } })
    expect(disconnect).toHaveBeenCalledWith(serviceClient, COMPANY, CONNECTION, USER)
  })
})
