import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'
import vm from 'node:vm'
import type { RedirectUriResolution } from '@/lib/auth/oauth-allowlist'
import { ALL_SCOPES, STAGING_SCOPES, findStageApproveConflict } from '@/lib/auth/scope-catalog'

type PickerCompany = { company_id: string; name: string; role: string }

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  resolveRedirectUri: vi.fn(),
  getActiveCompanyId: vi.fn(),
  getBranding: vi.fn(),
  createAuthCode: vi.fn<(...args: unknown[]) => string>(() => 'test-auth-code'),
  // Default: a single-company user, so the consent page renders no picker and
  // every pre-existing test keeps its shape. Multi-company tests override
  // with mockResolvedValue; clearAllMocks keeps this implementation.
  listUserCompaniesForPicker: vi.fn(
    (_supabase: unknown, _userId: string, options?: { activeCompanyId?: string | null }) =>
      Promise.resolve(
        options?.activeCompanyId
          ? [{ company_id: options.activeCompanyId, name: 'Test AB', role: 'owner' }]
          : [],
      ),
  ),
}))

vi.mock('@/lib/company/company-picker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/company/company-picker')>()
  return {
    ...actual,
    listUserCompaniesForPicker: (
      supabase: unknown,
      userId: string,
      options?: { activeCompanyId?: string | null },
    ) => mocks.listUserCompaniesForPicker(supabase, userId, options),
  }
})

vi.mock('@/lib/auth/oauth-codes', () => ({
  createAuthCode: (...args: unknown[]) => mocks.createAuthCode(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mocks.createClient(),
}))

// Only the redirect-URI resolution is replaced: the role cap helpers from the
// same module run for real so the tests exercise the actual ceiling logic.
vi.mock('@/lib/auth/oauth-allowlist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/oauth-allowlist')>()
  return {
    ...actual,
    resolveRedirectUri: (...args: unknown[]) => mocks.resolveRedirectUri(...args),
  }
})

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => mocks.getActiveCompanyId(...args),
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => mocks.getBranding(),
}))

import { GET, POST } from '../route'

const CLAUDE: RedirectUriResolution = { allowed: true, kind: 'built_in', provider: 'claude' }
const CHATGPT: RedirectUriResolution = { allowed: true, kind: 'built_in', provider: 'chatgpt' }
const GROK: RedirectUriResolution = { allowed: true, kind: 'built_in', provider: 'grok' }
const CURSOR: RedirectUriResolution = { allowed: true, kind: 'built_in', provider: 'cursor' }
const CURSOR_DEEPLINK: RedirectUriResolution = { allowed: true, kind: 'built_in', provider: 'cursor_deeplink' }
const GEMINI: RedirectUriResolution = { allowed: true, kind: 'built_in', provider: 'gemini' }
const REGISTERED: RedirectUriResolution = {
  allowed: true,
  kind: 'registered',
  clientName: 'Byråns bokföringsbot',
  registeredByConsentingUser: false,
}

function buildAuthorizeUrl(params: Record<string, string>): string {
  const url = new URL('http://localhost/api/mcp-oauth/authorize')
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return url.toString()
}

/**
 * Chainable query stub: every builder method returns the chain, and the chain
 * resolves to `result` whether awaited directly or via single()/maybeSingle().
 */
function tableChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'is', 'in', 'order', 'range', 'limit']) {
    chain[method] = vi.fn(() => chain)
  }
  chain.single = vi.fn().mockResolvedValue(result)
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  chain.then = (resolve: (v: unknown) => void) => resolve(result)
  return chain
}

type Membership = { role: string | null } | { error: string }

function buildSupabase(
  user: { id: string; email?: string } | null,
  companyName = 'Test AB',
  aal: { currentLevel: string; nextLevel: string } = { currentLevel: 'aal2', nextLevel: 'aal2' },
  verifiedFactors: number = aal.nextLevel === 'aal2' ? 1 : 0,
  membership: Membership = { role: 'owner' },
) {
  const settingsResult = { data: { company_name: companyName }, error: null }
  const membershipResult =
    'error' in membership
      ? { data: null, error: { message: membership.error } }
      : { data: membership.role === null ? null : { role: membership.role }, error: null }
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
    from: vi.fn((table: string) =>
      table === 'company_members' ? tableChain(membershipResult) : tableChain(settingsResult),
    ),
  }
}

// Mirrors getScopeSigningKey/signScopeBinding in the route so a POST can
// present a scope binding that verifies against the test service key.
function signScope(scopeParam: string): string {
  const key = crypto.createHash('sha256').update('oauth-scope:test-service-key').digest()
  return crypto.createHmac('sha256', key).update(scopeParam).digest('base64url')
}

function consentForm(scopeParam: string, scopes: string[] = []): FormData {
  const formData = new FormData()
  formData.set('consent', 'allow')
  formData.set('scope_binding', scopeParam)
  formData.set('scope_binding_sig', signScope(scopeParam))
  for (const s of scopes) formData.append('scopes', s)
  return formData
}

function checkboxFor(html: string, scope: string): string | undefined {
  return html.match(new RegExp(`<input[^>]*value="${scope}"[^>]*>`))?.[0]
}

function lastMintedPayload(): Record<string, unknown> {
  const calls = mocks.createAuthCode.mock.calls as unknown[][]
  return calls[calls.length - 1]![0] as Record<string, unknown>
}

