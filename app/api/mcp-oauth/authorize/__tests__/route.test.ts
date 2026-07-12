import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  isAllowedRedirectUri: vi.fn(),
  requireCompanyId: vi.fn(),
  getBranding: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mocks.createClient(),
}))

vi.mock('@/lib/auth/oauth-allowlist', () => ({
  isAllowedRedirectUri: (...args: unknown[]) => mocks.isAllowedRedirectUri(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: (...args: unknown[]) => mocks.requireCompanyId(...args),
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => mocks.getBranding(),
}))

import { GET, POST } from '../route'

function buildAuthorizeUrl(params: Record<string, string>): string {
  const url = new URL('http://localhost/api/mcp-oauth/authorize')
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return url.toString()
}

function buildSupabase(
  user: { id: string } | null,
  companyName = 'Test AB',
  aal: { currentLevel: string; nextLevel: string } = { currentLevel: 'aal2', nextLevel: 'aal2' },
) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: aal, error: null }),
      },
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { company_name: companyName },
            error: null,
          }),
        }),
      }),
    }),
  }
}

describe('GET /api/mcp-oauth/authorize: CSP', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1' }))
    mocks.isAllowedRedirectUri.mockResolvedValue(true)
    mocks.requireCompanyId.mockResolvedValue('company-1')
    mocks.getBranding.mockReturnValue({ appName: 'gnubok' })
  })

  it("form-action includes the redirect_uri origin so the post-consent redirect isn't blocked", async () => {
    // Regression: the consent form POSTs same-origin, but the server's 303
    // response redirects to the client callback. CSP form-action re-checks
    // every hop in the chain, so 'self' alone blocks the post-consent step.
    const request = new Request(
      buildAuthorizeUrl({
        response_type: 'code',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        scope: 'mcp',
        state: 'xyz',
      })
    )
    const response = await GET(request)
    expect(response.status).toBe(200)

    const csp = response.headers.get('Content-Security-Policy')
    expect(csp).toBeTruthy()
    expect(csp).toMatch(/form-action 'self' https:\/\/claude\.ai(;|$)/)
    // 'self' is preserved so the same-origin POST still works.
    expect(csp).toContain("form-action 'self'")
  })

  it('form-action uses the redirect origin only (no path/query leakage)', async () => {
    const request = new Request(
      buildAuthorizeUrl({
        response_type: 'code',
        redirect_uri: 'https://claude.com/api/oauth/callback?env=prod',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        scope: 'mcp',
      })
    )
    const response = await GET(request)
    expect(response.status).toBe(200)

    const csp = response.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain('https://claude.com')
    // Origin only: no path, no query string in the source expression.
    expect(csp).not.toContain('/api/oauth/callback')
    expect(csp).not.toContain('env=prod')
  })

  it('renders both read and write rows when client passes only the legacy `mcp` scope marker', async () => {
    // Claude's connector sends scope=mcp today. The consent UI must render
    // every scope group so the user can opt into write/approval rows if they
    // want, but each write/approve row MUST start unchecked. Affirmative
    // opt-in is the access-control gate (GDPR Art. 25(2), ISO 27001:2022
    // A.5.18 / A.8.2, SOC 2 CC6.3, ASVS V10.2.2 / V2.3.1).
    const request = new Request(
      buildAuthorizeUrl({
        response_type: 'code',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        scope: 'mcp',
      })
    )
    const response = await GET(request)
    expect(response.status).toBe(200)
    const html = await response.text()

    // Every scope row is rendered so the user can opt into / out of each one.
    expect(html).toMatch(/value="transactions:write"/)
    expect(html).toMatch(/value="bookkeeping:write"/)
    expect(html).toMatch(/value="invoices:write"/)
    expect(html).toMatch(/value="pending_operations:approve"/)

    // Write and approval scopes MUST render unchecked. Users have to make an
    // affirmative, deliberate selection for each destructive permission.
    const writeRow = html.match(/<input[^>]*value="transactions:write"[^>]*>/)?.[0]
    expect(writeRow).toBeDefined()
    expect(writeRow!).not.toContain('checked')

    const approveRow = html.match(/<input[^>]*value="pending_operations:approve"[^>]*>/)?.[0]
    expect(approveRow).toBeDefined()
    expect(approveRow!).not.toContain('checked')

    const bookkeepingRow = html.match(/<input[^>]*value="bookkeeping:write"[^>]*>/)?.[0]
    expect(bookkeepingRow).toBeDefined()
    expect(bookkeepingRow!).not.toContain('checked')

    // The :read counterpart is pre-checked (safe default).
    const readRow = html.match(/<input[^>]*value="transactions:read"[^>]*>/)?.[0]
    expect(readRow).toBeDefined()
    expect(readRow!).toContain('checked')
  })

  it('renders only the requested scopes when the client passes them explicitly', async () => {
    // RFC 6749 §3.3 strict least-privilege: an explicit `scope=` shrinks the
    // ceiling, so a client that asked for read-only cannot have a write box
    // surface at consent time.
    const request = new Request(
      buildAuthorizeUrl({
        response_type: 'code',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        scope: 'transactions:read invoices:read',
      })
    )
    const response = await GET(request)
    expect(response.status).toBe(200)
    const html = await response.text()

    expect(html).toContain('value="transactions:read"')
    expect(html).toContain('value="invoices:read"')
    expect(html).not.toContain('value="transactions:write"')
    expect(html).not.toContain('value="bookkeeping:write"')
  })

  it('rejects disallowed redirect_uri before any CSP would be emitted', async () => {
    mocks.isAllowedRedirectUri.mockResolvedValue(false)
    const request = new Request(
      buildAuthorizeUrl({
        response_type: 'code',
        redirect_uri: 'https://evil.example/cb',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        scope: 'mcp',
      })
    )
    const response = await GET(request)
    expect(response.status).toBe(400)
    // Important: the form-action whitelist must never be populated from an
    // untrusted origin. A 400 here keeps the allowlist as the single source
    // of truth for which origins can land at this endpoint.
  })
})

