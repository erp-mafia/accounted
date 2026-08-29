import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  isAllowedRedirectUri: vi.fn(),
  getActiveCompanyId: vi.fn(),
  getBranding: vi.fn(),
}))

vi.mock('@/lib/auth/oauth-codes', () => ({
  createAuthCode: vi.fn(() => 'test-auth-code'),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mocks.createClient(),
}))

vi.mock('@/lib/auth/oauth-allowlist', () => ({
  isAllowedRedirectUri: (...args: unknown[]) => mocks.isAllowedRedirectUri(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => mocks.getActiveCompanyId(...args),
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
  user: { id: string; email?: string } | null,
  companyName = 'Test AB',
  aal: { currentLevel: string; nextLevel: string } = { currentLevel: 'aal2', nextLevel: 'aal2' },
  verifiedFactors: number = aal.nextLevel === 'aal2' ? 1 : 0,
) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: aal, error: null }),
        listFactors: vi.fn().mockResolvedValue({
          data: {
            totp: Array.from({ length: verifiedFactors }, (_, i) => ({
              id: `factor-${i}`,
              status: 'verified',
            })),
          },
          error: null,
        }),
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
    mocks.getActiveCompanyId.mockResolvedValue('company-1')
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

  it('HTML-escapes the reflected query string in the form action', async () => {
    // The consent form posts back to the same URL, so url.search is echoed into
    // an HTML attribute, and only redirect_uri/client_id/scope are validated:
    // any extra parameter reaches that attribute.
    //
    // Two layers, and it is worth being precise about which does what. WHATWG
    // URL parsing already percent-encodes " < > in the query component, so an
    // injected tag arrives inert and CodeQL's js/reflected-xss report is not a
    // live exploit. But `&` is NOT in that encode set, so without escaping the
    // attribute carries raw ampersands, which is invalid HTML and leaves the
    // page one refactor (a raw header, a non-WHATWG parser) away from a real
    // breakout. This asserts the escaping layer, independent of the parser.
    const request = new Request(
      buildAuthorizeUrl({
        response_type: 'code',
        redirect_uri: 'https://claude.com/api/oauth/callback',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        scope: 'mcp',
      }) + '&evil=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E'
    )
    const response = await GET(request)
    expect(response.status).toBe(200)

    const html = await response.text()
    const action = html.match(/<form method="POST" action="([^"]*)"/)?.[1]
    expect(action).toBeDefined()

    // Separators are entity-encoded: proof escapeHtml ran over the whole thing.
    expect(action).toContain('&amp;evil=')
    expect(action).not.toMatch(/&(?!amp;|quot;|lt;|gt;)/)
    // The attribute is never closed early, so no raw markup escapes into the page.
    expect(html).not.toContain('"><script>')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('renders both read and write rows when client passes only the legacy `mcp` scope marker', async () => {
    // Claude's connector sends scope=mcp today. The consent UI renders every
    // scope group with ALL rows pre-checked (one-click consent, founder
    // decision 2026-08-26): the affirmative act is the Allow click on a page
    // that shows the full set, every write is staged for approval before it
    // touches the ledger, and each row stays individually untickable.
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

    // Every row starts checked: the deliberate act is the visible Allow
    // click, and unticking stays available per row inside the details fold.
    const writeRow = html.match(/<input[^>]*value="transactions:write"[^>]*>/)?.[0]
    expect(writeRow).toBeDefined()
    expect(writeRow!).toContain('checked')

    const approveRow = html.match(/<input[^>]*value="pending_operations:approve"[^>]*>/)?.[0]
    expect(approveRow).toBeDefined()
    expect(approveRow!).toContain('checked')

    const bookkeepingRow = html.match(/<input[^>]*value="bookkeeping:write"[^>]*>/)?.[0]
    expect(bookkeepingRow).toBeDefined()
    expect(bookkeepingRow!).toContain('checked')

    // The :read counterpart is pre-checked too.
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
    mocks.getActiveCompanyId.mockResolvedValue('company-1')
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

  it('GET fails closed to /mfa/verify when the assurance lookup returns nothing', async () => {
    // A transient auth error must never read as "no MFA needed": consent
    // here mints a key that bypasses MFA on every later call.
    const supabase = buildSupabase({ id: 'user-1' }, 'Test AB', { currentLevel: 'aal1', nextLevel: 'aal1' }, 1)
    ;(supabase.auth.mfa.getAuthenticatorAssuranceLevel as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    })
    mocks.createClient.mockResolvedValue(supabase)

    const response = await GET(new Request(buildAuthorizeUrl(authorizeParams)))
    expect(new URL(response.headers.get('location')!).pathname).toBe('/mfa/verify')
  })

  it('GET steps up (not enroll) when a verified factor exists despite an AAL1 answer', async () => {
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', { currentLevel: 'aal1', nextLevel: 'aal1' }, 1),
    )

    const response = await GET(new Request(buildAuthorizeUrl(authorizeParams)))
    expect(new URL(response.headers.get('location')!).pathname).toBe('/mfa/verify')
  })

  it('GET sends a password account with no factor to /mfa/enroll with returnTo', async () => {
    // A brand-new account created inside the OAuth popup (issue #1814) has no
    // company, so the middleware never forced enrollment. Without this leg the
    // consent would mint an MFA-exempt key for an account with no second factor.
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', { currentLevel: 'aal1', nextLevel: 'aal1' }, 0),
    )

    const response = await GET(new Request(buildAuthorizeUrl(authorizeParams)))

    expect(response.status).toBeGreaterThanOrEqual(300)
    expect(response.status).toBeLessThan(400)
    const location = new URL(response.headers.get('location')!)
    expect(location.pathname).toBe('/mfa/enroll')
    const returnTo = new URL(location.searchParams.get('returnTo')!, location.origin)
    expect(returnTo.pathname).toBe('/api/mcp-oauth/authorize')
    expect(returnTo.searchParams.get('state')).toBe('xyz')
  })

  it('POST refuses consent from a password account with no factor', async () => {
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', { currentLevel: 'aal1', nextLevel: 'aal1' }, 0),
    )

    const formData = new FormData()
    formData.set('consent', 'allow')
    const response = await POST(
      new Request(buildAuthorizeUrl(authorizeParams), { method: 'POST', body: formData }),
    )

    expect(new URL(response.headers.get('location')!).pathname).toBe('/mfa/enroll')
    expect(response.headers.get('location')).not.toContain('code=')
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

describe('account with no company yet (issue #1814)', () => {
  // Someone who signed up inside the MCP client's OAuth popup has an account
  // but no company. Consent must still complete: the key is minted unbound
  // and binds itself once the company exists.
  const authorizeParams = {
    response_type: 'code',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
    scope: 'mcp',
    state: 'xyz',
  }

  function signScope(scopeParam: string): string {
    const key = crypto.createHash('sha256').update('oauth-scope:test-service-key').digest()
    return crypto.createHmac('sha256', key).update(scopeParam).digest('base64url')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    mocks.isAllowedRedirectUri.mockResolvedValue(true)
    mocks.getActiveCompanyId.mockResolvedValue(null)
    mocks.getBranding.mockReturnValue({ appName: 'gnubok' })
  })

  it('GET renders consent labelled with the account instead of a company', async () => {
    const supabase = buildSupabase({ id: 'user-1', email: 'ny@example.se' })
    mocks.createClient.mockResolvedValue(supabase)

    const response = await GET(new Request(buildAuthorizeUrl(authorizeParams)))
    expect(response.status).toBe(200)

    const html = await response.text()
    expect(html).toContain('ny@example.se')
    expect(html).toContain('inget företag')
    expect(html).not.toContain('Test AB')
    // No company to look up: company_settings is never queried.
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('pre-ticks every scope for a companyless account (one-click consent covers the create flow)', async () => {
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1', email: 'ny@example.se' }))

    const response = await GET(new Request(buildAuthorizeUrl(authorizeParams)))
    const html = await response.text()

    const companiesWrite = html.match(/<input[^>]*value="companies:write"[^>]*>/)?.[0]
    expect(companiesWrite).toBeDefined()
    expect(companiesWrite!).toContain('checked')
    const transactionsWrite = html.match(/<input[^>]*value="transactions:write"[^>]*>/)?.[0]
    expect(transactionsWrite).toBeDefined()
    expect(transactionsWrite!).toContain('checked')
  })

  it('POST still issues an authorization code', async () => {
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1', email: 'ny@example.se' }))

    const formData = new FormData()
    formData.set('consent', 'allow')
    formData.set('scope_binding', 'mcp')
    formData.set('scope_binding_sig', signScope('mcp'))

    const response = await POST(
      new Request(buildAuthorizeUrl(authorizeParams), { method: 'POST', body: formData }),
    )

    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location')!)
    expect(location.searchParams.get('code')).toBe('test-auth-code')
    expect(location.searchParams.get('state')).toBe('xyz')
  })
})

describe('RFC 9207 iss parameter on authorization responses', () => {
  const authorizeParams = {
    response_type: 'code',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
    scope: 'mcp',
    state: 'xyz',
  }

  // Mirrors getScopeSigningKey/signScopeBinding in the route so the POST can
  // present a scope binding that verifies against the test service key.
  function signScope(scopeParam: string): string {
    const key = crypto.createHash('sha256').update('oauth-scope:test-service-key').digest()
    return crypto.createHmac('sha256', key).update(scopeParam).digest('base64url')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.test.example')
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1' }))
    mocks.isAllowedRedirectUri.mockResolvedValue(true)
    mocks.getActiveCompanyId.mockResolvedValue('company-1')
    mocks.getBranding.mockReturnValue({ appName: 'gnubok' })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('includes iss alongside code and state on the success redirect', async () => {
    const formData = new FormData()
    formData.set('consent', 'allow')
    formData.set('scope_binding', 'mcp')
    formData.set('scope_binding_sig', signScope('mcp'))

    const response = await POST(
      new Request(buildAuthorizeUrl(authorizeParams), { method: 'POST', body: formData }),
    )

    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location')!)
    expect(location.searchParams.get('code')).toBe('test-auth-code')
    expect(location.searchParams.get('state')).toBe('xyz')
    expect(location.searchParams.get('iss')).toBe('https://app.test.example')
  })

  it('includes iss on error redirects (access_denied)', async () => {
    const formData = new FormData()
    formData.set('consent', 'deny')

    const response = await POST(
      new Request(buildAuthorizeUrl(authorizeParams), { method: 'POST', body: formData }),
    )

    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('iss')).toBe('https://app.test.example')
  })
})
