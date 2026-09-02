import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from './api-keys'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { scopeKind, type ApiKeyScope } from './scope-catalog'

/**
 * What an OAuth consent may grant: which redirect URIs a code may be sent
 * to, who the client behind a URI is, and which scopes the consenting user's
 * role in the selected company permits.
 */

// ── Redirect URI allowlist ─────────────────────────────────────

/**
 * Identity of a built-in client, derived from the redirect URI pattern that
 * matched. Rendered on the consent page so the user can tell a real Claude /
 * ChatGPT / Grok connector from a look-alike registration.
 */
export type BuiltInProvider = 'claude' | 'chatgpt' | 'grok' | 'local'

/**
 * Built-in redirect URI patterns. These bypass the DB lookup entirely so
 * the Claude, ChatGPT and Grok connectors keep working without seeded rows, and so
 * local development never depends on having a registration.
 *
 * ChatGPT uses a per-connector-instance callback path
 * (https://chatgpt.com/connector/oauth/{callback_id}) plus the legacy fixed
 * callback for already-published apps; both are documented at
 * developers.openai.com/apps-sdk/build/auth.
 *
 * Grok (grok.com custom connectors) registers itself through /register as a
 * public client and sends a single fixed callback,
 * https://grok.com/connectors-oauth-exchange-code/. xAI publishes no
 * developer page for it; the value is what Grok's DCR request carried when
 * observed live (2026-08-09, confirmed by two independent connector
 * write-ups). Matched as an exact path (trailing slash optional), never a
 * prefix, so a future grok.com path cannot ride on this entry.
 */
const BUILT_IN_PATTERNS: readonly { pattern: RegExp; provider: BuiltInProvider }[] = [
  { pattern: /^https:\/\/claude\.ai\/api\//, provider: 'claude' },
  { pattern: /^https:\/\/claude\.com\/api\//, provider: 'claude' },
  { pattern: /^https:\/\/chatgpt\.com\/connector\/oauth\//, provider: 'chatgpt' },
  { pattern: /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/, provider: 'chatgpt' },
  { pattern: /^https:\/\/grok\.com\/connectors-oauth-exchange-code\/?$/, provider: 'grok' },
  { pattern: /^http:\/\/localhost(:\d+)?(\/|$)/, provider: 'local' },
  { pattern: /^http:\/\/127\.0\.0\.1(:\d+)?(\/|$)/, provider: 'local' },
]

export const BUILT_IN_REDIRECT_PATTERNS: readonly RegExp[] = BUILT_IN_PATTERNS.map((p) => p.pattern)

/** Which built-in client a redirect URI belongs to, or null when none matches. */
export function builtInRedirectProvider(uri: string): BuiltInProvider | null {
  if (typeof uri !== 'string') return null
  return BUILT_IN_PATTERNS.find(({ pattern }) => pattern.test(uri))?.provider ?? null
}

export function isBuiltInRedirectUri(uri: string): boolean {
  return builtInRedirectProvider(uri) !== null
}

export type RedirectUriResolution =
  | { allowed: true; kind: 'built_in'; provider: BuiltInProvider }
  | {
      allowed: true
      kind: 'registered'
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

/**
 * Resolve a redirect URI to the client behind it. Built-in patterns
 * short-circuit; otherwise we look for a non-revoked registration in
 * oauth_client_registrations and, when a consenting user is given, check
 * that the registration is theirs or a colleague's.
 *
 * The lookup runs with the service role. The table's SELECT policy is
 * user_id = auth.uid(), so a user-scoped client cannot see a colleague's
 * registration at all; the trust boundary is instead the explicit binding to
 * `consentingUserId` below (SOC 2 CC6.1). Callers may pass a client (the
 * /register endpoint already holds one); otherwise one is constructed here.
 *
 * Fails closed on any error (client construction, DB query): for an
 * allowlist, "unknown → deny" is the safe default. The lookup is by exact
 * URI; the unique partial index on the table ensures at most one active row.
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

  const { data, error } = await client
    .from('oauth_client_registrations')
    .select('id, user_id, client_name')
    .eq('redirect_uri', uri)
    .is('revoked_at', null)
    .limit(1)
    .maybeSingle()

  if (error || !data) return { allowed: false }
  const registration = data as RegistrationRow

  const { consentingUserId } = options
  if (consentingUserId === undefined) {
    return { allowed: true, kind: 'registered', clientName: registration.client_name, registeredByConsentingUser: false }
  }

  if (registration.user_id === consentingUserId) {
    return { allowed: true, kind: 'registered', clientName: registration.client_name, registeredByConsentingUser: true }
  }

  const shared = await usersShareCompany(client, consentingUserId, registration.user_id)
  if (!shared) return { allowed: false }
  return { allowed: true, kind: 'registered', clientName: registration.client_name, registeredByConsentingUser: false }
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
 * True when the two users are both members of at least one common company.
 * Both membership lists are paginated (a byrå consultant can sit in hundreds
 * of companies) and intersected here rather than via an `.in()` filter, whose
 * URL length would grow with the membership count. Any query failure counts
 * as "not shared" (fail closed).
 */
async function usersShareCompany(
  client: SupabaseClient,
  userA: string,
  userB: string,
): Promise<boolean> {
  try {
    const companyIdsOf = (userId: string) =>
      fetchAllRows<{ company_id: string }>(({ from, to }) =>
        client
          .from('company_members')
          .select('company_id')
          .eq('user_id', userId)
          .order('id', { ascending: true })
          .range(from, to),
      )
    const [rowsA, rowsB] = await Promise.all([companyIdsOf(userA), companyIdsOf(userB)])
    const companiesA = new Set(rowsA.map((r) => r.company_id))
    return rowsB.some((r) => companiesA.has(r.company_id))
  } catch {
    return false
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
