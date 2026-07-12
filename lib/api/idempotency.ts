/**
 * Idempotency layer for agent-safe retries.
 *
 * Use case: an agent (MCP, automation webhook, scripted client) retries an
 * operation after a network blip. Without idempotency, the retry creates a
 * duplicate side-effect: two invoices, two journal entries, two emails.
 *
 * Contract:
 *   1. The caller supplies an `idempotency_key` per logical operation.
 *   2. The server hashes the canonical request body and consults
 *      idempotency_keys.
 *   3. Hit + matching hash → return cached response (suppress side-effects).
 *   4. Hit + different hash → throw IdempotencyKeyReuseError (409 in HTTP).
 *   5. Miss → proceed; on success, persist the response.
 *
 * Keys are scoped per (user, company): the same key UUID across two
 * companies cannot collide, and a multi-company user replaying a key in
 * the wrong company can never receive the other company's cached response.
 *
 * 24-hour TTL is enforced by an `expires_at` column + a cleanup cron. After
 * 24h, the same key may be reused safely: agents that retry that long after
 * the original request are not retrying, they're starting over.
 */
import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export type IdempotencyScope = 'mcp_tool' | 'api_route'

export class IdempotencyKeyReuseError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSE'
  constructor(public readonly key: string) {
    super(`Idempotency key "${key}" was previously used with a different request body. Use a fresh key or send the original request.`)
    this.name = 'IdempotencyKeyReuseError'
  }
}

export interface IdempotencyHit {
  status: 'success' | 'error'
  body: Record<string, unknown>
}

/**
 * Canonical hash of a request body. Sorts keys recursively so semantically
 * identical bodies produce the same hash regardless of property order.
 */
export function hashRequest(body: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
}

/**
 * Look up a previously-cached idempotency response.
 *
 * Returns:
 *   - null when no cached entry exists (caller should proceed)
 *   - the cached body when the key+hash match (caller should return it
 *     without side-effects)
 *
 * Throws IdempotencyKeyReuseError when the key exists with a *different*
 * request hash: the caller is misusing the key.
 */
export async function checkIdempotencyKey(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  key: string,
  requestHash: string
): Promise<IdempotencyHit | null> {
  const { data, error } = await supabase
    .from('idempotency_keys')
    .select('request_hash, response_status, response_body, expires_at')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .eq('key', key)
    .maybeSingle()

  if (error || !data) return null

  // Expired entries are treated as misses; the cleanup cron will delete them.
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return null
  }

  if (data.request_hash !== requestHash) {
    throw new IdempotencyKeyReuseError(key)
  }

  return {
    status: data.response_status as 'success' | 'error',
    body: (data.response_body ?? {}) as Record<string, unknown>,
  }
}

/**
 * Persist the response for an idempotency key. Best-effort: a duplicate-row
 * race is swallowed so two concurrent retries don't fight over the cache.
 * The first writer wins; the second sees the unique-index conflict and skips.
 */
export async function storeIdempotencyResponse(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  key: string,
  requestHash: string,
  status: 'success' | 'error',
  body: Record<string, unknown>,
  scope: IdempotencyScope = 'mcp_tool'
): Promise<void> {
  const { error } = await supabase
    .from('idempotency_keys')
    .insert({
      user_id: userId,
      company_id: companyId,
      key,
      request_hash: requestHash,
      scope,
      response_status: status,
      response_body: body,
    })

  // Postgres 23505 is unique_violation: a concurrent retry already inserted.
  // Silently OK; the cached response from the winner will be returned to
  // both callers on subsequent reads.
  if (error && error.code !== '23505') {
    // Non-blocking: log but don't fail the operation. The caller already
    // succeeded; failing to persist the cache only weakens future retries.
    // eslint-disable-next-line no-console
    console.warn('[idempotency] failed to persist response:', error.message)
  }
}

/**
 * Sweep expired rows. Called by the cleanup cron.
 * Returns the number of deleted rows for logging.
 */
export async function cleanupExpiredIdempotencyKeys(
  supabase: SupabaseClient
): Promise<number> {
  const { error, count } = await supabase
    .from('idempotency_keys')
    .delete({ count: 'exact' })
    .lt('expires_at', new Date().toISOString())

  if (error) {
    throw new Error(`Idempotency cleanup failed: ${error.message}`)
  }
  return count ?? 0
}