/** The scope values the rendered page has ticked, as the browser would post them. */
function checkedScopes(html: string): string[] {
  return [...html.matchAll(/<input type="checkbox"[^>]*name="scopes"[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => /\schecked(\s|>)/.test(tag))
    .map((tag) => tag.match(/value="([^"]*)"/)![1]!)
}

type FakeBox = {
  value: string
  checked: boolean
  dataset: Record<string, string>
  listeners: Array<() => void>
  addEventListener: (type: string, fn: () => void) => void
}

/**
 * Runs the consent page's inline script, as shipped, against a minimal DOM
 * built from the rendered checkboxes and the segregation-of-duties sentence.
 * The unit project has no browser DOM; the script only touches these few
 * properties, so a fake keeps the client-side toggle under test.
 */
function runConsentScript(html: string) {
  const script = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/)?.[1]
  expect(script).toBeDefined()
  const boxes: FakeBox[] = [...html.matchAll(/<input type="checkbox"[^>]*name="scopes"[^>]*>/g)].map(
    ([tag]) => {
      const listeners: Array<() => void> = []
      return {
        value: tag.match(/value="([^"]*)"/)![1]!,
        checked: /\schecked(\s|>)/.test(tag),
        dataset: {
          kind: tag.match(/data-kind="([^"]*)"/)?.[1] ?? '',
          ...(/data-staging="1"/.test(tag) ? { staging: '1' } : {}),
        },
        listeners,
        addEventListener: (type: string, fn: () => void) => {
          if (type === 'change') listeners.push(fn)
        },
      }
    },
  )
  const sodTag = html.match(/<p[^>]*id="sod-note"[^>]*>/)?.[0]
  const sodNote = sodTag ? { hidden: /\shidden(\s|>)/.test(sodTag) } : null
  const clickHandlers: Record<string, () => void> = {}
  const button = (id: string) => ({
    addEventListener: (_type: string, fn: () => void) => {
      clickHandlers[id] = fn
    },
  })
  const form = {
    querySelectorAll: (selector: string) => (selector === 'input[name="scopes"]' ? boxes : []),
  }
  const document = {
    getElementById: (id: string) => {
      if (id === 'consent-form') return form
      if (id === 'sod-note') return sodNote
      if (id === 'select-read' || id === 'select-all' || id === 'select-none') return button(id)
      return null
    },
  }
  vm.runInNewContext(script!, { document })
  return {
    sodNote,
    set(value: string, checked: boolean) {
      const box = boxes.find((b) => b.value === value)
      expect(box, value).toBeDefined()
      box!.checked = checked
      box!.listeners.forEach((fn) => fn())
    },
    click(id: 'select-read' | 'select-all' | 'select-none') {
      clickHandlers[id]!()
    },
  }
}

