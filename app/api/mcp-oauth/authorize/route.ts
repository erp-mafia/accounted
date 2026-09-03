import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createAuthCode } from '@/lib/auth/oauth-codes'
import { shouldEnforceMfa } from '@/lib/auth/mfa'
import { getActiveCompanyId } from '@/lib/company/context'
import { getBranding } from '@/lib/branding/service'
import {
  capScopesForRole,
  lookupCompanyRole,
  resolveRedirectUri,
  type RedirectUriResolution,
} from '@/lib/auth/oauth-allowlist'
import { resolveDiscoveryBaseUrl } from '@/lib/api/v1/base-url'
import {
  ALL_SCOPES,
  API_KEY_SCOPES,
  DEFAULT_OAUTH_SCOPES,
  SCOPE_GROUPS,
  findStageApproveConflict,
  scopeKind,
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
 *     UI pre-checks ALL_SCOPES (one-click consent; every write is staged for
 *     approval, and the empty-selection POST fallback stays read-only).
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

/**
 * Consent here mints a long-lived API key at /token, and that key bypasses
 * MFA on every subsequent call: so the consent session itself must be AAL2.
 * The middleware MFA gate deliberately exempts /api/mcp-oauth/* (the token
 * endpoint is Bearer-only), which makes this route responsible for its own
 * step-up. Returns null when the session is AAL2 (or MFA isn't required),
 * otherwise a redirect to /mfa/verify (factor enrolled, session still AAL1)
 * or /mfa/enroll (no factor at all) that returns to this authorize URL.
 *
 * The enrollment leg matters for accounts created inside the OAuth popup
 * (issue #1814): the middleware only forces enrollment once a company exists,
 * so a brand-new password account would otherwise consent at AAL1 and mint an
 * MFA-exempt key for an account with no second factor. BankID-linked accounts
 * are exempt via shouldEnforceMfa, same as everywhere else.
 */
async function requireAal2(
  supabase: SupabaseClient,
  user: User,
  request: Request,
): Promise<Response | null> {
  if (!shouldEnforceMfa(user)) return null
  const url = new URL(request.url)
  const returnTo = `${url.pathname}${url.search}`
  const stepUp = (page: '/mfa/verify' | '/mfa/enroll') =>
    NextResponse.redirect(new URL(`${page}?returnTo=${encodeURIComponent(returnTo)}`, url.origin))

  // Only a positive "this session is AAL2" answer lets consent through. A
  // failed or empty assurance lookup is treated as AAL1 (verify page), never
  // as "no MFA needed": the alternative would mint an MFA-exempt key on a
  // transient auth error.
  const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (aalError || !aal) return stepUp('/mfa/verify')
  if (aal.currentLevel === 'aal2') return null
  if (aal.nextLevel === 'aal2') return stepUp('/mfa/verify')

  // nextLevel below aal2 should mean no verified factor exists. If one does
  // exist anyway (inconsistent answer), step up rather than enroll a second
  // factor. Otherwise enroll: mirrors the middleware gate (lib/supabase/
  // middleware.ts), which skips zero-company users and so never ran for an
  // account created inside the popup.
  const { data: factors } = await supabase.auth.mfa.listFactors()
  const hasVerifiedFactor = factors?.totp?.some((f) => f.status === 'verified') ?? false
  return stepUp(hasVerifiedFactor ? '/mfa/verify' : '/mfa/enroll')
}

function errorRedirect(request: Request, redirectUri: string, state: string | null, error: string, desc: string): Response {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  url.searchParams.set('error_description', desc)
  if (state) url.searchParams.set('state', state)
  // RFC 9207: identify the issuer in every authorization response so clients
  // can detect mix-up attacks. Must equal the issuer that discovery
  // advertised for the host the client connected through.
  url.searchParams.set('iss', resolveDiscoveryBaseUrl(request))
  return NextResponse.redirect(url.toString(), 303)
}

/**
 * GET /api/mcp-oauth/authorize: show consent page
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const redirectUri = url.searchParams.get('redirect_uri')
  // state is read only to echo it on error redirects issued from GET;
  // code_challenge is carried through to the POST handler via the form
  // action's url.search and validated there.
  const state = url.searchParams.get('state')
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

  const mfaRedirect = await requireAal2(supabase, user, request)
  if (mfaRedirect) return mfaRedirect

  // Validate redirect_uri against the allowlist (prevents open redirect) and
  // resolve who the client is. DB-registered URIs are bound to the consenting
  // user: only their own or a colleague's registration counts, so a stranger
  // cannot register a callback and phish consent from every account on the
  // instance (SOC 2 CC6.1).
  const resolution = await resolveRedirectUri(redirectUri, undefined, { consentingUserId: user.id })
  if (!resolution.allowed) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is not allowed' },
      { status: 400 }
    )
  }

  // null for an account with no company yet (signed up from the OAuth popup,
  // issue #1814): consent still goes through, the key is minted unbound and
  // binds itself once the company exists. The page says so instead of
  // showing a company name.
  const companyId = await getActiveCompanyId(supabase, user.id)

  let companyName: string | null = null
  let role: string | null = null
  if (companyId) {
    const { data: settings } = await supabase
      .from('company_settings')
      .select('company_name')
      .eq('company_id', companyId)
      .single()
    companyName = settings?.company_name || user.email || null

    // The user's role in the company shown on this page caps what the page
    // may offer (viewer = read-only). A failed lookup is a hard stop, not a
    // silent downgrade or widening.
    const lookup = await lookupCompanyRole(supabase, user.id, companyId)
    if (lookup.error) {
      return NextResponse.json(
        { error: 'server_error', error_description: 'Could not resolve your role in the company' },
        { status: 500 }
      )
    }
    role = lookup.role
  }

  const appNameLower = escapeHtml(getBranding().appName.toLowerCase())

  // Client identity and the host the browser will be sent to after consent.
  // Both are shown unconditionally so a look-alike registration cannot pass
  // for Claude and the user always sees where the code is going.
  const client = describeClient(resolution)
  const redirectHost = new URL(redirectUri).host
  const clientRowsHtml = `<div class="fact">
        <span class="fact-label">Klient</span>
        <span class="fact-value">${escapeHtml(client.name)} <span class="fact-tag${client.verified ? ' verified' : ''}">${escapeHtml(client.tag)}</span></span>
      </div>
      <div class="fact">
        <span class="fact-label">Skickar dig vidare till</span>
        <span class="fact-value fact-host">${escapeHtml(redirectHost)}</span>
      </div>`

  const accountRowHtml = companyName
    ? `<span class="fact-label">Företag</span>
        <span class="fact-value">${escapeHtml(companyName)}</span>`
    : `<span class="fact-label">Konto</span>
        <span class="fact-value">${escapeHtml(user.email ?? '')}</span>`
  const noCompanyNoteHtml = companyId
    ? ''
    : `<p class="note">Du har inget företag i ${appNameLower} ännu. Du kan ansluta ändå: skapa företaget i appen så använder anslutningen det automatiskt, utan att du behöver ansluta på nytt.</p>`

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

  // Three inputs shape the consent UI:
  //
  //   - Ceiling: the client's requested scopes (RFC 6749 §3.3 strict
  //     least-privilege), or ALL_SCOPES when it passed none (or only the
  //     legacy `mcp` marker, Claude's connector today), then capped to what
  //     the user's role in the selected company permits (viewer = read-only).
  //     Rows outside the ceiling are not rendered; the POST handler enforces
  //     the same bound server-side.
  //   - Pre-checked, built-in client (Claude, ChatGPT, localhost): the whole
  //     ceiling. One-click consent (founder decision 2026-08-26; the read-only
  //     default killed the agent flow with an insufficient-scope dead-end
  //     mid-chat). The mitigations that make full-by-default defensible: every
  //     write is STAGED for explicit approval before anything touches the
  //     ledger, the full scope list stays on the page (collapsed but
  //     expandable) with every row untickable, the warn line states the
  //     staging rule above the button, and the grant is revocable under
  //     Inställningar › API-nycklar. RFC 6749 §3.3 lets the resource owner
  //     authorise the set presented; the consent is the click on a page that
  //     shows exactly that set.
  //   - Pre-checked, DB-registered client: only what it explicitly asked for,
  //     or the :read scopes when it asked for nothing. Write and approve
  //     scopes stay unticked until the user opts in: a registration is just a
  //     URL some member typed into settings, not a vetted integration.
  const clientCeiling: ApiKeyScope[] = parsed.scopes ?? [...ALL_SCOPES]
  const roleCapped = companyId ? capScopesForRole(clientCeiling, role) : clientCeiling
  if (roleCapped.length === 0) {
    return errorRedirect(
      request,
      redirectUri,
      state,
      'invalid_scope',
      'None of the requested scopes are available to your role in this company'
    )
  }
  const roleLimited = roleCapped.length < clientCeiling.length
  const grantCeiling = new Set<ApiKeyScope>(roleCapped)
  const preChecked = new Set<ApiKeyScope>(
    resolution.kind === 'built_in' || parsed.scopes
      ? roleCapped
      : roleCapped.filter((s) => scopeKind(s) === 'read')
  )
  const allPreChecked = preChecked.size === grantCeiling.size
  const ceilingHasWrite = roleCapped.some((s) => scopeKind(s) === 'write')
  const scopeCheckboxesHtml = renderScopeCheckboxes(preChecked, grantCeiling)

  const ledeHtml = !ceilingHasWrite
    ? `${escapeHtml(client.name)} begär läsåtkomst till ditt ${appNameLower}-konto. Inga skrivbehörigheter ingår.`
    : allPreChecked
      ? `${escapeHtml(client.name)} begär åtkomst till ditt ${appNameLower}-konto. Alla behörigheter är förvalda; varje skrivning kräver ändå ditt godkännande innan den bokförs.`
      : `${escapeHtml(client.name)} begär åtkomst till ditt ${appNameLower}-konto. Endast läsbehörigheter är förvalda: skrivbehörigheter måste du själv välja nedan, och varje skrivning kräver ändå ditt godkännande innan den bokförs.`
  const roleNoteHtml = roleLimited
    ? `<p class="note">Din roll i företaget är läsare, så bara läsbehörigheter kan ges här.</p>`
    : ''
  const summaryHintHtml = allPreChecked
    ? 'Alla förvalda &middot; visa och justera'
    : 'Endast läs förvalt &middot; visa och justera'
  // Segregation of duties: a key that can both stage and approve lets the
  // agent commit bookkeeping without a human review in the app. Mirrors
  // app/api/settings/api-keys, where the same combination needs an explicit
  // acknowledgement: here the statement sits above the button and the token
  // route records the consent click as that acknowledgement.
  const sodNoteHtml = findStageApproveConflict(roleCapped)
    ? ` Ger du både skriv- och godkännandebehörighet kan klienten både förbereda och godkänna bokföring utan din granskning i ${appNameLower}; ditt godkännande här registreras som ett medgivande till det.`
    : ''

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
    .facts {
      background: var(--muted);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0 0.875rem;
      margin-bottom: 1.75rem;
    }
    .fact {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.625rem 0;
    }
    .fact + .fact { border-top: 1px solid var(--border); }
    .fact-label {
      font-size: 0.6875rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--fg-faint);
      flex-shrink: 0;
    }
    .fact-value {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--fg);
      text-align: right;
      word-break: break-word;
    }
    .fact-host {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.8125rem;
    }
    .fact-tag {
      display: inline-block;
      margin-left: 0.375rem;
      font-size: 0.625rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 0.0625rem 0.375rem;
      border-radius: 4px;
      background: var(--secondary);
      color: var(--fg-muted);
      border: 1px solid var(--border-strong);
      vertical-align: middle;
    }
    .fact-tag.verified {
      background: hsl(140 40% 94%);
      color: hsl(150 45% 24%);
      border-color: hsl(140 35% 78%);
    }
    .note {
      font-size: 0.8125rem;
      color: var(--fg-muted);
      line-height: 1.55;
      margin: -1rem 0 1.75rem;
    }
    .scopes-details {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0 0.875rem;
      background: var(--surface);
    }
    .scopes-details summary {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 0;
      cursor: pointer;
      list-style: none;
      user-select: none;
    }
    .scopes-details summary::-webkit-details-marker { display: none; }
    .scopes-details summary:focus-visible {
      outline: 2px solid var(--ring);
      outline-offset: 2px;
      border-radius: 6px;
    }
    .scopes-summary-hint {
      flex: 1;
      text-align: right;
      font-size: 0.75rem;
      color: var(--fg-faint);
    }
    .scopes-chevron {
      width: 14px;
      height: 14px;
      color: var(--fg-faint);
      transition: transform 150ms;
      flex-shrink: 0;
    }
    .scopes-details[open] .scopes-chevron { transform: rotate(90deg); }
    .scopes-details[open] summary { border-bottom: 1px solid var(--border); }
    .scopes-details .scope-groups { padding-bottom: 0.5rem; }
    .scopes-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.625rem 0;
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
    <p class="lede">${ledeHtml}</p>

    <div class="facts">
      ${clientRowsHtml}
      <div class="fact">
        ${accountRowHtml}
      </div>
    </div>
    ${noCompanyNoteHtml}
    ${roleNoteHtml}

    <form method="POST" action="${escapeHtml(url.pathname + url.search)}" id="consent-form">
      <input type="hidden" name="scope_binding" value="${escapeHtml(scopeBindingValue)}">
      <input type="hidden" name="scope_binding_sig" value="${escapeHtml(scopeBindingSignature)}">

      <details class="scopes-details">
        <summary>
          <span class="scopes-title">Behörigheter</span>
          <span class="scopes-summary-hint">${summaryHintHtml}</span>
          <svg class="scopes-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </summary>
        <div class="scopes-header">
          <span class="scopes-title">Justera</span>
          <div class="scopes-controls">
            <button type="button" id="select-read">Endast läs</button>
            <button type="button" id="select-all">Alla</button>
            <button type="button" id="select-none">Inga</button>
          </div>
        </div>
        <div class="scope-groups">${scopeCheckboxesHtml}</div>
      </details>

      <div class="warn">
        <svg class="warn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5"/>
          <path d="M8 5v3.5" stroke-linecap="round"/>
          <circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none"/>
        </svg>
        <span>Skrivbehörigheter låter agenten stagea verifikationer, fakturor och löner. Varje skrivoperation kräver ditt godkännande i ${appNameLower} innan den skrivs till databasen.${sodNoteHtml}</span>
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
  // to whitelist here because resolveRedirectUri() already gated it above.
  //
  // A custom-scheme callback (cursor://...) has the opaque origin "null",
  // which CSP would read as a host literally named "null" and match nothing,
  // so the post-consent 303 would be blocked in Chromium. A scheme-source
  // (cursor:) is the only form CSP offers for such a URI.
  const redirectUrl = new URL(redirectUri)
  const formActionSource = redirectUrl.origin === 'null' ? redirectUrl.protocol : redirectUrl.origin
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${cspNonce}'`,
    "style-src 'unsafe-inline'",
    `form-action 'self' ${formActionSource}`,
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

  // An AAL1 session must not be able to approve consent (the GET step-up can
  // be bypassed by POSTing the form directly). The redirect lands back on the
  // GET consent page after verification.
  const mfaRedirect = await requireAal2(supabase, user, request)
  if (mfaRedirect) return mfaRedirect

  // Same binding as GET: a DB-registered URI must be the consenting user's own
  // or a colleague's registration (SOC 2 CC6.1).
  const resolution = await resolveRedirectUri(redirectUri, undefined, { consentingUserId: user.id })
  if (!resolution.allowed) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is not allowed' },
      { status: 400 }
    )
  }

  // Parse form body
  const formData = await request.formData()
  const consent = formData.get('consent')

  if (consent !== 'allow') {
    return errorRedirect(request, redirectUri, state, 'access_denied', 'User denied the request')
  }

  // The company the consent page showed and the user's role in it. Null for
  // an account without a company (issue #1814): consent still goes through
  // uncapped and the token endpoint mints the key unbound. The role caps the
  // grant below and is re-checked at /token against the same company, which
  // travels in the code payload.
  const companyId = await getActiveCompanyId(supabase, user.id)
  let role: string | null = null
  if (companyId) {
    const lookup = await lookupCompanyRole(supabase, user.id, companyId)
    if (lookup.error) {
      return errorRedirect(
        request,
        redirectUri,
        state,
        'server_error',
        'Could not resolve your role in the company'
      )
    }
    role = lookup.role
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
      request,
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
    return errorRedirect(request, redirectUri, state, 'invalid_scope', parsed.description)
  }

  // The user selects scopes via checkboxes on the consent page. Three upper
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
  //   3. The ceiling is capped to the user's role in the selected company: a
  //      viewer cannot hand an agent write scopes the viewer does not hold
  //      themselves, however the form was built.
  const submittedScopes = formData.getAll('scopes').filter((s): s is string => typeof s === 'string')
  const validated = validateScopes(submittedScopes)
  const clientCeiling: ApiKeyScope[] = parsed.scopes ?? [...ALL_SCOPES]
  const roleCapped = companyId ? capScopesForRole(clientCeiling, role) : clientCeiling
  const ceilingSet = new Set<ApiKeyScope>(roleCapped)
  const boundedToClient = (validated ?? []).filter(s => ceilingSet.has(s))
  const grantedScopes: ApiKeyScope[] = boundedToClient.length > 0
    ? boundedToClient
    : [...DEFAULT_OAUTH_SCOPES].filter(s => ceilingSet.has(s))
  if (grantedScopes.length === 0) {
    return errorRedirect(
      request,
      redirectUri,
      state,
      'invalid_scope',
      'None of the requested scopes are available to your role in this company'
    )
  }

  // Create auth code with userId (NO API key: that's created at /token after PKCE)
  const code = createAuthCode({
    userId: user.id,
    codeChallenge,
    redirectUri,
    scopes: grantedScopes,
    companyId,
  })

  // Redirect to callback with the code
  const callbackUrl = new URL(redirectUri)
  callbackUrl.searchParams.set('code', code)
  if (state) callbackUrl.searchParams.set('state', state)
  // RFC 9207: issuer identification in the authorization response. Must match
  // the issuer discovery advertises for the host the client connected through.
  callbackUrl.searchParams.set('iss', resolveDiscoveryBaseUrl(request))

  // 303 See Other: forces browser to GET the callback URL, even though this
  // handler was reached via POST. NextResponse.redirect() defaults to 307,
  // which preserves POST and causes Claude's callback to return 405.
  return NextResponse.redirect(callbackUrl.toString(), 303)
}

/**
 * Render the scope checkbox UI grouped by domain. Only scopes in `ceiling`
 * are surfaced: scopes outside the ceiling are dropped from the consent UI
 * so the user can't tick boxes that the POST handler would refuse anyway.
 * The ceiling is the client's `scope` querystring (or ALL_SCOPES when it
 * passed none) capped to the user's role, matching the server-side
 * enforcement in the POST handler.
 */
function renderScopeCheckboxes(
  preChecked: Set<ApiKeyScope>,
  ceiling: Set<ApiKeyScope>,
): string {
  const renderedInGroups = new Set<ApiKeyScope>()
  const groups: string[] = []

  for (const group of SCOPE_GROUPS) {
    const rows: string[] = []
    for (const scope of group.scopes) {
      if (!ceiling.has(scope)) continue
      rows.push(scopeRow(scope, preChecked.has(scope), scopeKind(scope)))
      renderedInGroups.add(scope)
    }
    if (rows.length > 0) {
      groups.push(
        `<div class="scope-group"><div class="scope-group-title">${escapeHtml(group.label)}</div>${rows.join('')}</div>`
      )
    }
  }

  // Defense in depth: the catalogue test guarantees full group coverage, so
  // this bucket is empty unless a scope ships without a group.
  const remaining = ALL_SCOPES.filter(s => ceiling.has(s) && !renderedInGroups.has(s))
  if (remaining.length > 0) {
    const rows = remaining.map((s) => scopeRow(s, preChecked.has(s), scopeKind(s)))
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

/**
 * Human-readable identity of the client behind an allowed redirect URI, for
 * the consent page. Built-in patterns are named after the connector that owns
 * the callback host (and marked verified, since only that vendor can receive
 * the code there); DB registrations show the name the registering member
 * typed in settings, tagged with who registered it, never as verified.
 */
function describeClient(
  resolution: Exclude<RedirectUriResolution, { allowed: false }>,
): { name: string; tag: string; verified: boolean } {
  if (resolution.kind === 'built_in') {
    switch (resolution.provider) {
      case 'claude':
        return { name: 'Claude (Anthropic)', tag: 'Verifierad', verified: true }
      case 'chatgpt':
        return { name: 'ChatGPT (OpenAI)', tag: 'Verifierad', verified: true }
      case 'grok':
        return { name: 'Grok (xAI)', tag: 'Verifierad', verified: true }
      case 'cursor':
        return { name: 'Cursor (Anysphere)', tag: 'Verifierad', verified: true }
      case 'cursor_deeplink':
        // A custom scheme can be claimed by any local app (RFC 8252 section
        // 8.4), so it carries loopback trust, not vendor trust: same tag as
        // localhost, never marked verified.
        return { name: 'Cursor (Anysphere)', tag: 'Din egen dator', verified: false }
      case 'local':
        return { name: 'Lokal utveckling (localhost)', tag: 'Din egen dator', verified: false }
    }
  }
  return {
    name: resolution.clientName,
    tag: resolution.registeredByConsentingUser ? 'Registrerad av dig' : 'Registrerad av en kollega',
    verified: false,
  }
}

/**
 * Every interpolation into the consent-page template goes through this,
 * including the form's own action attribute (url.pathname + url.search).
 *
 * On that one: only redirect_uri/client_id/scope are validated upstream, so any
 * extra query parameter a caller appends is reflected into the attribute.
 * CodeQL reports it as js/reflected-xss. It was not a live exploit, because
 * WHATWG URL parsing already percent-encodes " < > in the query component and
 * an injected tag therefore arrives inert. It is escaped anyway for two
 * reasons: & is NOT in that encode set, so the unescaped form emitted raw
 * ampersands in an attribute (invalid HTML), and the safety of the page
 * otherwise rests on a parser normalisation invariant that nothing in this file
 * states or tests. Escaping & as &amp; is correct here: the browser decodes it
 * back on submit, so the query string round-trips intact.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
