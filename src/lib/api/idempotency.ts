/**
 * Idempotency layer for agent-safe retries.
 *
 * Use case: an agent (MCP, automation webhook, scripted client) retries an
 * operation after a network blip. Without idempotency, the retry creates a
 * duplicate side-effect: two invoices, two journal entries, two emails.
 *
 * Contract:
 *   1. The caller supplies an `idempotency_key` per logical operation.
 *   2. Before the write runs, the server claims the key with a hash of the
 *      canonical request (claimIdempotencyKey: one locked SQL call,
 *      claim_idempotency_key).
 *   3. A finished first call with the same hash → its stored response is
 *      returned and nothing runs.
 *   4. A live row with a different hash → IdempotencyKeyReuseError (409).
 *   5. The same hash while the first call still runs →
 *      IdempotencyKeyInProgressError (409, retry after a moment). Without the
 *      claim both overlapping calls ran, which in a ledger is a second
 *      verifikat; a stateless MCP client resends on any broken stream, so
 *      overlapping repeats are ordinary.
 *   6. Otherwise the caller holds the claim and runs the write: on success
 *      claim.complete() stores the response, on a failure claim.release()
 *      gives the key back so a retry runs again (failures are never stored).
 *
 * A claim that is neither completed nor released (its request was killed)
 * is taken over by the next request with the key once it is older than
 * IDEMPOTENCY_CLAIM_TTL_SECONDS. If a claim cannot be made at all, the key is
 * looked up and the response stored after the write, as before claims
 * existed (lookupWithoutClaim).
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
import { createLogger } from '@/lib/logger'

const log = createLogger('idempotency')

/**
 * `company_create` marks a write that has no company until it runs (creating
 * one): its key is claimed per (user, scope) and the row is stored under the
 * company the write created, see IdempotencyClaimTarget.companyId.
 */
export type IdempotencyScope = 'mcp_tool' | 'api_route' | 'company_create'

/**
 * How long a claim holds its key before another request may take it over.
 * It must outlast the longest request that can hold one, or a slow first
 * call would be overtaken while it still runs: MCP is served by
 * /api/extensions/ext/[...path], whose maxDuration is 800 s (the Vercel Pro
 * ceiling with Fluid compute); v1 routes stop at 300 s (the platform
 * default). The platform kills a function at its max duration, so a claim
 * older than that belongs to a request that can no longer finish. 900 s is
 * 800 s plus a margin.
 */
export const IDEMPOTENCY_CLAIM_TTL_SECONDS = 900

/**
 * Retry-After for a key whose first call is still running. Most writes finish
 * within a second or two, after which the same request replays their answer.
 */
export const IDEMPOTENCY_IN_PROGRESS_RETRY_AFTER_SECONDS = 2

/** How long a stored response replays: 24 h, the table's default for an inserted row. */
const RESPONSE_TTL_MS = 24 * 60 * 60 * 1000

export class IdempotencyKeyReuseError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSE'
  constructor(public readonly key: string) {
    super(`Idempotency key "${key}" was previously used with a different request body. Use a fresh key or send the original request.`)
    this.name = 'IdempotencyKeyReuseError'
  }
}