describe('GET /api/mcp-oauth/authorize: CSP', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1' }))
    mocks.resolveRedirectUri.mockResolvedValue(CLAUDE)
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

  it("binds the consent script to the proxy's nonce so it runs under either CSP header", async () => {
    // The proxy (src/proxy.ts) sets its own nonce policy on this response
    // too, and a self-hosted `next start` delivers only that one: the page's
    // script must carry the proxy's nonce, and so must the route's own policy.
    const proxyNonce = 'cHJveHktbm9uY2UtMTIzNDU2Nzg='
    const request = new Request(
      buildAuthorizeUrl({
        response_type: 'code',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        scope: 'mcp',
      }),
      { headers: { 'x-nonce': proxyNonce } },
    )
    const response = await GET(request)
    expect(response.status).toBe(200)

    const csp = response.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain(`script-src 'nonce-${proxyNonce}'`)
    const html = await response.text()
    expect(html).toContain(`<script nonce="${proxyNonce}">`)
    expect(html).not.toMatch(/<script(?![^>]*nonce=)/)
  })

  it('mints its own nonce when the request did not come through the proxy', async () => {
    const request = new Request(
      buildAuthorizeUrl({
        response_type: 'code',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        scope: 'mcp',
      }),
      // Not something the proxy produces: ignored, never echoed.
      { headers: { 'x-nonce': 'x" onload="alert(1)' } },
    )
    const response = await GET(request)
    const csp = response.headers.get('Content-Security-Policy') ?? ''
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1]
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    const html = await response.text()
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(html).not.toContain('onload="alert(1)')
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
    // scope group with every row pre-checked except approve (one-click
    // consent, founder decisions 2026-08-26 and 2026-10-03): the affirmative
    // act is the Allow click on a page that shows the full set, every write
    // is staged as a proposal the user approves, and each row stays
    // individually untickable.
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

    // Write rows start checked: the deliberate act is the visible Allow
    // click, and unticking stays available per row inside the details fold.
    // Approve is the exception: the user ticks it themselves (option B).
    expect(checkboxFor(html, 'transactions:write')).toContain('checked')
    expect(checkboxFor(html, 'pending_operations:approve')).not.toContain('checked')
    expect(checkboxFor(html, 'bookkeeping:write')).toContain('checked')

    // The :read counterpart is pre-checked too.
    expect(checkboxFor(html, 'transactions:read')).toContain('checked')
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

  it('rejects a redirect_uri the allowlist refuses for this user before any CSP would be emitted', async () => {
    mocks.resolveRedirectUri.mockResolvedValue({ allowed: false })
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

  it('binds the redirect_uri check to the consenting user on GET and POST', async () => {
    // The allowlist can only tell a colleague's registration from a
    // stranger's when it knows who is consenting. Both handlers must pass it.
    const params = {
      response_type: 'code',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
      scope: 'mcp',
    }
    await GET(new Request(buildAuthorizeUrl(params)))
    expect(mocks.resolveRedirectUri).toHaveBeenLastCalledWith(
      'https://claude.ai/api/mcp/auth_callback',
      undefined,
      { consentingUserId: 'user-1' },
    )

    await POST(new Request(buildAuthorizeUrl(params), { method: 'POST', body: consentForm('mcp') }))
    expect(mocks.resolveRedirectUri).toHaveBeenLastCalledWith(
      'https://claude.ai/api/mcp/auth_callback',
      undefined,
      { consentingUserId: 'user-1' },
    )
  })
})

describe('client identity on the consent page', () => {
  const params = {
    response_type: 'code',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
    scope: 'mcp',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1' }))
    mocks.getActiveCompanyId.mockResolvedValue('company-1')
    mocks.getBranding.mockReturnValue({ appName: 'gnubok' })
  })

  it('names Claude as a verified client and shows the redirect host', async () => {
    mocks.resolveRedirectUri.mockResolvedValue(CLAUDE)
    const html = await (await GET(new Request(buildAuthorizeUrl(params)))).text()

    expect(html).toContain('Claude (Anthropic)')
    expect(html).toContain('Verifierad')
    expect(html).toContain('Skickar dig vidare till')
    expect(html).toContain('claude.ai')
    // The generic "en extern applikation" wording is gone: the client is named.
    expect(html).not.toContain('En extern applikation')
  })

  it('names ChatGPT for chatgpt.com callbacks', async () => {
    mocks.resolveRedirectUri.mockResolvedValue(CHATGPT)
    const html = await (
      await GET(
        new Request(
          buildAuthorizeUrl({ ...params, redirect_uri: 'https://chatgpt.com/connector/oauth/abc' }),
        ),
      )
    ).text()

    expect(html).toContain('ChatGPT (OpenAI)')
    expect(html).toContain('chatgpt.com')
  })

  it('names Grok as a verified client for the grok.com callback', async () => {
    mocks.resolveRedirectUri.mockResolvedValue(GROK)
    const html = await (
      await GET(
        new Request(
          buildAuthorizeUrl({
            ...params,
            redirect_uri: 'https://grok.com/connectors-oauth-exchange-code/',
          }),
        ),
      )
    ).text()

    expect(html).toContain('Grok (xAI)')
    expect(html).toContain('Verifierad')
    expect(html).toContain('grok.com')
    expect(html).not.toContain('En extern applikation')
  })

  it('names Cursor as a verified client for the cursor.com callback', async () => {
    mocks.resolveRedirectUri.mockResolvedValue(CURSOR)
    const html = await (
      await GET(
        new Request(
          buildAuthorizeUrl({
            ...params,
            redirect_uri: 'https://www.cursor.com/agents/mcp/oauth/callback',
          }),
        ),
      )
    ).text()

    expect(html).toContain('Cursor (Anysphere)')
    expect(html).toContain('Verifierad')
    expect(html).toContain('www.cursor.com')
    expect(html).not.toContain('En extern applikation')
  })

  it('shows the cursor:// deeplink as Cursor but unverified, like localhost', async () => {
    // Any local app can claim a custom scheme (RFC 8252 section 8.4), so the
    // page must not present it as a vendor-verified callback.
    mocks.resolveRedirectUri.mockResolvedValue(CURSOR_DEEPLINK)
    const html = await (
      await GET(
        new Request(
          buildAuthorizeUrl({
            ...params,
            redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback',
          }),
        ),
      )
    ).text()

    expect(html).toContain('Cursor (Anysphere)')
    expect(html).toContain('Din egen dator')
    expect(html).not.toContain('Verifierad')
    expect(html).not.toContain('En extern applikation')
  })

  it('form-action uses a scheme-source for a custom-scheme redirect_uri', async () => {
    // new URL('cursor://...').origin is the string "null", which CSP reads as
    // a host named "null": with that the post-consent 303 to the deeplink is
    // blocked in Chromium. The scheme-source form (cursor:) lets it through.
    mocks.resolveRedirectUri.mockResolvedValue(CURSOR_DEEPLINK)
    const response = await GET(
      new Request(
        buildAuthorizeUrl({
          ...params,
          redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback',
        }),
      ),
    )
    expect(response.status).toBe(200)
    const csp = response.headers.get('Content-Security-Policy')
    expect(csp).toMatch(/form-action 'self' cursor:(;|$)/)
    expect(csp).not.toContain('null')
  })

  it('shows client_name and redirect host for a DB-registered client, never marked verified', async () => {
    mocks.resolveRedirectUri.mockResolvedValue(REGISTERED)
    const html = await (
      await GET(
        new Request(buildAuthorizeUrl({ ...params, redirect_uri: 'https://app.example.com/cb' })),
      )
    ).text()

    expect(html).toContain('Byråns bokföringsbot')
    expect(html).toContain('app.example.com')
    expect(html).toContain('Registrerad av en kollega')
    expect(html).not.toContain('Verifierad')
    expect(html).not.toContain('Claude')
  })

  it('HTML-escapes a hostile client_name', async () => {
    mocks.resolveRedirectUri.mockResolvedValue({
      ...REGISTERED,
      clientName: '<img src=x onerror=alert(1)>Claude (Anthropic)',
      registeredByConsentingUser: true,
    })
    const html = await (
      await GET(
        new Request(buildAuthorizeUrl({ ...params, redirect_uri: 'https://app.example.com/cb' })),
      )
    ).text()

    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('Registrerad av dig')
  })
})

describe('scope defaults for DB-registered clients', () => {
  const params = {
    response_type: 'code',
    redirect_uri: 'https://app.example.com/cb',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1' }))
    mocks.resolveRedirectUri.mockResolvedValue(REGISTERED)
    mocks.getActiveCompanyId.mockResolvedValue('company-1')
    mocks.getBranding.mockReturnValue({ appName: 'gnubok' })
  })

  it('pre-checks only read scopes when a registered client sends no scope', async () => {
    // The ceiling stays ALL_SCOPES so the user can still opt in, but a
    // registration is just a URL a member typed into settings: writes and
    // approval must be a deliberate tick, never a default.
    const html = await (await GET(new Request(buildAuthorizeUrl(params)))).text()

    expect(checkboxFor(html, 'transactions:read')).toContain('checked')
    expect(checkboxFor(html, 'reports:read')).toContain('checked')

    expect(checkboxFor(html, 'transactions:write')).toBeDefined()
    expect(checkboxFor(html, 'transactions:write')).not.toContain('checked')
    expect(checkboxFor(html, 'bookkeeping:write')).not.toContain('checked')
    expect(checkboxFor(html, 'pending_operations:approve')).not.toContain('checked')
    expect(checkboxFor(html, 'webhooks:manage')).not.toContain('checked')

    expect(html).toContain('Endast läs förvalt')
    expect(html).toContain('Endast läsbehörigheter är förvalda')
  })

  it('pre-checks write scopes only when the registered client explicitly requested them', async () => {
    const html = await (
      await GET(
        new Request(
          buildAuthorizeUrl({ ...params, scope: 'transactions:read transactions:write' }),
        ),
      )
    ).text()

    expect(checkboxFor(html, 'transactions:write')).toContain('checked')
    expect(checkboxFor(html, 'transactions:read')).toContain('checked')
    // Not requested: not even rendered.
    expect(html).not.toContain('value="pending_operations:approve"')
  })

  it('states the segregation-of-duties rule when stage and approve scopes are both on offer', async () => {
    const html = await (await GET(new Request(buildAuthorizeUrl(params)))).text()
    expect(html).toContain('medgivande')
    // On the page, but hidden until approve is ticked (nothing is pre-ticked).
    expect(html).toMatch(/<p class="warn-sod" id="sod-note" hidden>[^<]*medgivande/)

    const readOnly = await (
      await GET(new Request(buildAuthorizeUrl({ ...params, scope: 'transactions:read' })))
    ).text()
    expect(readOnly).not.toContain('medgivande')
  })
})

