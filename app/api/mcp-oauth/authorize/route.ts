import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { createAuthCode } from '@/lib/auth/oauth-codes'
import { requireCompanyId } from '@/lib/company/context'
import { getBranding } from '@/lib/branding/service'
import { isAllowedRedirectUri } from '@/lib/auth/oauth-allowlist'
import {
  ALL_SCOPES,
  API_KEY_SCOPES,
  DEFAULT_OAUTH_SCOPES,
  SCOPE_GROUPS,
  validateScopes,
  type ApiKeyScope,
} from '@/lib/auth/api-keys'

/**
 * OAuth 2.0 Authorization Endpoint.
 *
 * GET  → show consent page (or redirect to login)
 * POST → process consent, create auth code, redirect to callback
 *
 * The API key is NOT created here: it's created in the token endpoint
 * after PKCE verification, preventing orphaned keys on abandoned flows.
 */

type ScopeParseResult =
  | { kind: 'ok'; scopes: ApiKeyScope[] | undefined }
  | { kind: 'invalid_scope'; description: string }

/**
 * Parse the OAuth `scope` query param (RFC 6749 §3.3, space-delimited list)
 * into the subset of API_KEY_SCOPES the client is asking for. Used to drive
 * pre-checked defaults on the consent UI; the user's actual grant comes from
 * their checkbox selection.
 *
 * Returns:
 *   - { ok, scopes: undefined } when no scope param was supplied: the consent
 *     UI pre-checks DEFAULT_OAUTH_SCOPES (read-only, GDPR Art. 25(2)).
 *   - { ok, scopes: [...] } when at least one valid scope was requested.
 *   - { invalid_scope } when a scope param was supplied but every value was
 *     unknown: refusing the request is safer than silently dropping it back
 *     to defaults the caller didn't ask for (V10.2.6).
 *
 * The bare `mcp` marker is treated as "no granular scopes" and accepted for
 * backwards compatibility with Claude's connector: it falls through to
 * `undefined` so the read-only defaults apply.
 */
function parseRequestedScopes(scopeParam: string | null): ScopeParseResult {
  if (!scopeParam) return { kind: 'ok', scopes: undefined }
  const requested = scopeParam.split(/\s+/).filter(Boolean)
  if (requested.length === 0) return { kind: 'ok', scopes: undefined }
  // The coarse-grained `mcp` marker is treated as "no granular request" so
  // we can keep Claude's existing flow working unchanged.
  const onlyMcp = requested.length === 1 && requested[0] === 'mcp'
  if (onlyMcp) return { kind: 'ok', scopes: undefined }
  const valid = requested.filter((s): s is ApiKeyScope => s in API_KEY_SCOPES)
  if (valid.length === 0) {
    return {
      kind: 'invalid_scope',
      description: 'none of the requested scopes are recognised',
    }
  }
  return { kind: 'ok', scopes: valid }
}

/**
 * Sign the scope payload so a tampered POST cannot widen the grant
 * displayed at GET. The HMAC binds the originally requested scope param to
 * the consent page that the user actually saw (V10.3.1).
 *
 * Derived from SUPABASE_SERVICE_ROLE_KEY: same root secret the auth-code
 * AEAD uses, so deploying the OAuth surface doesn't require a separate
 * signing key. Missing env vars cause /authorize to fail closed.
 */
function getScopeSigningKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for OAuth scope binding')
  return crypto.createHash('sha256').update(`oauth-scope:${secret}`).digest()
}

function signScopeBinding(scopeParam: string): string {
  return crypto.createHmac('sha256', getScopeSigningKey()).update(scopeParam).digest('base64url')
}

function verifyScopeBinding(scopeParam: string, signature: string): boolean {
  if (typeof signature !== 'string' || signature.length === 0) return false
  const expected = signScopeBinding(scopeParam)
  const expectedBuf = Buffer.from(expected, 'base64url')
  let presentedBuf: Buffer
  try {
    presentedBuf = Buffer.from(signature, 'base64url')
  } catch {
    return false
  }
  if (expectedBuf.length !== presentedBuf.length) return false
  return crypto.timingSafeEqual(expectedBuf, presentedBuf)
}

