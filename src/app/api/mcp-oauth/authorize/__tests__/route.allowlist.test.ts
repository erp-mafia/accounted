import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

/**
 * /authorize with the REAL redirect-URI allowlist. The route tests in
 * route.test.ts stub resolveRedirectUri; here only the service-role client is
 * faked, so the tests prove the phishing fix end to end: a redirect URI that
 * some unrelated account registered is refused for this user, a colleague's
 * registration is accepted, and built-in Claude never touches the table.
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  serviceClient: vi.fn(),
  getActiveCompanyId: vi.fn(),
  getBranding: vi.fn(),
  createAuthCode: vi.fn<(...args: unknown[]) => string>(() => 'test-auth-code'),
}))

vi.mock('@/lib/auth/oauth-codes', () => ({
  createAuthCode: (...args: unknown[]) => mocks.createAuthCode(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mocks.createClient(),
}))

// The allowlist imports createServiceClientNoCookies from lib/auth/api-keys
// (relative path); the alias resolves to the same module, so this stub is
// what resolveRedirectUri constructs for its registration lookup.
vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    createServiceClientNoCookies: () => mocks.serviceClient(),
  }
})

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => mocks.getActiveCompanyId(...args),
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => mocks.getBranding(),
}))

import { GET, POST } from '../route'

type Row = Record<string, unknown>

/**
 * Minimal PostgREST-shaped fake over in-memory tables: eq/is filters are
 * applied, everything else is a no-op, and the chain resolves to the filtered
 * rows (all rows when awaited, first row via maybeSingle).
 */
function fakeServiceClient(tables: Record<string, Row[]>) {
  const from = vi.fn((table: string) => {
    const filters: [string, unknown][] = []
    const run = () =>
      (tables[table] ?? []).filter((row) =>
        filters.every(([col, val]) => (val === null ? row[col] == null : row[col] === val)),
      )
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'order', 'range', 'limit']) chain[method] = () => chain
    chain.eq = (col: string, val: unknown) => {
      filters.push([col, val])
      return chain
    }
    chain.is = (col: string, val: unknown) => {
      filters.push([col, val])
      return chain
    }
    chain.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: run(), error: null })
    return chain
  })
  return { from }
}

function userClient(userId: string, role = 'owner') {
  const chainFor = (result: { data: unknown; error: unknown }) => {
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'is', 'order', 'range', 'limit']) chain[method] = () => chain
    chain.single = async () => result
    chain.maybeSingle = async () => result
    chain.then = (resolve: (v: unknown) => void) => resolve(result)
    return chain
  }
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi
          .fn()
          .mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }),
        listFactors: vi.fn().mockResolvedValue({ data: { totp: [] }, error: null }),
      },
    },
    from: vi.fn((table: string) =>
      table === 'company_members'
        ? chainFor({ data: { role }, error: null })
        : chainFor({ data: { company_name: 'Test AB' }, error: null }),
    ),
  }
}

const DB = {
  oauth_client_registrations: [
    // A colleague of user-1 (both in company-1) registered this one.
    { id: 'reg-1', user_id: 'user-2', client_name: 'Byråns bot', redirect_uri: 'https://app.example.com/cb', revoked_at: null },
    // An unrelated account on the same instance registered this one.
    { id: 'reg-2', user_id: 'user-9', client_name: 'Claude (Anthropic)', redirect_uri: 'https://claude-login.example/cb', revoked_at: null },
    // user-1's own registration.
    { id: 'reg-3', user_id: 'user-1', client_name: 'Min egen app', redirect_uri: 'https://mine.example/cb', revoked_at: null },
  ],
  company_members: [
    { id: 'm1', user_id: 'user-1', company_id: 'company-1', role: 'owner' },
    { id: 'm2', user_id: 'user-2', company_id: 'company-1', role: 'member' },
    { id: 'm3', user_id: 'user-9', company_id: 'company-9', role: 'owner' },
  ],
}

function authorizeUrl(redirectUri: string): string {
  const url = new URL('http://localhost/api/mcp-oauth/authorize')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('code_challenge', 'abc')
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', 'xyz')
  return url.toString()
}

function consentForm(): FormData {
  const key = crypto.createHash('sha256').update('oauth-scope:test-service-key').digest()
  const sig = crypto.createHmac('sha256', key).update('').digest('base64url')
  const formData = new FormData()
  formData.set('consent', 'allow')
  formData.set('scope_binding', '')
  formData.set('scope_binding_sig', sig)
  formData.append('scopes', 'reports:read')
  return formData
}

describe('/api/mcp-oauth/authorize with the real redirect-URI allowlist', () => {
  let service: ReturnType<typeof fakeServiceClient>

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    service = fakeServiceClient(DB)
    mocks.serviceClient.mockReturnValue(service)
    mocks.createClient.mockResolvedValue(userClient('user-1'))
    mocks.getActiveCompanyId.mockResolvedValue('company-1')
    mocks.getBranding.mockReturnValue({ appName: 'gnubok' })
  })

  it('GET rejects a redirect URI registered by an unrelated user, even one named like Claude', async () => {
    const response = await GET(new Request(authorizeUrl('https://claude-login.example/cb')))
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toBe('invalid_request')
    expect(body.error_description).toBe('redirect_uri is not allowed')
  })

  it('POST rejects the same URI and mints no code', async () => {
    const response = await POST(
      new Request(authorizeUrl('https://claude-login.example/cb'), { method: 'POST', body: consentForm() }),
    )
    expect(response.status).toBe(400)
    expect(mocks.createAuthCode).not.toHaveBeenCalled()
  })

  it('GET accepts a redirect URI registered by a colleague in a shared company and names it', async () => {
    const response = await GET(new Request(authorizeUrl('https://app.example.com/cb')))
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('Byråns bot')
    expect(html).toContain('Registrerad av en kollega')
    expect(html).toContain('app.example.com')
    expect(html).not.toContain('Verifierad')
  })

  it("GET accepts the consenting user's own registration", async () => {
    const response = await GET(new Request(authorizeUrl('https://mine.example/cb')))
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('Min egen app')
    expect(html).toContain('Registrerad av dig')
  })

  it('POST for a colleague registration issues a code to that URI', async () => {
    const response = await POST(
      new Request(authorizeUrl('https://app.example.com/cb'), { method: 'POST', body: consentForm() }),
    )
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe('https://app.example.com')
    expect(location.searchParams.get('code')).toBe('test-auth-code')
  })

  it('GET accepts the built-in Claude callback without consulting the registration table', async () => {
    const response = await GET(new Request(authorizeUrl('https://claude.ai/api/mcp/auth_callback')))
    expect(response.status).toBe(200)
    expect(mocks.serviceClient).not.toHaveBeenCalled()
    expect(service.from).not.toHaveBeenCalled()
    const html = await response.text()
    expect(html).toContain('Claude (Anthropic)')
    expect(html).toContain('Verifierad')
  })
})