describe('approve is never pre-ticked (issue #3408, founder decision 2026-10-03, option B)', () => {
  const params = {
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
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1' }))
    mocks.resolveRedirectUri.mockResolvedValue(CLAUDE)
    mocks.getActiveCompanyId.mockResolvedValue('company-1')
    mocks.getBranding.mockReturnValue({ appName: 'gnubok' })
  })

  it.each([
    ['Claude', CLAUDE],
    ['ChatGPT', CHATGPT],
    ['Grok', GROK],
    ['Gemini', GEMINI],
    ['Cursor', CURSOR],
    ['Cursor deeplink', CURSOR_DEEPLINK],
  ])('%s, owner: pre-ticks every scope in the ceiling except pending_operations:approve', async (_name, resolution) => {
    mocks.resolveRedirectUri.mockResolvedValue(resolution)
    const html = await (await GET(new Request(buildAuthorizeUrl(params)))).text()

    for (const scope of ALL_SCOPES) {
      const box = checkboxFor(html, scope)
      expect(box, scope).toBeDefined()
      if (scope === 'pending_operations:approve') {
        expect(box, scope).not.toContain('checked')
      } else {
        expect(box, scope).toContain('checked')
      }
    }
    // Every write scope that stages a proposal is in the default, so the
    // agent flow keeps working without an insufficient-scope dead-end.
    for (const scope of STAGING_SCOPES) expect(checkboxFor(html, scope), scope).toContain('checked')
    expect(findStageApproveConflict(checkedScopes(html) as typeof ALL_SCOPES)).toBeNull()
  })

  it('keeps approve unticked even when a client asks for it explicitly', async () => {
    const scope = 'transactions:read transactions:write pending_operations:read pending_operations:approve'
    for (const resolution of [CLAUDE, REGISTERED]) {
      mocks.resolveRedirectUri.mockResolvedValue(resolution)
      const html = await (await GET(new Request(buildAuthorizeUrl({ ...params, scope })))).text()
      expect(checkboxFor(html, 'transactions:write')).toContain('checked')
      expect(checkboxFor(html, 'pending_operations:read')).toContain('checked')
      expect(checkboxFor(html, 'pending_operations:approve')).toBeDefined()
      expect(checkboxFor(html, 'pending_operations:approve')).not.toContain('checked')
    }
  })

  it('says that everything except Godkänn is pre-selected', async () => {
    const html = await (await GET(new Request(buildAuthorizeUrl(params)))).text()
    expect(html).toContain('Läs och skriv är förvalda. Godkänn är inte förvalt: det väljer du själv nedan.')
    expect(html).toContain('Allt utom Godkänn förvalt')
    expect(html).not.toContain('Alla behörigheter är förvalda')
  })

  it('POSTing the boxes the page pre-ticks grants the write scopes without approve', async () => {
    const html = await (await GET(new Request(buildAuthorizeUrl(params)))).text()
    const response = await POST(
      new Request(buildAuthorizeUrl(params), { method: 'POST', body: consentForm('mcp', checkedScopes(html)) }),
    )
    expect(response.status).toBe(303)
    const granted = lastMintedPayload().scopes as typeof ALL_SCOPES
    expect(granted).toContain('transactions:write')
    expect(granted).toContain('bookkeeping:write')
    expect(granted).toContain('pending_operations:read')
    expect(granted).not.toContain('pending_operations:approve')
    expect(findStageApproveConflict(granted)).toBeNull()
  })

  it('explains read, write and approve in three plain lines, without staging jargon or a contradiction', async () => {
    const html = await (await GET(new Request(buildAuthorizeUrl(params)))).text()
    expect(html).toContain('<strong>Läs:</strong> Claude kan läsa och svara på frågor om bokföringen men ändrar inget.')
    expect(html).toContain('<strong>Skriv:</strong> Claude förbereder förslag som du godkänner under Att göra &rsaquo; Agentförslag.')
    expect(html).toContain('<strong>Godkänn:</strong> Claude får godkänna sina egna förslag och då bokförs det utan din granskning.')
    expect(html).toContain(
      'Behörigheterna går inte att ändra på en befintlig anslutning, så koppla från under Inställningar &rsaquo; API och MCP och anslut igen.',
    )
    expect(html).not.toMatch(/stagea/i)
    expect(html).not.toContain('Varje skrivoperation kräver ditt godkännande')
  })

  it('names the actual client in the lines, never a hardcoded Claude', async () => {
    mocks.resolveRedirectUri.mockResolvedValue(CHATGPT)
    const chatgpt = await (await GET(new Request(buildAuthorizeUrl(params)))).text()
    expect(chatgpt).toContain('ChatGPT kan läsa och svara på frågor om bokföringen')
    expect(chatgpt).toContain('ChatGPT får godkänna sina egna förslag')

    mocks.resolveRedirectUri.mockResolvedValue({ ...REGISTERED, clientName: 'Bot <b>&</b> Co' })
    const registered = await (
      await GET(new Request(buildAuthorizeUrl({ ...params, redirect_uri: 'https://app.example.com/cb' })))
    ).text()
    expect(registered).toContain('Bot &lt;b&gt;&amp;&lt;/b&gt; Co kan läsa och svara på frågor om bokföringen')
    expect(registered).not.toContain('<b>&</b>')
  })

  it('shows a viewer only the read line, with no approve line and no SoD sentence', async () => {
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', undefined, undefined, { role: 'viewer' }),
    )
    const html = await (await GET(new Request(buildAuthorizeUrl(params)))).text()
    expect(html).toContain('<strong>Läs:</strong>')
    expect(html).not.toContain('<strong>Skriv:</strong>')
    expect(html).not.toContain('<strong>Godkänn:</strong>')
    expect(html).not.toContain('id="sod-note"')
    expect(html).not.toContain('medgivande')
  })

  it('renders the SoD sentence hidden while approve is unticked', async () => {
    const html = await (await GET(new Request(buildAuthorizeUrl(params)))).text()
    expect(html).toMatch(
      /<p class="warn-sod" id="sod-note" hidden>Du har valt Godkänn: Claude kan då både förbereda och godkänna bokföring utan din granskning, och ditt klick på Tillåt åtkomst registreras som ditt medgivande till det\.<\/p>/,
    )
    // The marker the script keys on matches findStageApproveConflict.
    for (const scope of STAGING_SCOPES) expect(checkboxFor(html, scope), scope).toContain('data-staging="1"')
    expect(checkboxFor(html, 'agent:write')).not.toContain('data-staging')
    expect(checkboxFor(html, 'webhooks:manage')).not.toContain('data-staging')
    expect(checkboxFor(html, 'pending_operations:approve')).not.toContain('data-staging')
  })

  it('the inline script shows the SoD sentence only while approve is ticked together with a staging scope', async () => {
    const html = await (await GET(new Request(buildAuthorizeUrl(params)))).text()
    const page = runConsentScript(html)
    expect(page.sodNote).not.toBeNull()
    expect(page.sodNote!.hidden).toBe(true)

    page.set('pending_operations:approve', true)
    expect(page.sodNote!.hidden).toBe(false)

    page.set('pending_operations:approve', false)
    expect(page.sodNote!.hidden).toBe(true)

    // Approve with only non-staging writes and reads: no conflict, no sentence.
    page.click('select-none')
    page.set('pending_operations:read', true)
    page.set('agent:write', true)
    page.set('webhooks:manage', true)
    page.set('pending_operations:approve', true)
    expect(page.sodNote!.hidden).toBe(true)
    page.set('transactions:write', true)
    expect(page.sodNote!.hidden).toBe(false)

    // The shortcut buttons keep it in step too.
    page.click('select-read')
    expect(page.sodNote!.hidden).toBe(true)
    page.click('select-all')
    expect(page.sodNote!.hidden).toBe(false)
  })

  it('labels the approve row Agentförslag with a godkänn tag', async () => {
    const html = await (await GET(new Request(buildAuthorizeUrl(params)))).text()
    const approveRow = html.match(
      /<div class="scope-row write">\s*<input[^>]*value="pending_operations:approve"[^>]*>[\s\S]*?<\/div>/,
    )?.[0]
    expect(approveRow).toBeDefined()
    expect(approveRow).toContain('<span class="scope-name">Agentförslag</span>')
    expect(approveRow).toContain('<span class="scope-tag">godkänn</span>')
    expect(html).toContain('<div class="scope-group-title">Agentförslag</div>')
    expect(html).not.toMatch(/stagade operationer/i)
  })
})

