import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from './api-keys'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { scopeKind, type ApiKeyScope } from './scope-catalog'
import { INVOICER_API_SCOPES, isInvoicerRole } from '@/lib/auth/invoicer-role'

/**
 * What an OAuth consent may grant: which redirect URIs a code may be sent
 * to, who the client behind a URI is, and which scopes the consenting user's
 * role in the selected company permits.
 */

// ── Redirect URI allowlist ─────────────────────────────────────

/**
 * Identity of a built-in client, derived from the redirect URI pattern that
 * matched. Rendered on the consent page so the user can tell a real Claude /
 * ChatGPT / Grok / Gemini / Cursor / Squidler / Celemine connector from a
 * look-alike registration.
 */
export type BuiltInProvider =
  | 'claude'
  | 'chatgpt'
  | 'grok'
  | 'gemini'
  | 'cursor'
  | 'cursor_deeplink'
  | 'squidler'
  | 'celemine'
  | 'flytt_extension'
  | 'local'

/**
 * Built-in redirect URI patterns. These bypass the DB lookup entirely so
 * the Claude, ChatGPT, Grok, Gemini, Cursor, Squidler and Celemine connectors keep working without seeded rows, and so
 * local development never depends on having a registration.
 *
 * ChatGPT uses a per-connector-instance callback path
 * (https://chatgpt.com/connector/oauth/{callback_id}) plus the legacy fixed
 * callback for already-published apps; both are documented at
 * developers.openai.com/apps-sdk/build/auth.
 *
 * Grok (grok.com custom connectors) registers itself through /register as a
 * public client and sends a single fixed callback,
 * https://grok.com/connectors-oauth-exchange-code/, published by X Corp as
 * the "Grok (web)" redirect URL at docs.x.com/x-ads-api/mcp (xAI's own
 * connector docs at docs.x.ai do not state it). grok.com serves the path
 * itself: the slash form 308s to the no-slash form on the same origin, so
 * both are accepted. Matched as an exact path, never a prefix, so a future
 * grok.com path cannot ride on this entry.
 *
 * Gemini (custom apps in the Gemini web app) registers itself through
 * /register with one callback per user and connector on Google's OAuth
 * relay: https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<id>-<server host>
 * (reported by other MCP servers, github.com/makeplane/plane-mcp-server
 * issue 230 and github.com/a91453/mml-tools pull 136; Google does not
 * publish it). The relay forwards /r/<id> to whoever owns <id>, and a Google
 * Cloud project id can take that place, so the whole /r/ path would let any
 * project receive codes and show up here as Gemini. Only the
 * `user_bound_custom-mcp-` form is matched: project ids cannot contain
 * underscores, so no project can claim it.
 *
 * Cursor (IDE and CLI) registers through /register with three redirect URIs
 * in one request: the legacy custom-scheme deeplink
 * cursor://anysphere.cursor-mcp/oauth/callback, the web fallback used by
 * Cloud Agents and Automations https://www.cursor.com/agents/mcp/oauth/callback,
 * and the RFC 8252 loopback http://localhost:8787/callback that current
 * builds actually redirect to (Cursor staff statement, forum.cursor.com
 * thread 165019). /register rejects the whole set when any one URI is
 * unknown, so the two non-loopback callbacks are allowlisted here as exact
 * matches; the loopback already passes through the local rule. The custom
 * scheme is accepted despite RFC 8252 section 8.4 (any local app can claim a
 * scheme) because the code is PKCE-bound to the client that started the flow
 * (S256 only, verifier required at /token, a code minted without a challenge
 * can never be exchanged) and the loopback form carries the same
 * local-machine trust. It is its own provider, `cursor_deeplink`, so the
 * consent page can show it unverified like localhost: a scheme proves
 * nothing about who receives the code, an https host does.
 *
 * Squidler (squidler.io, AI colleagues for small companies) is a partner
 * that connects its customers' agents over MCP and uses one fixed callback
 * for all of them, one for production and one for its dev environment. Both
 * are built in, so its customers connect without registering the callback
 * under Agenter first. Each is an exact path on Squidler's own https host,
 * never a prefix, so no other squidler.io path and no other subdomain rides
 * on it.
 *
 * Celemine (celemine.com, a policy and security gateway between a company's
 * AI agents and the systems they work in) connects to Accounted as one of its
 * upstream MCP servers. It registers itself through /register with callbacks
 * under https://celemine.com/upstream/ on its own host, so the entry is a
 * prefix, like Claude's /api/. Each path
 * segment must start with a letter, digit, `_` or `-` and hold only those and
 * `.`: no dot segment (`..`), percent-encoding, query or fragment can take the
 * browser off /upstream/ once the check has passed. Only the bare
 * celemine.com host matches, no subdomain.
 *
 * The browser extension "Flytta till Accounted" (flytt-extension.ts) signs
 * in through chrome.identity, whose redirect is https://<id>.chromiumapp.org/.
 * Chrome hands that URL only to the extension with that id, so it is matched
 * for the one id, as the exact root path.
 */
