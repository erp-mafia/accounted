/**
 * New Gmail consents are withheld on hosted while Google's scope review is
 * open, unless the company is allowlisted. Existing mailboxes are unaffected.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'

vi.mock('@/lib/mail-search/service', () => ({ registerMailSearchService: vi.fn() }))
vi.mock('../lib/search-service', () => ({ GmailSearchService: class GmailSearchService {} }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({})) }))
vi.mock('../lib/google-oauth', () => ({
  buildAuthorizationUrl: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?x=1'),
  exchangeCodeForTokens: vi.fn(),
  getGoogleOAuthEnv: vi.fn(() => ({})),
  isGoogleMailConfigured: vi.fn(() => true),
}))
vi.mock('../lib/connections', () => ({
  disconnect: vi.fn(),
  listConnections: vi.fn(),
  saveConnection: vi.fn(),
}))
vi.mock('../lib/gmail-client', () => ({ getMailboxAddress: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))

import { mailExtension } from '../index'
import { isMailConnectEnabled } from '../lib/connect-gate'
import { listConnections } from '../lib/connections'

const COMPANY = 'company-1'

const route = (method: 'GET' | 'POST', path: string) =>
  mailExtension.apiRoutes!.find((r) => r.method === method && r.path === path)!

const ctx = {
  userId: 'user-1',
  companyId: COMPANY,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
} as unknown as Parameters<ReturnType<typeof route>['handler']>[1]

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
  vi.stubEnv('MAIL_TOKEN_ENCRYPTION_KEY', '00'.repeat(32))
  ;(listConnections as Mock).mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isMailConnectEnabled', () => {
  it('withholds every company when the allowlist is unset', () => {
    expect(isMailConnectEnabled(COMPANY, undefined)).toBe(false)
    expect(isMailConnectEnabled(COMPANY, '')).toBe(false)
    expect(isMailConnectEnabled(COMPANY, ' , ')).toBe(false)
  })

  it('opens for everybody on a star, and for listed companies only otherwise', () => {
    expect(isMailConnectEnabled(COMPANY, '*')).toBe(true)
    expect(isMailConnectEnabled(COMPANY, `other, ${COMPANY} `)).toBe(true)
    expect(isMailConnectEnabled(COMPANY, 'other')).toBe(false)
  })

  it('never gates a self-hosted install, which runs its own Google app', () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    expect(isMailConnectEnabled(COMPANY, undefined)).toBe(true)
  })
})

describe('POST /oauth/start', () => {
  it('refuses to start a consent for a company that is not allowlisted', async () => {
    vi.stubEnv('GOOGLE_MAIL_CONNECT_COMPANY_IDS', '')
    const res = await route('POST', '/oauth/start').handler(
      new Request('https://app.example/api/extensions/ext/mail/oauth/start', { method: 'POST' }),
      ctx,
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'connect_disabled' })
  })

  it('starts the consent for an allowlisted company', async () => {
    vi.stubEnv('GOOGLE_MAIL_CONNECT_COMPANY_IDS', COMPANY)
    const res = await route('POST', '/oauth/start').handler(
      new Request('https://app.example/api/extensions/ext/mail/oauth/start', { method: 'POST' }),
      ctx,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).url).toContain('accounts.google.com')
  })
})

describe('GET /connections', () => {
  it('still lists existing mailboxes and says whether a new consent may start', async () => {
    vi.stubEnv('GOOGLE_MAIL_CONNECT_COMPANY_IDS', '')
    ;(listConnections as Mock).mockResolvedValue([{ id: 'c1', provider: 'gmail', status: 'active' }])
    const res = await route('GET', '/connections').handler(
      new Request('https://app.example/api/extensions/ext/mail/connections'),
      ctx,
    )
    const body = await res.json()
    expect(body.data.connections).toHaveLength(1)
    expect(body.data.configured).toBe(true)
    expect(body.data.connectEnabled).toBe(false)
  })

  it('reports connectEnabled once the scope is approved and the star is set', async () => {
    vi.stubEnv('GOOGLE_MAIL_CONNECT_COMPANY_IDS', '*')
    const res = await route('GET', '/connections').handler(
      new Request('https://app.example/api/extensions/ext/mail/connections'),
      ctx,
    )
    expect((await res.json()).data.connectEnabled).toBe(true)
  })
})