function buildLoginRedirect(request: Request): Response {
  const url = new URL(request.url)
  const next = `${url.pathname}${url.search}`
  return NextResponse.redirect(
    new URL(`/login?next=${encodeURIComponent(next)}`, url.origin)
  )
}

function errorRedirect(redirectUri: string, state: string | null, error: string, desc: string): Response {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  url.searchParams.set('error_description', desc)
  if (state) url.searchParams.set('state', state)
  return NextResponse.redirect(url.toString(), 303)
}

/**
 * GET /api/mcp-oauth/authorize: show consent page
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const redirectUri = url.searchParams.get('redirect_uri')
  // state and code_challenge are carried through to the POST handler via
  // the form action's url.search, so we don't read them here: they're only
  // validated on POST.
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256'
  const responseType = url.searchParams.get('response_type')
  const scopeParam = url.searchParams.get('scope')

  if (responseType !== 'code') {
    return NextResponse.json(
      { error: 'unsupported_response_type' },
      { status: 400 }
    )
  }

  if (!redirectUri) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is required' },
      { status: 400 }
    )
  }

  if (codeChallengeMethod !== 'S256') {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported' },
      { status: 400 }
    )
  }

  // Parse the requested scopes up front so the consent display reflects the
  // exact grant. Reject early if the client sent only unknown scopes (V10.2.6).
  const parsed = parseRequestedScopes(scopeParam)
  if (parsed.kind === 'invalid_scope') {
    return NextResponse.json(
      { error: 'invalid_scope', error_description: parsed.description },
      { status: 400 }
    )
  }

  // Check if user is logged in
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return buildLoginRedirect(request)
  }

  // Validate redirect_uri against allowlist (prevents open redirect). Passing
  // the authenticated client makes the trust boundary explicit (SOC 2 CC6.1).
  if (!(await isAllowedRedirectUri(redirectUri, supabase))) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is not allowed' },
      { status: 400 }
    )
  }

  const companyId = await requireCompanyId(supabase, user.id)

  // Get company name for the consent page
  const { data: settings } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .single()

  const companyName = settings?.company_name || user.email

  const appNameLower = escapeHtml(getBranding().appName.toLowerCase())

  // CSP nonce for the inline consent UI controls. A nonce-bound script-src
  // makes the inline block executable while keeping the rest of the page
  // immune to script injection: without this the consent page is
  // incompatible with a strict CSP and counts as unsafe-inline (ASVS V3.3,
  // SOC 2 CC6.1). The nonce is regenerated per response.
  const cspNonce = crypto.randomBytes(16).toString('base64')

  // Bind the requested scope to the consent display. The HMAC signature is
  // verified on POST so a tampered form submission cannot widen the grant
  // beyond what the user actually saw (V10.3.1).
  const scopeBindingValue = scopeParam ?? ''
  const scopeBindingSignature = signScopeBinding(scopeBindingValue)

  // Two-level model for the consent UI:
  //
  //   - Client requested specific scopes → ceiling = that set, pre-checked =
  //     that set (RFC 6749 §3.3 strict least-privilege).
  //   - Client passed no scope (or only the legacy `mcp` marker, Claude's
  //     connector today) → ceiling = ALL_SCOPES so every read/write row
  //     renders; pre-checked = DEFAULT_OAUTH_SCOPES so only the read rows
  //     start ticked. The user has to actively tick :write to widen the
  //     grant. This preserves GDPR Art. 25(2) (defaults are minimal /
  //     read-only) while still letting the resource owner authorise write
  //     scopes per RFC 6749 §3.3 ("based on … the resource owner's
  //     instructions"), which is the whole point of the consent step.
  const grantCeiling = new Set<ApiKeyScope>(parsed.scopes ?? ALL_SCOPES)
  const preChecked = new Set<ApiKeyScope>(parsed.scopes ?? DEFAULT_OAUTH_SCOPES)
  const scopeCheckboxesHtml = renderScopeCheckboxes(preChecked, grantCeiling)

  // Render consent page
  const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="translate" content="no">
  <meta name="color-scheme" content="light">
  <title>Anslut MCP-klient: ${appNameLower}</title>
  <style>
    :root {
      --bg: hsl(0 0% 100%);
      --surface: hsl(0 0% 100%);
      --secondary: hsl(40 11% 89%);
      --secondary-hover: hsl(40 11% 84%);
      --muted: hsl(40 8% 93%);
      --border: hsl(45 5% 85%);
      --border-strong: hsl(45 5% 72%);
      --fg: hsl(0 0% 9%);
      --fg-muted: hsl(0 0% 40%);
      --fg-faint: hsl(0 0% 55%);
      --primary: hsl(0 0% 9%);
      --primary-hover: hsl(0 0% 20%);
      --warning: hsl(38 55% 50%);
      --warning-bg: hsl(38 60% 96%);
      --warning-border: hsl(38 45% 82%);
      --warning-fg: hsl(28 60% 28%);
      --warm-accent: hsl(38 45% 52%);
      --ring: hsl(0 0% 9%);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      font-family: 'Geist', -apple-system, system-ui, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--fg);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      min-height: 100vh;
      padding: 4rem 1.5rem 3rem;
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2.5rem;
      max-width: 960px;
      width: 100%;
    }
    .scope-groups {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      column-gap: 1.5rem;
      row-gap: 0;
      align-items: start;
    }
    @media (max-width: 720px) {
      .card { padding: 1.5rem; }
      .scope-groups { grid-template-columns: 1fr; column-gap: 0; }
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.6875rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--fg-faint);
      margin-bottom: 0.875rem;
    }
    .eyebrow::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--warm-accent);
    }
    h1 {
      font-family: 'Hedvig Letters Serif', Georgia, 'Times New Roman', serif;
      font-size: 2rem;
      font-weight: 400;
      letter-spacing: -0.018em;
      line-height: 1.1;
      color: var(--fg);
      margin-bottom: 0.625rem;
    }
    .lede {
      font-size: 0.875rem;
      color: var(--fg-muted);
      line-height: 1.55;
      margin-bottom: 1.5rem;
    }
    .account {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      background: var(--muted);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.75rem 0.875rem;
      margin-bottom: 1.75rem;
    }
    .account-label {
      font-size: 0.6875rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--fg-faint);
    }
    .account-name {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--fg);
      text-align: right;
      word-break: break-word;
    }
    .scopes-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 0.625rem;
      margin-bottom: 0.25rem;
      border-bottom: 1px solid var(--border);
    }
    .scopes-title {
      font-size: 0.6875rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--fg-muted);
    }
    .scopes-controls {
      display: flex;
      gap: 0.25rem;
    }
    .scopes-controls button {
      padding: 0.3125rem 0.625rem;
      font-family: inherit;
      font-size: 0.6875rem;
      font-weight: 500;
      color: var(--fg-muted);
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      transition: background 150ms, color 150ms, border-color 150ms;
    }
    .scopes-controls button:hover {
      background: var(--secondary);
      color: var(--fg);
      border-color: var(--border-strong);
    }
    .scopes-controls button:focus-visible {
      outline: 2px solid var(--ring);
      outline-offset: 2px;
    }
    .scope-group {
      padding: 0.375rem 0 0.75rem;
    }
    .scope-group-title {
      font-size: 0.6875rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--fg-faint);
      padding: 0.625rem 0 0.25rem;
    }
    .scope-row {
      display: flex;
      gap: 0.75rem;
      padding: 0.5rem;
      margin: 0 -0.5rem;
      align-items: flex-start;
      border-radius: 6px;
      transition: background 150ms;
    }
    .scope-row:hover { background: var(--secondary); }
    .scope-row input[type="checkbox"] {
      margin-top: 0.1875rem;
      width: 15px;
      height: 15px;
      accent-color: var(--primary);
      cursor: pointer;
      flex-shrink: 0;
    }
    .scope-row input[type="checkbox"]:focus-visible {
      outline: 2px solid var(--ring);
      outline-offset: 2px;
      border-radius: 2px;
    }
    .scope-row label {
      flex: 1;
      cursor: pointer;
      line-height: 1.45;
    }
    .scope-name-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .scope-name {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--fg);
    }
    .scope-desc {
      display: block;
      margin-top: 0.1875rem;
      font-size: 0.75rem;
      color: var(--fg-muted);
      line-height: 1.5;
    }
    .scope-tag {
      font-size: 0.625rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 0.0625rem 0.375rem;
      border-radius: 4px;
      background: hsl(38 60% 92%);
      color: hsl(28 65% 30%);
      border: 1px solid hsl(38 45% 78%);
    }
    .warn {
      display: flex;
      gap: 0.625rem;
      font-size: 0.75rem;
      color: var(--warning-fg);
      background: var(--warning-bg);
      border: 1px solid var(--warning-border);
      border-radius: 8px;
      padding: 0.75rem 0.875rem;
      margin: 1.5rem 0 0;
      line-height: 1.55;
    }
    .warn-icon {
      flex-shrink: 0;
      width: 14px;
      height: 14px;
      margin-top: 0.125rem;
      color: var(--warning);
    }
    .actions {
      display: flex;
      gap: 0.5rem;
      margin-top: 1.75rem;
    }
    .actions button {
      flex: 1;
      padding: 0.6875rem 1rem;
      font-family: inherit;
      font-size: 0.8125rem;
      font-weight: 500;
      border-radius: 8px;
      cursor: pointer;
      border: 1px solid;
      transition: background 150ms, border-color 150ms, color 150ms;
    }
    .actions button:focus-visible {
      outline: 2px solid var(--ring);
      outline-offset: 2px;
    }
    .allow {
      background: var(--primary);
      color: hsl(0 0% 100%);
      border-color: var(--primary);
    }
    .allow:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
    .deny {
      background: var(--surface);
      color: var(--fg);
      border-color: var(--border-strong);
    }
    .deny:hover { background: var(--secondary); }
    .footer {
      margin-top: 1.25rem;
      font-size: 0.6875rem;
      color: var(--fg-faint);
      text-align: center;
      line-height: 1.5;
    }
    @media (max-width: 480px) {
      body { padding: 1.5rem 1rem 2rem; }
      .card { padding: 1.5rem; border-radius: 10px; }
      h1 { font-size: 1.625rem; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition: none !important; }
    }
  </style>
</head>
<body>
  <main class="card" role="main">
    <div class="eyebrow">${appNameLower} · mcp</div>
    <h1>Anslut MCP-klient</h1>
    <p class="lede">En extern applikation begär åtkomst till ditt ${appNameLower}-konto. Välj vilka behörigheter du vill bevilja.</p>

    <div class="account">
      <span class="account-label">Företag</span>
      <span class="account-name">${escapeHtml(companyName)}</span>
    </div>

    <form method="POST" action="${url.pathname}${url.search}" id="consent-form">
      <input type="hidden" name="scope_binding" value="${escapeHtml(scopeBindingValue)}">
      <input type="hidden" name="scope_binding_sig" value="${escapeHtml(scopeBindingSignature)}">

      <div class="scopes-header">
        <span class="scopes-title">Behörigheter</span>
        <div class="scopes-controls">
          <button type="button" id="select-read">Endast läs</button>
          <button type="button" id="select-all">Alla</button>
          <button type="button" id="select-none">Inga</button>
        </div>
      </div>

      <div class="scope-groups">${scopeCheckboxesHtml}</div>

      <div class="warn">
        <svg class="warn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5"/>
          <path d="M8 5v3.5" stroke-linecap="round"/>
          <circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none"/>
        </svg>
        <span>Skrivbehörigheter låter agenten stagea verifikationer, fakturor och löner. Varje skrivoperation kräver ditt godkännande i ${appNameLower} innan den skrivs till databasen.</span>
      </div>

      <div class="actions">
        <button type="submit" name="consent" value="deny" class="deny">Neka</button>
        <button type="submit" name="consent" value="allow" class="allow">Tillåt åtkomst</button>
      </div>
    </form>

    <p class="footer">Du kan när som helst återkalla åtkomsten under Inställningar &rsaquo; API-nycklar.</p>
  </main>

  <script nonce="${cspNonce}">
    (function() {
      var form = document.getElementById('consent-form');
      var boxes = form.querySelectorAll('input[name="scopes"]');
      function setAll(predicate) {
        boxes.forEach(function(b) { b.checked = predicate(b); });
      }
      document.getElementById('select-read').addEventListener('click', function() {
        setAll(function(b) { return b.dataset.kind === 'read'; });
      });
      document.getElementById('select-all').addEventListener('click', function() {
        setAll(function() { return true; });
      });
      document.getElementById('select-none').addEventListener('click', function() {
        setAll(function() { return false; });
      });
    })();
  </script>
</body>
</html>`

  // script-src bound to the per-request nonce ensures the consent page's
  // inline JS can only be the block we actually emitted. Anything injected
  // by a forged response or persisted XSS would be blocked.
  //
  // form-action must include the redirect_uri origin: the POST handler
  // returns a 303 to the OAuth client's callback (e.g. claude.ai), and CSP
  // form-action re-checks every hop in the redirect chain. With only 'self'
  // the browser would block the post-consent redirect. The origin is safe
  // to whitelist here because isAllowedRedirectUri() already gated it above.
  const redirectOrigin = new URL(redirectUri).origin
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${cspNonce}'`,
    "style-src 'unsafe-inline'",
    `form-action 'self' ${redirectOrigin}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

/**
 * POST /api/mcp-oauth/authorize: process consent, issue auth code
 */