describe('role cap on consent', () => {
  const params = {
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
    mocks.resolveRedirectUri.mockResolvedValue(CLAUDE)
    mocks.getActiveCompanyId.mockResolvedValue('company-1')
    mocks.getBranding.mockReturnValue({ appName: 'gnubok' })
  })

  it('viewer: GET offers read scopes only and says why', async () => {
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', undefined, undefined, { role: 'viewer' }),
    )
    const response = await GET(new Request(buildAuthorizeUrl(params)))
    expect(response.status).toBe(200)
    const html = await response.text()

    expect(checkboxFor(html, 'transactions:read')).toContain('checked')
    expect(html).not.toContain('value="transactions:write"')
    expect(html).not.toContain('value="pending_operations:approve"')
    expect(html).not.toContain('value="webhooks:manage"')
    expect(html).toContain('läsare')
  })

  it('viewer: POST caps a forged write selection to read scopes and records the company', async () => {
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', undefined, undefined, { role: 'viewer' }),
    )
    const response = await POST(
      new Request(buildAuthorizeUrl(params), {
        method: 'POST',
        body: consentForm('mcp', ['transactions:read', 'transactions:write', 'pending_operations:approve']),
      }),
    )
    expect(response.status).toBe(303)
    expect(new URL(response.headers.get('location')!).searchParams.get('code')).toBe('test-auth-code')

    const payload = lastMintedPayload()
    expect(payload.scopes).toEqual(['transactions:read'])
    expect(payload.companyId).toBe('company-1')
    expect(payload.userId).toBe('user-1')
  })

  it('viewer: a write-only client request is bounced with invalid_scope instead of a read grant it never asked for', async () => {
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', undefined, undefined, { role: 'viewer' }),
    )
    const response = await GET(
      new Request(buildAuthorizeUrl({ ...params, scope: 'transactions:write' })),
    )
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe('https://claude.ai')
    expect(location.searchParams.get('error')).toBe('invalid_scope')
    expect(location.searchParams.get('state')).toBe('xyz')
    expect(location.searchParams.get('code')).toBeNull()
  })

  it('member: POST keeps requested write and approve scopes', async () => {
    // Mirrors app/api/settings/api-keys: any writer role may hold approve;
    // the stage+approve combination is acknowledged, not blocked.
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', undefined, undefined, { role: 'member' }),
    )
    const response = await POST(
      new Request(buildAuthorizeUrl(params), {
        method: 'POST',
        body: consentForm('mcp', ['transactions:read', 'transactions:write', 'pending_operations:approve']),
      }),
    )
    expect(response.status).toBe(303)
    expect(lastMintedPayload().scopes).toEqual([
      'transactions:read',
      'transactions:write',
      'pending_operations:approve',
    ])
  })

  it('no membership row: caps to read scopes rather than trusting the form', async () => {
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', undefined, undefined, { role: null }),
    )
    const response = await POST(
      new Request(buildAuthorizeUrl(params), {
        method: 'POST',
        body: consentForm('mcp', ['reports:read', 'bookkeeping:write']),
      }),
    )
    expect(response.status).toBe(303)
    expect(lastMintedPayload().scopes).toEqual(['reports:read'])
  })

  it('GET fails closed with server_error when the role lookup errors', async () => {
    // A transient error must neither widen the grant (treat as owner) nor
    // silently downgrade a legitimate connection to read-only.
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', undefined, undefined, { error: 'boom' }),
    )
    const response = await GET(new Request(buildAuthorizeUrl(params)))
    expect(response.status).toBe(500)
    expect((await response.json()).error).toBe('server_error')
  })

  it('POST fails closed with server_error when the role lookup errors', async () => {
    mocks.createClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, 'Test AB', undefined, undefined, { error: 'boom' }),
    )
    const response = await POST(
      new Request(buildAuthorizeUrl(params), { method: 'POST', body: consentForm('mcp', ['reports:read']) }),
    )
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('server_error')
    expect(location.searchParams.get('code')).toBeNull()
    expect(mocks.createAuthCode).not.toHaveBeenCalled()
  })
})

