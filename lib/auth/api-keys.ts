import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
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
  PUBLIC_OAUTH_METADATA_SCOPES,
  STAGING_SCOPES,
  findStageApproveConflict,
  SCOPE_GROUPS,
  scopeKind,
  TOOL_SCOPE_MAP,
  TOOL_COUNT_BY_SCOPE,
} from './scope-catalog'
export type { ApiKeyScope, ScopeGroup } from './scope-catalog'
import { API_KEY_SCOPES, DEFAULT_SCOPES, type ApiKeyScope } from './scope-catalog'

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
    }
  | { error: string; status: number }
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
    return { error: 'Invalid API key', status: 401 }
  }

  const row = data[0]

  if (row.rate_limited) {
    return { error: 'Rate limit exceeded', status: 429 }
  }

  const companyId: string | null =
    row.company_id ?? (await bindUnboundKey(supabase, row.user_id, row.api_key_id))

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
  }
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
 * Check if a given scope is allowed by the key's scopes.
 */
export function hasScope(keyScopes: ApiKeyScope[], required: ApiKeyScope): boolean {
  return keyScopes.includes(required)
}