export async function POST(request: Request) {
  const url = new URL(request.url)
  const redirectUri = url.searchParams.get('redirect_uri')
  const state = url.searchParams.get('state')
  const codeChallenge = url.searchParams.get('code_challenge') || ''
  const querystringScopeParam = url.searchParams.get('scope')

  if (!redirectUri) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  // Check auth
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return buildLoginRedirect(request)
  }

  // Pass the authenticated client so the lookup is bound to the same session
  // that the consent display ran under (SOC 2 CC6.1).
  if (!(await isAllowedRedirectUri(redirectUri, supabase))) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is not allowed' },
      { status: 400 }
    )
  }

  await requireCompanyId(supabase, user.id)

  // Parse form body
  const formData = await request.formData()
  const consent = formData.get('consent')

  if (consent !== 'allow') {
    return errorRedirect(redirectUri, state, 'access_denied', 'User denied the request')
  }

  // Verify the scope binding signed at consent display matches what was
  // submitted with the form. This pins the form to the GET that minted it,
  // so an attacker who tricks the user into submitting a crafted form can't
  // change the client's `scope=` querystring midway through the flow
  // (V10.3.1). The granted scopes themselves come from the user's checkbox
  // selection and are bounded server-side by API_KEY_SCOPES.
  const presentedScopeBinding = formData.get('scope_binding')
  const presentedScopeBindingSig = formData.get('scope_binding_sig')
  const presentedScopeStr = typeof presentedScopeBinding === 'string' ? presentedScopeBinding : ''
  const presentedSigStr = typeof presentedScopeBindingSig === 'string' ? presentedScopeBindingSig : ''
  const expectedScopeStr = querystringScopeParam ?? ''
  if (
    presentedScopeStr !== expectedScopeStr ||
    !verifyScopeBinding(presentedScopeStr, presentedSigStr)
  ) {
    return errorRedirect(
      redirectUri,
      state,
      'invalid_request',
      'Scope binding mismatch: consent token is invalid or has been tampered with'
    )
  }

  // Validate the client's original scope request (rejects an entirely-unknown
  // scope set, V10.2.6). The actual grant comes from the user's checkbox
  // selection below, not from this querystring.
  const parsed = parseRequestedScopes(querystringScopeParam)
  if (parsed.kind === 'invalid_scope') {
    return errorRedirect(redirectUri, state, 'invalid_scope', parsed.description)
  }

  // The user selects scopes via checkboxes on the consent page. Two upper
  // bounds apply server-side, regardless of what the form posts:
  //
  //   1. validateScopes drops any value that isn't in API_KEY_SCOPES: guards
  //      against forged values from a tampered POST.
  //   2. The grant must be a subset of the ceiling derived from the client's
  //      original request:
  //        • If the client requested specific scopes, the ceiling = that set
  //          (RFC 6749 §3.3 strict). A client that asked for only read scopes
  //          can never end up with write grants, even if the user tampered
  //          with the form (least-privilege, SOC 2 CC6.3, NIST AC-6).
  //        • If the client passed no scope (or only the `mcp` marker), the
  //          ceiling = ALL_SCOPES. The resource owner has full discretion at
  //          consent time, which RFC 6749 §3.3 permits ("based on … the
  //          resource owner's instructions"). The silent fallback when the
  //          user selects nothing remains DEFAULT_OAUTH_SCOPES (read-only),
  //          preserving GDPR Art. 25(2) data-protection-by-default.
  const submittedScopes = formData.getAll('scopes').filter((s): s is string => typeof s === 'string')
  const validated = validateScopes(submittedScopes)
  const clientCeiling: ApiKeyScope[] = parsed.scopes ?? [...ALL_SCOPES]
  const ceilingSet = new Set<ApiKeyScope>(clientCeiling)
  const boundedToClient = (validated ?? []).filter(s => ceilingSet.has(s))
  const grantedScopes: ApiKeyScope[] = boundedToClient.length > 0
    ? boundedToClient
    : [...DEFAULT_OAUTH_SCOPES].filter(s => ceilingSet.has(s))

  // Create auth code with userId (NO API key: that's created at /token after PKCE)
  const code = createAuthCode({
    userId: user.id,
    codeChallenge,
    redirectUri,
    scopes: grantedScopes,
  })

  // Redirect to callback with the code
  const callbackUrl = new URL(redirectUri)
  callbackUrl.searchParams.set('code', code)
  if (state) callbackUrl.searchParams.set('state', state)

  // 303 See Other: forces browser to GET the callback URL, even though this
  // handler was reached via POST. NextResponse.redirect() defaults to 307,
  // which preserves POST and causes Claude's callback to return 405.
  return NextResponse.redirect(callbackUrl.toString(), 303)
}