describe('Gemini custom apps', () => {
  const params = {
    response_type: 'code',
    redirect_uri: 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1234567890-app_accounted_se',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
    scope: 'mcp offline_access',
    state: 'xyz',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1' }))
    mocks.resolveRedirectUri.mockResolvedValue(GEMINI)
    mocks.getActiveCompanyId.mockResolvedValue('company-1')
    mocks.getBranding.mockReturnValue({ appName: 'gnubok' })
  })

  it('names Gemini as a verified client and shows Google\'s relay as the redirect host', async () => {
    const html = await (await GET(new Request(buildAuthorizeUrl(params)))).text()

    expect(html).toContain('Gemini (Google)')
    expect(html).toContain('Verifierad')
    expect(html).toContain('oauth-redirect.googleusercontent.com')
  })

  it.each(['mcp offline_access', 'offline_access'])(
    'treats offline_access as a marker like mcp, so scope=%s offers the full set',
    async (scope) => {
      // Gemini adds offline_access to ask for a refresh token, which every
      // grant gets anyway. Refusing it as an unknown scope would end the
      // sign-in; reading it as a granular request would cap the consent.
      const response = await GET(new Request(buildAuthorizeUrl({ ...params, scope })))
      expect(response.status).toBe(200)
      const html = await response.text()

      expect(checkboxFor(html, 'transactions:write')).toContain('checked')
      expect(checkboxFor(html, 'pending_operations:approve')).not.toContain('checked')
      expect(checkboxFor(html, 'transactions:read')).toContain('checked')
    },
  )

  it('still refuses a request whose only non-marker scopes are unknown', async () => {
    const response = await GET(
      new Request(buildAuthorizeUrl({ ...params, scope: 'offline_access not:a-scope' })),
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('invalid_scope')
  })

  it('POST keeps the write scopes the user left ticked', async () => {
    const response = await POST(
      new Request(buildAuthorizeUrl(params), {
        method: 'POST',
        body: consentForm('mcp offline_access', ['transactions:read', 'transactions:write']),
      }),
    )
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe('https://oauth-redirect.googleusercontent.com')
    expect(location.searchParams.get('code')).toBe('test-auth-code')
    expect(lastMintedPayload().scopes).toEqual(['transactions:read', 'transactions:write'])
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
    mocks.resolveRedirectUri.mockResolvedValue(CLAUDE)
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

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    mocks.resolveRedirectUri.mockResolvedValue(CLAUDE)
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
    // No company to look up: neither company_settings nor company_members is queried.
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('pre-ticks every scope for a companyless account (one-click consent covers the create flow)', async () => {
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1', email: 'ny@example.se' }))

    const response = await GET(new Request(buildAuthorizeUrl(authorizeParams)))
    const html = await response.text()

    expect(checkboxFor(html, 'companies:write')).toContain('checked')
    expect(checkboxFor(html, 'transactions:write')).toContain('checked')
  })

  it('POST still issues an authorization code with no role cap and a null company', async () => {
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1', email: 'ny@example.se' }))

    const response = await POST(
      new Request(buildAuthorizeUrl(authorizeParams), {
        method: 'POST',
        body: consentForm('mcp', ['companies:write', 'companies:read']),
      }),
    )

    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location')!)
    expect(location.searchParams.get('code')).toBe('test-auth-code')
    expect(location.searchParams.get('state')).toBe('xyz')

    const payload = lastMintedPayload()
    expect(payload.companyId).toBeNull()
    expect(payload.scopes).toEqual(['companies:write', 'companies:read'])
  })
})

describe('company picker on consent (per-key company allowlist)', () => {
  const ACTIVE = '11111111-1111-4111-8111-111111111111'
  const OTHER = '22222222-2222-4222-8222-222222222222'
  const THIRD = '33333333-3333-4333-8333-333333333333'
  const FOREIGN = '99999999-9999-4999-8999-999999999999'
  const twoCompanies: PickerCompany[] = [
    { company_id: ACTIVE, name: 'Aktiva AB', role: 'owner' },
    { company_id: OTHER, name: 'Andra & Co', role: 'owner' },
  ]
  const threeCompanies: PickerCompany[] = [
    ...twoCompanies,
    { company_id: THIRD, name: 'Tredje AB', role: 'owner' },
  ]
  const params = {
    response_type: 'code',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
    scope: 'mcp',
    state: 'xyz',
  }

  /** One `company_access=<id>:<level>` field per entry, as the picker posts them. */
  function consentWithAccess(entries: Array<[string, 'write' | 'read' | 'none']>): FormData {
    const form = consentForm('mcp', ['reports:read'])
    for (const [id, level] of entries) form.append('company_access', `${id}:${level}`)
    return form
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1' }, 'Aktiva AB'))
    mocks.resolveRedirectUri.mockResolvedValue(CLAUDE)
    mocks.getActiveCompanyId.mockResolvedValue(ACTIVE)
    mocks.getBranding.mockReturnValue({ appName: 'gnubok' })
  })

  // One-shot overrides: vi.clearAllMocks() keeps the last implementation, so
  // a persistent mockResolvedValue here would leak into later describes.
  it('GET renders an access choice per company, preset to read and write, active first and tagged', async () => {
    mocks.listUserCompaniesForPicker.mockResolvedValueOnce([
      ...twoCompanies,
      { company_id: THIRD, name: 'Läsbolaget AB', role: 'viewer' },
    ])
    const response = await GET(new Request(buildAuthorizeUrl(params)))
    expect(response.status).toBe(200)
    const html = await response.text()

    for (const id of [ACTIVE, OTHER, THIRD]) {
      const select = html.match(
        new RegExp(`<select[^>]*name="company_access"[^>]*data-company="${id}"[^>]*>[\\s\\S]*?</select>`),
      )?.[0]
      expect(select).toBeDefined()
      expect(select).toContain(`<option value="${id}:write" selected>Läsa och skriva</option>`)
      expect(select).toContain(`<option value="${id}:read">Bara läsa</option>`)
      expect(select).toContain(`<option value="${id}:none">Ingen åtkomst</option>`)
    }
    // Active company listed first and marked; a viewer company is marked too.
    expect(html.indexOf(ACTIVE)).toBeLessThan(html.indexOf(OTHER))
    expect(html).toContain('(aktivt)')
    expect(html).toContain('(du är läsare)')
    expect(html).toContain('Alla: bara läsa')
    expect(html).toContain('Lämnar du alla på Läsa och skriva följer anslutningen även företag du blir medlem i senare.')
    // Names are escaped like everything else on the page.
    expect(html).toContain('Andra &amp; Co')
    expect(html).not.toContain('Andra & Co')
    // The listing was asked for with the active company first.
    expect(mocks.listUserCompaniesForPicker).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      { activeCompanyId: ACTIVE },
    )
  })

  it('GET renders no picker for a one-company user (unchanged UI)', async () => {
    const response = await GET(new Request(buildAuthorizeUrl(params)))
    expect(response.status).toBe(200)
    const html = await response.text()
    // No access selects (the inline script's selector string is always present).
    expect(html).not.toMatch(/<select[^>]*name="company_access"/)
    expect(html).not.toContain('(aktivt)')
    // The plain company fact row is still there.
    expect(html).toContain('Aktiva AB')
  })

  it('GET fails closed with server_error when the company listing errors', async () => {
    mocks.listUserCompaniesForPicker.mockRejectedValueOnce(new Error('boom'))
    const response = await GET(new Request(buildAuthorizeUrl(params)))
    expect(response.status).toBe(500)
    expect((await response.json()).error).toBe('server_error')
  })

  it('POST with every company at read and write carries companyIds null (unrestricted)', async () => {
    mocks.listUserCompaniesForPicker.mockResolvedValueOnce(twoCompanies)
    const response = await POST(
      new Request(buildAuthorizeUrl(params), {
        method: 'POST',
        body: consentWithAccess([[OTHER, 'write'], [ACTIVE, 'write']]),
      }),
    )
    expect(response.status).toBe(303)
    const payload = lastMintedPayload()
    expect(payload.companyIds).toBeNull()
    expect(payload.readOnlyCompanyIds).toBeNull()
    expect(payload.companyId).toBe(ACTIVE)
  })

  it('POST with a read-only company keeps every company as a list and carries the read-only one', async () => {
    mocks.listUserCompaniesForPicker.mockResolvedValueOnce(threeCompanies)
    const response = await POST(
      new Request(buildAuthorizeUrl(params), {
        method: 'POST',
        body: consentWithAccess([[ACTIVE, 'write'], [OTHER, 'read'], [THIRD, 'write']]),
      }),
    )
    expect(response.status).toBe(303)
    const payload = lastMintedPayload()
    expect(payload.companyIds).toEqual([ACTIVE, OTHER, THIRD])
    expect(payload.readOnlyCompanyIds).toEqual([OTHER])
    expect(payload.companyId).toBe(ACTIVE)
  })

  it('POST lets the most restrictive choice win when a company is posted twice', async () => {
    mocks.listUserCompaniesForPicker.mockResolvedValueOnce(twoCompanies)
    const response = await POST(
      new Request(buildAuthorizeUrl(params), {
        method: 'POST',
        body: consentWithAccess([[ACTIVE, 'write'], [OTHER, 'write'], [OTHER, 'read']]),
      }),
    )
    expect(response.status).toBe(303)
    const payload = lastMintedPayload()
    expect(payload.companyIds).toEqual([ACTIVE, OTHER])
    expect(payload.readOnlyCompanyIds).toEqual([OTHER])
  })

  it('POST with a strict subset carries companyIds and swaps the default when the active company is left out', async () => {
    mocks.listUserCompaniesForPicker.mockResolvedValueOnce(threeCompanies)
    const response = await POST(
      new Request(buildAuthorizeUrl(params), {
        method: 'POST',
        body: consentWithAccess([[ACTIVE, 'none'], [THIRD, 'write'], [OTHER, 'write']]),
      }),
    )
    expect(response.status).toBe(303)
    expect(new URL(response.headers.get('location')!).searchParams.get('code')).toBe('test-auth-code')
    const payload = lastMintedPayload()
    // Picker order, not submission order; the default is the first selected.
    expect(payload.companyIds).toEqual([OTHER, THIRD])
    expect(payload.readOnlyCompanyIds).toBeNull()
    expect(payload.companyId).toBe(OTHER)
  })

  it('POST keeps the active company as default when it is inside the subset, read-only or not', async () => {
    mocks.listUserCompaniesForPicker.mockResolvedValueOnce(threeCompanies)
    const response = await POST(
      new Request(buildAuthorizeUrl(params), {
        method: 'POST',
        body: consentWithAccess([[THIRD, 'write'], [ACTIVE, 'read'], [OTHER, 'none']]),
      }),
    )
    expect(response.status).toBe(303)
    const payload = lastMintedPayload()
    expect(payload.companyIds).toEqual([ACTIVE, THIRD])
    expect(payload.readOnlyCompanyIds).toEqual([ACTIVE])
    expect(payload.companyId).toBe(ACTIVE)
  })

  it('POST ignores an id outside the memberships instead of trusting the form', async () => {
    mocks.listUserCompaniesForPicker.mockResolvedValueOnce(twoCompanies)
    const form = consentWithAccess([[FOREIGN, 'write'], [ACTIVE, 'write'], [OTHER, 'none']])
    form.append('company_access', 'not-a-uuid:write')
    const response = await POST(new Request(buildAuthorizeUrl(params), { method: 'POST', body: form }))
    expect(response.status).toBe(303)
    const payload = lastMintedPayload()
    expect(payload.companyIds).toEqual([ACTIVE])
    expect(payload.companyId).toBe(ACTIVE)
  })

  it('POST with no company chosen answers 400 invalid_request and mints no code', async () => {
    mocks.listUserCompaniesForPicker.mockResolvedValueOnce(twoCompanies)
    const response = await POST(
      new Request(buildAuthorizeUrl(params), {
        method: 'POST',
        body: consentWithAccess([[ACTIVE, 'none'], [OTHER, 'none'], [FOREIGN, 'write']]),
      }),
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('invalid_request')
    expect(mocks.createAuthCode).not.toHaveBeenCalled()
  })

  it('POST for a one-company user ignores the access field and stays unrestricted', async () => {
    const response = await POST(
      new Request(buildAuthorizeUrl(params), {
        method: 'POST',
        body: consentWithAccess([[ACTIVE, 'read']]),
      }),
    )
    expect(response.status).toBe(303)
    const payload = lastMintedPayload()
    expect(payload.companyIds).toBeNull()
    expect(payload.readOnlyCompanyIds).toBeNull()
    expect(payload.companyId).toBe(ACTIVE)
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

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.test.example')
    mocks.createClient.mockResolvedValue(buildSupabase({ id: 'user-1' }))
    mocks.resolveRedirectUri.mockResolvedValue(CLAUDE)
    mocks.getActiveCompanyId.mockResolvedValue('company-1')
    mocks.getBranding.mockReturnValue({ appName: 'gnubok' })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('includes iss alongside code and state on the success redirect', async () => {
    const response = await POST(
      new Request(buildAuthorizeUrl(authorizeParams), { method: 'POST', body: consentForm('mcp') }),
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