describe('MFA step-up on /api/mcp-oauth/authorize', () => {
  // Consent here ultimately mints a long-lived API key that bypasses MFA on
  // every subsequent request, so an AAL1 (password-only) session must never
  // reach the consent page or approve it. The middleware MFA gate exempts
  // /api/mcp-oauth/*, making the route responsible for its own step-up.
  const authorizeParams = {
    response_type: 'code',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
    scope: 'mcp',
    state: 'xyz',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    mocks.isAllowedRedirectUri.mockResolvedValue(true)
    mocks.requireCompanyId.mockResolvedValue('company-1')
    mocks.getBranding.mockReturnValue({ appName: 'gnubok' })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('GET redirects an AAL1 session to /mfa/verify with returnTo', async () => {
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', { currentLevel: 'aal1', nextLevel: 'aal2' }),
    )

    const response = await GET(new Request(buildAuthorizeUrl(authorizeParams)))

    expect(response.status).toBeGreaterThanOrEqual(300)
    expect(response.status).toBeLessThan(400)
    const location = new URL(response.headers.get('location')!)
    expect(location.pathname).toBe('/mfa/verify')
    const returnTo = new URL(location.searchParams.get('returnTo')!, location.origin)
    expect(returnTo.pathname).toBe('/api/mcp-oauth/authorize')
    expect(returnTo.searchParams.get('state')).toBe('xyz')
  })

  it('POST rejects an AAL1 session even when the consent form is forged', async () => {
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', { currentLevel: 'aal1', nextLevel: 'aal2' }),
    )

    const formData = new FormData()
    formData.set('consent', 'allow')
    const response = await POST(
      new Request(buildAuthorizeUrl(authorizeParams), { method: 'POST', body: formData }),
    )

    expect(response.status).toBeGreaterThanOrEqual(300)
    expect(response.status).toBeLessThan(400)
    expect(new URL(response.headers.get('location')!).pathname).toBe('/mfa/verify')
    // No auth code must be minted: the redirect target is the step-up page,
    // never the client callback.
    expect(response.headers.get('location')).not.toContain('code=')
  })

  it('GET renders consent for an AAL2 session', async () => {
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', { currentLevel: 'aal2', nextLevel: 'aal2' }),
    )

    const response = await GET(new Request(buildAuthorizeUrl(authorizeParams)))
    expect(response.status).toBe(200)
  })

  it('GET skips step-up for BankID-linked users (inherently 2FA)', async () => {
    const supabase = buildSupabase(
      { id: 'user-1' },
      'Test AB',
      { currentLevel: 'aal1', nextLevel: 'aal2' },
    )
    ;(supabase.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: 'user-1', app_metadata: { bankid_linked: true } } },
      error: null,
    })
    mocks.createClient.mockResolvedValue(supabase)

    const response = await GET(new Request(buildAuthorizeUrl(authorizeParams)))
    expect(response.status).toBe(200)
  })
})