/**
 * Render the scope checkbox UI grouped by domain. Only scopes in `ceiling`
 * are surfaced: scopes outside the ceiling are dropped from the consent UI
 * so the user can't tick boxes that the POST handler would refuse anyway.
 * The ceiling is either the client's `scope` querystring (when specified)
 * or DEFAULT_OAUTH_SCOPES (when the client passed no scope), matching the
 * server-side enforcement in the POST handler.
 */
function renderScopeCheckboxes(
  preChecked: Set<ApiKeyScope>,
  ceiling: Set<ApiKeyScope>,
): string {
  const renderedInGroups = new Set<ApiKeyScope>()
  const groups: string[] = []

  for (const group of SCOPE_GROUPS) {
    const rows: string[] = []
    if (group.read && ceiling.has(group.read)) {
      rows.push(scopeRow(group.read, preChecked.has(group.read), 'read'))
      renderedInGroups.add(group.read)
    }
    if (group.write && ceiling.has(group.write)) {
      rows.push(scopeRow(group.write, preChecked.has(group.write), 'write'))
      renderedInGroups.add(group.write)
    }
    if (rows.length > 0) {
      groups.push(
        `<div class="scope-group"><div class="scope-group-title">${escapeHtml(group.label)}</div>${rows.join('')}</div>`
      )
    }
  }

  const remaining = ALL_SCOPES.filter(s => ceiling.has(s) && !renderedInGroups.has(s))
  if (remaining.length > 0) {
    const rows = remaining.map((s) =>
      scopeRow(s, preChecked.has(s), s.endsWith(':write') || s.endsWith(':manage') || s.endsWith(':approve') ? 'write' : 'read')
    )
    groups.push(
      `<div class="scope-group"><div class="scope-group-title">Övriga</div>${rows.join('')}</div>`
    )
  }

  return groups.join('')
}

function scopeRow(scope: ApiKeyScope, checked: boolean, kind: 'read' | 'write'): string {
  const meta = API_KEY_SCOPES[scope]
  const id = `scope-${scope.replace(/[^a-z0-9]/gi, '-')}`
  // Labels are formatted "Område: verb" (läs/skriv/hantera/godkänn). Pull the
  // prefix as the display name and only render the verb as a tag for elevated
  // scopes: read-only is the implicit default and doesn't need a tag.
  const [namePart, verbPart] = meta.label.split(': ')
  const displayName = namePart ?? meta.label
  const tagHtml = verbPart && kind === 'write'
    ? `<span class="scope-tag">${escapeHtml(verbPart)}</span>`
    : ''
  return `
    <div class="scope-row ${kind}">
      <input type="checkbox" id="${id}" name="scopes" value="${escapeHtml(scope)}" data-kind="${kind}" ${checked ? 'checked' : ''}>
      <label for="${id}">
        <span class="scope-name-row">
          <span class="scope-name">${escapeHtml(displayName)}</span>
          ${tagHtml}
        </span>
        <span class="scope-desc">${escapeHtml(meta.description)}</span>
      </label>
    </div>
  `
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
