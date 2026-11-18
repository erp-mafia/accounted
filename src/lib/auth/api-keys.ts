import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { createLogger } from '@/lib/logger'
// Not lib/company/context: that module imports next/headers for the legacy
// company cookie, and this file is reachable from bundles where that import
// is a build error.
import { getActiveCompanyId } from '@/lib/company/active-company'

const KEY_PREFIX = 'gnubok_sk_'
const REFRESH_TOKEN_PREFIX = 'gnubok_rt_'

// ── API Key Scopes ──────────────────────────────────────────
// The catalogue lives in scope-catalog.ts (no server imports, safe for client
// bundles) and is re-exported here so existing imports keep working.
export {
  API_KEY_SCOPES,
  ALL_SCOPES,
  DEFAULT_SCOPES,
  DEFAULT_OAUTH_SCOPES,
  STAGING_SCOPES,
  findStageApproveConflict,
  SCOPE_GROUPS,
  scopeKind,
  TOOL_SCOPE_MAP,
  TOOL_COUNT_BY_SCOPE,
  UNSCOPED_TOOLS,
  argumentScopeFor,
} from './scope-catalog'
export type { ApiKeyScope } from './scope-catalog'
import { API_KEY_SCOPES, DEFAULT_SCOPES, scopeSatisfied, type ApiKeyScope } from './scope-catalog'

export function validateScopes(scopes: unknown): ApiKeyScope[] | null {
  if (scopes === null || scopes === undefined) return null
  if (!Array.isArray(scopes)) return null
  const valid = scopes.filter((s): s is ApiKeyScope => s in API_KEY_SCOPES)
  return valid.length > 0 ? valid : null
}

/**
 * Create a Supabase service client that doesn't require cookies.
 * Used for API key validation (MCP, webhooks) where there's no browser session.
 */