/** The same key and request while the first call with them still runs. */
export class IdempotencyKeyInProgressError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_IN_PROGRESS'
  readonly retryAfterSeconds = IDEMPOTENCY_IN_PROGRESS_RETRY_AFTER_SECONDS
  constructor(public readonly key: string) {
    super(
      `A request with idempotency key "${key}" and the same payload is still running. ` +
        `Retry the same request in ${IDEMPOTENCY_IN_PROGRESS_RETRY_AFTER_SECONDS} s with the same key: ` +
        'once the first one has finished, the retry returns its answer without writing again.',
    )
    this.name = 'IdempotencyKeyInProgressError'
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

/** Who claims a key, for which write. */
export interface IdempotencyClaimTarget {
  userId: string
  /**
   * The company the write runs in. null only for scope 'company_create': a
   * company create has no company until it runs, so its key is claimed per
   * (user, scope) and complete() names the company it created.
   */
  companyId: string | null
  scope: IdempotencyScope
  key: string
  requestHash: string
}

/** A key this request holds: settle it exactly once, after the write ran. */
export interface IdempotencyClaim {
  /**
   * Store the response under the key: a repeat with the same request replays
   * it for 24 h. `companyId` is the company a company_create claim created.
   * Best-effort and never throws: the write already happened, and a failed
   * store only means a later repeat waits for the claim TTL and runs again.
   */
  complete(
    status: 'success' | 'error',
    body: Record<string, unknown>,
    options?: { companyId?: string },
  ): Promise<void>
  /**
   * Give the key back after a failure (an exception, a 5xx): a retry with the
   * same key runs again. Never throws; a claim it cannot delete frees itself
   * at the claim TTL.
   */
  release(): Promise<void>
}

export type IdempotencyClaimResult = { replay: IdempotencyHit } | { claim: IdempotencyClaim }

/**
 * Claim `key` before running the write it guards. One SQL call
 * (claim_idempotency_key) takes a lock on the key and decides:
 *   - a finished first call with the same request hash → `{ replay }`, run
 *     nothing;
 *   - a live row with another hash → IdempotencyKeyReuseError;
 *   - the same hash while the first call still runs →
 *     IdempotencyKeyInProgressError;
 *   - no live row (none, or one past its TTL: an abandoned claim, a response
 *     older than 24 h) → `{ claim }`: run the write, then complete or release.
 *
 * When the claim cannot be made (the call errors, the function is not there
 * yet because the deploy outran the migration, or it answers nothing usable)
 * this degrades to what every keyed write did before claims existed: look the
 * key up, and store the response after the write (lookupWithoutClaim). That
 * keeps every sequential retry safe; only the overlap guard is lost for as
 * long as the claim is unavailable, and it is logged as an alert.
 */
export async function claimIdempotencyKey(
  supabase: SupabaseClient,
  target: IdempotencyClaimTarget,
): Promise<IdempotencyClaimResult> {
  let answer: { outcome?: unknown; claim_id?: unknown; response_status?: unknown; response_body?: unknown } | null
  try {
    const { data, error } = await supabase.rpc('claim_idempotency_key', {
      p_user_id: target.userId,
      p_company_id: target.companyId,
      p_scope: target.scope,
      p_key: target.key,
      p_request_hash: target.requestHash,
      p_claim_ttl_seconds: IDEMPOTENCY_CLAIM_TTL_SECONDS,
    })
    if (error) throw error
    answer = (data ?? null) as typeof answer
  } catch (err) {
    log.warn('idempotency claim unavailable; looking the key up without a claim', {
      alert: true,
      scope: target.scope,
      code: (err as { code?: unknown } | null)?.code ?? null,
    })
    return lookupWithoutClaim(supabase, target)
  }

  switch (answer?.outcome) {
    case 'replay':
      return {
        replay: {
          status: answer.response_status === 'error' ? 'error' : 'success',
          body: (answer.response_body ?? {}) as Record<string, unknown>,
        },
      }
    case 'reuse':
      throw new IdempotencyKeyReuseError(target.key)
    case 'in_progress':
      throw new IdempotencyKeyInProgressError(target.key)
    case 'claimed':
      if (typeof answer.claim_id === 'string') return { claim: heldClaim(supabase, answer.claim_id) }
  }
  log.warn('idempotency claim answered nothing usable; looking the key up without a claim', {
    alert: true,
    scope: target.scope,
  })
  return lookupWithoutClaim(supabase, target)
}

/**
 * The key handled as before claims existed: a lookup now, the response
 * inserted after the write. Overlapping requests with the key can both run
 * here, which is why it is only the fallback for an unavailable claim.
 */
async function lookupWithoutClaim(
  supabase: SupabaseClient,
  target: IdempotencyClaimTarget,
): Promise<IdempotencyClaimResult> {
  const hit =
    target.companyId === null
      ? await checkUserScopedIdempotencyKey(supabase, target.userId, target.scope, target.key, target.requestHash)
      : await checkIdempotencyKey(supabase, target.userId, target.companyId, target.key, target.requestHash)
  if (hit) return { replay: hit }
  return {
    claim: {
      async complete(status, body, options = {}) {
        const companyId = options.companyId ?? target.companyId
        if (!companyId) return
        try {
          await storeIdempotencyResponse(
            supabase,
            target.userId,
            companyId,
            target.key,
            target.requestHash,
            status,
            body,
            target.scope,
          )
        } catch (err) {
          log.warn('failed to store the response of an unclaimed key', err as Error)
        }
      },
      // Nothing was claimed, so there is nothing to give back.
      async release() {},
    },
  }
}

function heldClaim(supabase: SupabaseClient, claimId: string): IdempotencyClaim {
  // Both settle only a row still in progress under this claim's id: a claim
  // overtaken after the TTL was deleted by the request that took the key, so
  // nothing here can overwrite that request's row.
  return {
    async complete(status, body, options = {}) {
      try {
        const { error } = await supabase
          .from('idempotency_keys')
          .update({
            state: 'completed',
            response_status: status,
            response_body: body,
            expires_at: new Date(Date.now() + RESPONSE_TTL_MS).toISOString(),
            // A literal property the schema guard can check; undefined is dropped
            // when the body is serialized, so no company_id is sent without one.
            company_id: options.companyId ?? undefined,
          })
          .eq('id', claimId)
          .eq('state', 'in_progress')
        if (error) log.warn('failed to store the response of a claimed key', { claimId, code: error.code })
      } catch (err) {
        log.warn('failed to store the response of a claimed key', err as Error, { claimId })
      }
    },
    async release() {
      try {
        const { error } = await supabase
          .from('idempotency_keys')
          .delete()
          .eq('id', claimId)
          .eq('state', 'in_progress')
        if (error) log.warn('failed to release a claimed key', { claimId, code: error.code })
      } catch (err) {
        log.warn('failed to release a claimed key', err as Error, { claimId })
      }
    },
  }
}

/**
 * Look up a key without claiming it: for a call that writes nothing (a v1
 * dry run), for MCP staging, which still stores after the fact (see
 * storeIdempotencyResponse), and when a claim cannot be made
 * (lookupWithoutClaim).
 *
 * Returns:
 *   - null when no live entry exists (caller should proceed)
 *   - the cached body when the key+hash match (caller should return it
 *     without side-effects)
 *
 * Throws IdempotencyKeyReuseError when the key exists with a *different*
 * request hash (the caller is misusing the key), and
 * IdempotencyKeyInProgressError for a claim with the same hash: that request
 * is still running and has no response to replay yet.
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
    .select('request_hash, response_status, response_body, expires_at, state')
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

  if (data.state === 'in_progress') {
    throw new IdempotencyKeyInProgressError(key)
  }

  return {
    status: data.response_status as 'success' | 'error',
    body: (data.response_body ?? {}) as Record<string, unknown>,
  }
}

/**
 * Look up a key for a write that has no company before it runs: creating a
 * company (POST /api/v1/companies, gnubok_create_company). A completed row
 * is stored under the company the write created, so the lookup is per
 * (user, scope, key). A key a user once spent on a company-scoped write never
 * matches here: the scope differs. Used when a company-create claim cannot be
 * made (lookupWithoutClaim).
 *
 * Same contract as checkIdempotencyKey: null on a miss (or an expired row),
 * the cached body on a match, IdempotencyKeyReuseError for a different hash,
 * IdempotencyKeyInProgressError for a claim with the same hash.
 */
export async function checkUserScopedIdempotencyKey(
  supabase: SupabaseClient,
  userId: string,
  scope: IdempotencyScope,
  key: string,
  requestHash: string
): Promise<IdempotencyHit | null> {
  const { data, error } = await supabase
    .from('idempotency_keys')
    .select('request_hash, response_status, response_body, expires_at, state')
    .eq('user_id', userId)
    .eq('scope', scope)
    .eq('key', key)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null

  if (data.request_hash !== requestHash) {
    throw new IdempotencyKeyReuseError(key)
  }

  if (data.state === 'in_progress') {
    throw new IdempotencyKeyInProgressError(key)
  }

  return {
    status: data.response_status as 'success' | 'error',
    body: (data.response_body ?? {}) as Record<string, unknown>,
  }
}

/**
 * Persist the response for an idempotency key after the write, without a
 * claim. Left for MCP staging (stagePendingOperation), where an overlapping
 * repeat stages a second pending operation that still needs its own
 * approval, and for a write whose claim could not be made
 * (lookupWithoutClaim); every other direct write claims first
 * (claimIdempotencyKey).
 * Best-effort: a duplicate-row race is swallowed so two concurrent retries
 * don't fight over the cache. The first writer wins; the second sees the
 * unique-index conflict and skips.
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