const BUILT_IN_PATTERNS: readonly { pattern: RegExp; provider: BuiltInProvider }[] = [
  { pattern: /^https:\/\/claude\.ai\/api\//, provider: 'claude' },
  { pattern: /^https:\/\/claude\.com\/api\//, provider: 'claude' },
  { pattern: /^https:\/\/chatgpt\.com\/connector\/oauth\//, provider: 'chatgpt' },
  { pattern: /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/, provider: 'chatgpt' },
  { pattern: /^https:\/\/grok\.com\/connectors-oauth-exchange-code\/?$/, provider: 'grok' },
  { pattern: /^https:\/\/oauth-redirect\.googleusercontent\.com\/r\/user_bound_custom-mcp-[A-Za-z0-9_-]+$/, provider: 'gemini' },
  { pattern: /^cursor:\/\/anysphere\.cursor-mcp\/oauth\/callback$/, provider: 'cursor_deeplink' },
  { pattern: /^https:\/\/www\.cursor\.com\/agents\/mcp\/oauth\/callback$/, provider: 'cursor' },
  { pattern: /^https:\/\/squidler\.io\/api\/oauth\/callback\/accounted$/, provider: 'squidler' },
  { pattern: /^https:\/\/dev\.squidler\.io\/api\/oauth\/callback\/accounted$/, provider: 'squidler' },
  { pattern: /^https:\/\/celemine\.com\/upstream(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+\/?$/, provider: 'celemine' },
  { pattern: /^https:\/\/ooeaogbjfhciekiidjaehikcbccomkmj\.chromiumapp\.org\/$/, provider: 'flytt_extension' },
  { pattern: /^http:\/\/localhost(:\d+)?(\/|$)/, provider: 'local' },
  { pattern: /^http:\/\/127\.0\.0\.1(:\d+)?(\/|$)/, provider: 'local' },
]

/** Which built-in client a redirect URI belongs to, or null when none matches. */
export function builtInRedirectProvider(uri: string): BuiltInProvider | null {
  if (typeof uri !== 'string') return null
  return BUILT_IN_PATTERNS.find(({ pattern }) => pattern.test(uri))?.provider ?? null
}

export function isBuiltInRedirectUri(uri: string): boolean {
  return builtInRedirectProvider(uri) !== null
}

/**
 * Origins a built-in callback is known to forward the browser to before it
 * answers. The consent page posts a form, and a browser that enforces CSP
 * form-action re-checks every hop of the redirect chain, so an onward hop to
 * an origin the policy does not name stops the navigation and the Allow
 * button looks dead.
 *
 * Cursor's web callback https://www.cursor.com/agents/mcp/oauth/callback
 * answers 308 to the same path on https://cursor.com (observed 2026-11-14,
 * crm#1720). The code is still only ever sent to the exact allowlisted URI;
 * this names where that host forwards it, nothing else.
 */
const BUILT_IN_ONWARD_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  'https://www.cursor.com': ['https://cursor.com'],
}

/** Onward origins the consent page's form-action must also allow for a built-in callback. */
export function builtInOnwardOrigins(uri: string): readonly string[] {
  if (!isBuiltInRedirectUri(uri)) return []
  try {
    return BUILT_IN_ONWARD_ORIGINS[new URL(uri).origin] ?? []
  } catch {
    return []
  }
}

export type RedirectUriResolution =
  | { allowed: true; kind: 'built_in'; provider: BuiltInProvider }
  | {
      allowed: true
      kind: 'registered'
      /** The registration the URI resolved to (the token route records it as the client). */
      registrationId: string
      /** Display name the registering user gave the client (settings UI). */
      clientName: string
      /** True when the consenting user registered the URI themselves. */
      registeredByConsentingUser: boolean
    }
  | { allowed: false }

export interface RedirectUriOptions {
  /**
   * The user about to consent at /authorize. When set, a DB-registered URI is
   * accepted only if this user registered it, or shares at least one company
   * with the user who did. Any authenticated user can insert into
   * oauth_client_registrations (RLS: user_id = auth.uid()), so without this
   * binding a stranger's registration would be a valid phishing target for
   * every account on the instance. Built-in patterns are unaffected.
   *
   * Omitted by the anonymous /register endpoint, which has no user to bind
   * to: it accepts any active registration, which is harmless because the
   * code is only ever minted at /authorize where the binding is enforced.
   */
  consentingUserId?: string
}

type RegistrationRow = { id: string; user_id: string; client_name: string }

/** Registrants checked per company_members read; keeps the `.in()` URL short. */
const REGISTRANT_CHUNK = 100

function registered(row: RegistrationRow, byConsentingUser: boolean): RedirectUriResolution {
  return {
    allowed: true, kind: 'registered', registrationId: row.id,
    clientName: row.client_name, registeredByConsentingUser: byConsentingUser,
  }
}

/**
 * Resolve a redirect URI to the client behind it. Built-in patterns
 * short-circuit; otherwise we look for a non-revoked registration in
 * oauth_client_registrations and, when a consenting user is given, take
 * the one they made themselves, else one a colleague made. Several users may
 * each register the same URI (crm#1654): a tool with one fixed callback for
 * all its customers is registered once per customer, and one customer's
 * registration never opens the URI for another customer.
 *
 * The lookup runs with the service role. The table's SELECT policy is
 * user_id = auth.uid(), so a user-scoped client cannot see a colleague's
 * registration at all; the trust boundary is instead the explicit binding to
 * `consentingUserId` below (SOC 2 CC6.1). Callers may pass a client (the
 * /register endpoint already holds one); otherwise one is constructed here.
 *
 * Fails closed on any error (client construction, DB query): for an
 * allowlist, "unknown → deny" is the safe default. The lookup is by exact
 * URI, oldest registration first.
 */
export async function resolveRedirectUri(
  uri: string,
  supabase?: SupabaseClient,
  options: RedirectUriOptions = {},
): Promise<RedirectUriResolution> {
  if (typeof uri !== 'string' || uri.length === 0) return { allowed: false }
  const provider = builtInRedirectProvider(uri)
  if (provider) return { allowed: true, kind: 'built_in', provider }

  // Service-role client construction can throw when Supabase env vars are
  // absent (unit tests, misconfigured deploys). Treat that as "not allowed":
  // failing closed is the safe default for an allowlist.
  let client: SupabaseClient
  try {
    client = supabase ?? createServiceClientNoCookies()
  } catch {
    return { allowed: false }
  }

  let registrations: RegistrationRow[]
  try {
    registrations = await fetchAllRows<RegistrationRow>(({ from, to }) =>
      client
        .from('oauth_client_registrations')
        .select('id, user_id, client_name')
        .eq('redirect_uri', uri)
        .is('revoked_at', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
  } catch {
    // Fail closed: an allowlist that cannot be read denies the URI.
    return { allowed: false }
  }
  if (registrations.length === 0) return { allowed: false }

  const { consentingUserId } = options
  if (consentingUserId === undefined) return registered(registrations[0], false)

  const own = registrations.find((r) => r.user_id === consentingUserId)
  if (own) return registered(own, true)

  const colleague = await firstColleagueRegistration(client, consentingUserId, registrations)
  return colleague ? registered(colleague, false) : { allowed: false }
}

/**
 * Boolean view of resolveRedirectUri, kept for the callers that only need
 * the allow/deny answer (the /register endpoint and its tests).
 */
export async function isAllowedRedirectUri(
  uri: string,
  supabase?: SupabaseClient,
  options: RedirectUriOptions = {},
): Promise<boolean> {
  const resolution = await resolveRedirectUri(uri, supabase, options)
  return resolution.allowed
}

/**
 * The oldest of `registrations` made by someone who shares at least one
 * company with `userId`, or null. The user's own memberships are paginated
 * (a byrå consultant can sit in hundreds of companies) and intersected here;
 * the registrants' memberships are read in chunks so the `.in()` filter stays
 * short however many customers registered the URI. Any query failure counts
 * as "no colleague" (fail closed).
 */
async function firstColleagueRegistration(
  client: SupabaseClient,
  userId: string,
  registrations: RegistrationRow[],
): Promise<RegistrationRow | null> {
  try {
    const ownRows = await fetchAllRows<{ company_id: string }>(({ from, to }) =>
      client
        .from('company_members')
        .select('company_id')
        .eq('user_id', userId)
        .order('id', { ascending: true })
        .range(from, to),
    )
    const companies = new Set(ownRows.map((r) => r.company_id))
    if (companies.size === 0) return null
    const registrants = [...new Set(registrations.map((r) => r.user_id))]
    for (let i = 0; i < registrants.length; i += REGISTRANT_CHUNK) {
      const chunk = registrants.slice(i, i + REGISTRANT_CHUNK)
      const rows = await fetchAllRows<{ user_id: string; company_id: string }>(({ from, to }) =>
        client
          .from('company_members')
          .select('user_id, company_id')
          .in('user_id', chunk)
          .order('id', { ascending: true })
          .range(from, to),
      )
      const colleagues = new Set(rows.filter((r) => companies.has(r.company_id)).map((r) => r.user_id))
      const hit = registrations.find((r) => colleagues.has(r.user_id))
      if (hit) return hit
    }
    return null
  } catch {
    // Fail closed: a membership read that errors counts as no colleague.
    return null
  }
}

// ── Role ceiling ──────────────────────────────────────────────

/** Company roles whose members may hold write, manage, approve or signoff scopes. */
const WRITER_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member'])

/**
 * Cap a scope set to what the consenting user's role in the selected company
 * permits. Mirrors the app's own gate: `viewer` is read-only everywhere
 * (withRouteContext requireWrite, the DB-level enforce_company_writer_role
 * trigger), while owner/admin/member may hold every scope. The stage+approve
 * segregation-of-duties combination is not capped by role, matching
 * app/api/settings/api-keys (warn, acknowledge, record), so the consent page
 * states the rule and the token route records the acknowledgement.
 *
 * A null role (no membership row) or an unrecognised role string caps to
 * read-only: an unknown privilege level must never widen the grant.
 */
export function capScopesForRole(
  scopes: readonly ApiKeyScope[],
  role: string | null,
): ApiKeyScope[] {
  if (role !== null && WRITER_ROLES.has(role)) return [...scopes]
  // The invoicing-only role (lib/auth/invoicer-role.ts): its own scopes,
  // read and write, and nothing else.
  if (isInvoicerRole(role)) return scopes.filter((s) => INVOICER_API_SCOPES.includes(s))
  return scopes.filter((s) => scopeKind(s) === 'read')
}

export type CompanyRoleLookup =
  | { role: string | null; error: null }
  | { role: null; error: string }

/**
 * The user's role in a company, or null when no membership row exists. A
 * failed query is reported separately so callers can fail loudly instead of
 * silently downgrading (or widening) a grant on a transient error.
 */
export async function lookupCompanyRole(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<CompanyRoleLookup> {
  const { data, error } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) return { role: null, error: error.message }
  const role = (data as { role?: unknown } | null)?.role
  return { role: typeof role === 'string' ? role : null, error: null }
}