export function createServiceClientNoCookies() {
  return createServiceRoleClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

/**
 * Name of every api_keys row minted by the MCP OAuth token route
 * (app/api/mcp-oauth/token). It is the only marker those rows carry (there
 * is no source column), so the Hem checklist's "Anslut till Claude" step
 * matches on it to know a client completed its first sign-in. Renaming it
 * would untick the step for every existing connection. The manual create
 * route (app/api/settings/api-keys) rejects this name so a hand-minted key
 * cannot fake the connection.
 */
export const OAUTH_MCP_KEY_NAME = 'MCP-klient (OAuth)'

export function generateApiKey(mode: ApiKeyMode = 'live'): { key: string; hash: string; prefix: string } {
  const random = crypto.randomBytes(32).toString('base64url')
  // Test keys carry an explicit `test_` infix so integrators can tell at a
  // glance which environment a key targets (matches the llms.txt contract:
  // `gnubok_sk_test_<random>`). The infix is purely cosmetic: the authoritative
  // mode is the `mode` column on api_keys, read back by hash in validateApiKey,
  // so nothing trusts the key string. Both variants keep the `gnubok_sk_`
  // prefix so the `startsWith(KEY_PREFIX)` check in validateApiKey still holds.
  const key = mode === 'test' ? `${KEY_PREFIX}test_${random}` : `${KEY_PREFIX}${random}`
  const hash = hashApiKey(key)
  // First 18 chars: 'gnubok_sk_test_xyz' for test keys, 'gnubok_sk_xxxxxxxx'
  // for live: the stored prefix is what the settings UI shows, so the test_
  // infix is visible in the key list without exposing the secret.
  const prefix = key.slice(0, KEY_PREFIX.length + 8)
  return { key, hash, prefix }
}

/**
 * SHA-256, deliberately, and NOT a slow KDF like bcrypt/argon2.
 *
 * CodeQL flags this as js/insufficient-password-hash. That rule exists for
 * user-chosen passwords, which are low-entropy and brute-forceable, so the
 * defence is to make each guess expensive. This input is not a password: keys
 * come from generateApiKey as 32 CSPRNG bytes (`gnubok_sk_<base64url>`), and no
 * work factor moves the needle on a 256-bit random secret.
 *
 * A slow KDF would also be actively worse here: this runs on the hot path of
 * every MCP request, where the hash is the primary-key lookup used to find the
 * row, so per-request cost is real latency for zero security gain.
 *
 * Do NOT "fix" this by changing the algorithm. The hash IS the stored
 * credential, so a different function invalidates every live `gnubok_sk_` key,
 * breaking existing MCP connections with no migration path.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

export function generateRefreshToken(): { token: string; hash: string } {
  const random = crypto.randomBytes(32).toString('base64url')
  const token = `${REFRESH_TOKEN_PREFIX}${random}`
  const hash = crypto.createHash('sha256').update(token).digest('hex')
  return { token, hash }
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function isRefreshToken(token: string): boolean {
  return token.startsWith(REFRESH_TOKEN_PREFIX)
}

/**
 * The access key and refresh token a refresh token rotates into (crm#1043).
 *
 * Derived from the presented token instead of drawn at random, so the same
 * refresh token always rotates into the same pair: a client that retries a
 * refresh (a lost response, two concurrent refreshes, a successor it failed
 * to persist) gets back exactly what the first answer handed out, and
 * whichever of the identical answers it keeps works. Whether a replay is
 * answered at all is decided by rotate_mcp_refresh_token; this only makes the
 * answer stable.
 *
 * HMAC-SHA256 under a purpose-scoped derivation of the server-only
 * service-role secret (the oauth-flow-crypto pattern): the successor of a
 * stolen refresh token cannot be computed without that secret, and whoever
 * holds the secret already controls the database. Nothing reversible is
 * stored: the row keeps only the SHA-256 of each token, as before.
 */
export function deriveRotatedCredentials(presentedRefreshToken: string): {
  refresh: { token: string; hash: string }
  key: { key: string; hash: string; prefix: string }
} {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  const hmacKey = crypto
    .createHash('sha256')
    .update('mcp-oauth-refresh-successor:v1:' + secret)
    .digest()
  const derive = (label: string) =>
    crypto.createHmac('sha256', hmacKey).update(`${label}:${presentedRefreshToken}`).digest('base64url')
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${derive('refresh')}`
  const key = `${KEY_PREFIX}${derive('access')}`
  return {
    refresh: { token: refreshToken, hash: hashRefreshToken(refreshToken) },
    // Same prefix length generateApiKey stores for the settings UI.
    key: { key, hash: hashApiKey(key), prefix: key.slice(0, KEY_PREFIX.length + 8) },
  }
}

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7)
}

/**
 * Validate an API key and enforce rate limiting.
 * Uses the DB RPC for atomic check + increment.
 * Returns the user_id, company_id, api_key_id, name, and effective scopes on
 * success, or an error with HTTP status.
 * null scopes in DB → DEFAULT_SCOPES (read-only).
 *
 * api_key_id and api_key_name are returned so callers (e.g. the MCP server)
 * can record actor attribution on pending_operations and audit_log.
 * They may be undefined when the deployed DB hasn't yet run the migration
 * that adds them to the RPC return shape.
 */
/**
 * Operating mode of the API key. 'live' keys see real company data; 'test' keys
 * are bound to deterministic sandbox companies. Keys created before the Phase 1
 * migration default to 'live' for backwards compatibility.
 */
export type ApiKeyMode = 'live' | 'test'

/**
 * Seconds a rate-limited caller should wait before retrying.
 *
 * `validate_and_increment_api_key` enforces a FIXED one-minute tumbling
 * window per key row (`rate_limit_window_start`), and the limited branch
 * deliberately does not slide the window, so the current window can never
 * have more than 60 seconds left to run. 60 is therefore an exact upper
 * bound rather than a guess, which is what `Retry-After` requires.
 *
 * The exact reset instant is `rate_limit_window_start + 1 minute` and is
 * known inside the RPC, but its RETURNS TABLE carries no window column, so
 * TypeScript cannot see it. Emitting the IETF `RateLimit` / `RateLimit-Policy`
 * fields (draft-ietf-httpapi-ratelimit-headers) needs that column first.
 */
export const RATE_LIMIT_RETRY_AFTER_SECONDS = 60

/**
 * The service account a key belongs to (migration 20261016120000), as the
 * validation read it: its id and its name, which is the actor label of every
 * write the key makes. The key's userId is the account's sponsor.
 */
export interface ApiKeyServiceAccount {
  id: string
  name: string
}

/**
 * A refused key whose refusal has a code of its own, answered 403 by every
 * door: the key's agent identity is paused by its sponsor (AGENT_PAUSED,
 * migration 20261029100000), or a service account whose sponsor is no longer
 * an owner or admin of its company, or whose company is archived
 * (SERVICE_ACCOUNT_SUSPENDED). Every other refusal is the bare 401 or 429.
 */
export type ApiKeyRefusalCode = 'AGENT_PAUSED' | 'SERVICE_ACCOUNT_SUSPENDED'

/** What a connector is called in the records, by the provider that minted its key (api_keys.client). */
const CONNECTOR_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude (Anthropic)',
  chatgpt: 'ChatGPT (OpenAI)',
  grok: 'Grok (xAI)',
  cursor: 'Cursor',
  squidler: 'Squidler',
}

/** The facts of a validated key that decide who it is. */
export interface CredentialFacts {
  userId?: string
  apiKeyName?: string
  serviceAccount: ApiKeyServiceAccount | null
  client?: string | null
  clientName?: string | null
  unattendedCommitLimit?: number | null
}

/**
 * WHO a validated key acts as, the same way in every record it writes,
 * whichever door it came through: a service account's key as
 * `service_account` with the account's name (its rows carry the sponsor as
 * user_id, the person it acts for), a key minted by the OAuth sign-in as
 * `mcp_oauth` with its client's name, any other key as `api_key` with its own
 * name. An OAuth key is told by its client or, older than that column, by the
 * reserved name, which it then keeps as its label ("AI-anslutning" in
 * lib/attribution).
 *
 * The key's unattended ceiling rides along when it has one: the engine and the
 * attest service read it off the actor of the request's scope
 * (lib/bookkeeping/unattended-ceiling.ts). So does the key's user, the person
 * it acts for: the audit log names them for the request's writes
 * (lib/supabase/actor-header.ts).
 */
export function credentialActor(key: CredentialFacts): {
  type: 'service_account' | 'mcp_oauth' | 'api_key'
  label: string
  userId?: string
  unattendedCommitLimit?: number
} {
  const ceiling = typeof key.unattendedCommitLimit === 'number' ? { unattendedCommitLimit: key.unattendedCommitLimit } : {}
  const person = key.userId ? { userId: key.userId } : {}
  if (key.serviceAccount) return { type: 'service_account', label: key.serviceAccount.name, ...person, ...ceiling }
  if (key.client || key.apiKeyName === OAUTH_MCP_KEY_NAME) {
    const label = key.clientName ?? (key.client ? CONNECTOR_LABELS[key.client] : undefined) ?? OAUTH_MCP_KEY_NAME
    return { type: 'mcp_oauth', label, ...person, ...ceiling }
  }
  return { type: 'api_key', label: key.apiKeyName ?? 'Unnamed API key', ...person, ...ceiling }
}

export async function validateApiKey(
  key: string
): Promise<
  | {
      userId: string
      /**
       * The key's default company. null only while the key's user has no
       * company at all (minted from the OAuth popup before onboarding, issue
       * #1814): the first validation after a company exists binds the key.
       */
      companyId: string | null
      apiKeyId?: string
      apiKeyName?: string
      scopes: ApiKeyScope[]
      mode: ApiKeyMode
      /**
       * SEK ceiling on what this key may commit WITHOUT human approval, or
       * null for no limit. Null is the only representation of "no limit": a
       * stored 0 is forbidden by CHECK, because reading absence as 0 would
       * block every commit for the key.
       */
      unattendedCommitLimit: number | null
      /**
       * Per-key company allowlist (api_key_companies, migration
       * 20260928112721): null when the key has no rows, meaning every
       * non-archived company the user belongs to is reachable (and future
       * memberships follow); else the listed company ids, which every door
       * intersects with live membership on each call. The allowlist can only
       * narrow reach, never widen it. null also when the deployed DB has not
       * run the migration yet.
       */
      allowedCompanyIds: string[] | null
      /**
       * Companies in the allowlist where the key may only read
       * (api_key_companies.access = 'read', migration 20260928112724): every
       * scope that is not `:read` is refused there, whatever the key's
       * scopes say. null when there are none, which is always the case for
       * an unrestricted key and when the deployed DB has not run the
       * migration (no read-only rows can exist then). Always a subset of
       * `allowedCompanyIds`.
       */
      readOnlyCompanyIds: string[] | null
      /**
       * The service account the key belongs to, or null for a person's key
       * (and for every key while the deployed DB has not run 20261016120000).
       * A service-account key reaches exactly the account's company: the
       * database answers allowedCompanyIds with that one company.
       */
      serviceAccount: ApiKeyServiceAccount | null
      /**
       * The agent identity the key belongs to (agent_identities, migration
       * 20261029100000): one per OAuth connector and sponsor, one per manual
       * key, one per service account. Always set by validateApiKey; null on
       * a DB without the migration. Optional so a validated key built by
       * hand (tests, fixtures) need not invent one.
       */
      agentIdentityId?: string | null
      /**
       * The OAuth client that minted the key (api_keys.client): a built-in
       * provider such as 'claude', or 'registered:<id>'. null for manual and
       * service-account keys, OAuth keys older than the column, and a DB
       * without the migration. Optional for the same reason.
       */
      client?: string | null
      /**
       * The name a 'registered:<id>' client gave itself, with the suffix the
       * records carry. Null for every other key.
       */
      clientName?: string | null
    }
  | { error: string; status: number; code?: ApiKeyRefusalCode }
> {
  if (isRefreshToken(key)) {
    return {
      error: 'Refresh token cannot be used as access token; exchange it at /api/mcp-oauth/token',
      status: 401,
    }
  }

  if (!key.startsWith(KEY_PREFIX)) {
    return { error: 'Invalid API key format', status: 401 }
  }

  const hash = hashApiKey(key)
  const supabase = createServiceClientNoCookies()

  const { data, error } = await supabase.rpc('validate_and_increment_api_key', {
    p_key_hash: hash,
  })

  if (error || !data || data.length === 0) {
    if (!error) {
      const refusal = await codedRefusal(supabase, hash)
      if (refusal) return refusal
    }
    return { error: 'Invalid API key', status: 401 }
  }

  const row = data[0]

  if (row.rate_limited) {
    return { error: 'Rate limit exceeded', status: 429 }
  }

  // Fail closed on an allowlist the row carries but that parses to nothing:
  // checked before the late binding below so a refused key writes nothing.
  const allowedCompanyIds = parseAllowedCompanyIds(row.allowed_company_ids)
  if (allowedCompanyIds === 'invalid') {
    createLogger('auth/api-keys').error('refusing key with an unreadable company allowlist', {
      apiKeyId: row.api_key_id,
    })
    return { error: 'Invalid API key', status: 401 }
  }

  // Same fail-closed rule for the read-only subset: a value that is present
  // but unreadable, or that names a company outside the allowlist, refuses
  // the key rather than letting it write where the user chose read.
  const readOnlyCompanyIds = parseReadOnlyCompanyIds(row.read_only_company_ids, allowedCompanyIds)
  if (readOnlyCompanyIds === 'invalid') {
    createLogger('auth/api-keys').error('refusing key with an unreadable read-only company list', {
      apiKeyId: row.api_key_id,
    })
    return { error: 'Invalid API key', status: 401 }
  }

  const companyId: string | null =
    row.company_id ?? (await bindUnboundKey(supabase, row.user_id, row.api_key_id))
  const client = nonEmptyString(row.client)

  return {
    userId: row.user_id,
    companyId,
    apiKeyId: row.api_key_id,
    apiKeyName: row.api_key_name,
    scopes: validateScopes(row.scopes) ?? DEFAULT_SCOPES,
    // `mode` may be undefined when the deployed DB hasn't yet run the Phase 1
    // migration that adds it to the RPC return. Default to 'live' so existing
    // keys behave unchanged.
    mode: (row.mode === 'test' ? 'test' : 'live') as ApiKeyMode,
    // PostgREST returns numeric as a STRING, so parse explicitly rather than
    // relying on `>` coercion at the comparison site. Anything unparseable,
    // absent (a DB that has not run the migration), or non-positive becomes
    // null, i.e. no limit: this control must fail OPEN. Blocking a company's
    // month-end because a defence-in-depth read blipped would be far worse
    // than not enforcing.
    unattendedCommitLimit: parseUnattendedCommitLimit(row.unattended_commit_limit),
    allowedCompanyIds,
    readOnlyCompanyIds,
    serviceAccount: parseServiceAccount(row.service_account_id, row.service_account_name),
    agentIdentityId: nonEmptyString(row.agent_identity_id),
    client,
    clientName: await registeredClientName(supabase, client),
  }
}

/** The client's own name for a 'registered:<id>' client, as the records name it. A failed read keeps the reserved name. */
async function registeredClientName(supabase: SupabaseClient, client: string | null): Promise<string | null> {
  const id = client?.match(/^registered:([0-9a-f-]{36})$/i)?.[1]
  if (!id) return null
  const { data } = await supabase.from('oauth_client_registrations').select('client_name').eq('id', id).maybeSingle()
  const name = nonEmptyString((data as { client_name?: unknown } | null)?.client_name)
  return name ? `${name} (registered client)` : null
}

const CODED_REFUSALS: Record<ApiKeyRefusalCode, string> = {
  AGENT_PAUSED: 'Agent paused: the person responsible for it can resume it under Settings in Accounted',
  SERVICE_ACCOUNT_SUSPENDED: 'Service account suspended: its sponsor is no longer an owner or admin of the company',
}

/**
 * Why the validation answered no row, when the reason has a code of its own:
 * the key's agent is paused, or its service account is suspended. The key is
 * otherwise live, so the caller gets a structured 403 instead of the 401 an
 * unknown key gets (a person can fix it, the integrator cannot). One extra
 * read, on the refusal path only. Any failure (a DB without api_key_refusal
 * answers PGRST202) falls back to the generic 401.
 */
async function codedRefusal(
  supabase: SupabaseClient,
  hash: string,
): Promise<{ error: string; status: number; code: ApiKeyRefusalCode } | null> {
  try {
    const { data, error } = await supabase.rpc('api_key_refusal', { p_key_hash: hash })
    if (error || (data !== 'AGENT_PAUSED' && data !== 'SERVICE_ACCOUNT_SUSPENDED')) return null
    return { error: CODED_REFUSALS[data as ApiKeyRefusalCode], status: 403, code: data as ApiKeyRefusalCode }
  } catch {
    return null
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The key's service account, or null for a person's key (or a DB without the columns). */
function parseServiceAccount(id: unknown, name: unknown): ApiKeyServiceAccount | null {
  if (typeof id !== 'string' || id.length === 0) return null
  return { id, name: typeof name === 'string' && name.length > 0 ? name : 'Service account' }
}

/**
 * The key's company allowlist, null for an unrestricted key, or 'invalid'.
 *
 * The RPC returns NULL for a key without allowlist rows and never an empty
 * array (array_agg over zero rows is NULL), so only an absent value (a DB
 * that has not run the migration) or null reads as "no allowlist": the
 * allowlist narrows a key that is already bounded by live membership, so its
 * absence is today's behaviour. A value that IS present but yields no
 * company id (not an array, an empty array, no non-empty strings) is
 * 'invalid' and the key is refused: reading it as null would turn a
 * restricted key into one that reaches every company.
 */
function parseAllowedCompanyIds(value: unknown): string[] | null | 'invalid' {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) return 'invalid'
  const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0)
  return ids.length > 0 ? ids : 'invalid'
}

/**
 * The key's read-only companies, null when there are none, or 'invalid'.
 *
 * Like the allowlist, the RPC returns NULL rather than an empty array, and
 * an absent value means a DB without the column, where no read-only row can
 * exist. A present value must be a non-empty list of company ids that all
 * sit inside the allowlist (the database guarantees both); anything else is
 * 'invalid' and refuses the key, because reading a broken list as "none"
 * would let the key write where the user chose read.
 */
function parseReadOnlyCompanyIds(
  value: unknown,
  allowedCompanyIds: string[] | null,
): string[] | null | 'invalid' {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || allowedCompanyIds === null) return 'invalid'
  const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) return 'invalid'
  const allowed = new Set(allowedCompanyIds.map((id) => id.toLowerCase()))
  return ids.every((id) => allowed.has(id.toLowerCase())) ? ids : 'invalid'
}

/**
 * Null unless the value is a finite number strictly greater than zero.
 *
 * Written NULL-first on purpose. Never `?? 0`, never `|| 0`, never
 * `Number(undefined)` (which yields NaN, and NaN comparisons are false, so it
 * would silently disable the control rather than loudly fail).
 */
function parseUnattendedCommitLimit(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

/**
 * Late binding for keys minted before the user's first company existed.
 *
 * The OAuth token endpoint stores company_id NULL for such keys. Company
 * creation happens in the web app (a Server Action) which knows nothing about
 * the user's keys, so the binding is healed here, on the first validation after
 * a company exists: one place, regardless of how the company was created.
 * Returns null while the user still has no company. The UPDATE is best-effort:
 * a failed write only means the next call resolves again.
 */
async function bindUnboundKey(
  supabase: SupabaseClient,
  userId: string,
  apiKeyId: string | undefined
): Promise<string | null> {
  let companyId: string | null
  try {
    companyId = await getActiveCompanyId(supabase, userId)
  } catch {
    return null
  }
  if (!companyId) return null
  if (apiKeyId) {
    await supabase
      .from('api_keys')
      .update({ company_id: companyId })
      .eq('id', apiKeyId)
      .is('company_id', null)
  }
  return companyId
}

/**
 * Check if a given scope is allowed by the key's scopes: held directly, or
 * included in a broader scope the key holds (SCOPE_INCLUDED_IN).
 */
export function hasScope(keyScopes: ApiKeyScope[], required: ApiKeyScope): boolean {
  return scopeSatisfied(keyScopes, required)
}
