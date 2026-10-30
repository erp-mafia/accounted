/**
 * v1 REST API wrapper.
 *
 * Every route under `app/api/v1/` is wrapped with `withApiV1('operation.name', handler)`.
 * The wrapper provides a single audit-friendly shape for the entire v1 surface:
 *
 *   1. Generates `requestId` (`req_<uuid>`) and a child logger bound to it.
 *   2. Extracts and validates the `Authorization: Bearer gnubok_sk_...` header
 *      via the existing `validateApiKey()` (atomic RPC, rate-limited).
 *   3. Resolves the required scope for the route from the v1 endpoint catalogue
 *      and returns INSUFFICIENT_SCOPE if the key lacks it. Public endpoints
 *      (`/health`, `/openapi.json`) skip the scope check but still validate
 *      the token when one is supplied. Authenticated endpoints (`/api-key`)
 *      require a valid token and skip the scope check.
 *   4. Reads typed handles (`je_...`, `cmp_...`, ./handles.ts) in the path,
 *      query and body as their UUIDs, refusing a wrong-type one with
 *      HANDLE_TYPE_MISMATCH, and stamps `handle` on the responses of the
 *      endpoints that declare their resource type. A typed path id that is
 *      not a UUID once handles are read is refused with VALIDATION_ERROR,
 *      never sent to Postgres (a malformed companyId before the company
 *      gate, any other after it).
 *   4b. When the URL contains `companyId`, verifies the API key's user has
 *      access to that company via `company_members`. Multi-company keys are
 *      supported transparently: the URL is the source of truth. A key with a
 *      company allowlist (api_key_companies) is additionally refused outside
 *      it, with the same NOT_FOUND a non-member company gets. A `viewer`
 *      (read-only) membership is refused for every write: mutating method
 *      or non-`:read` scope (FORBIDDEN, details.code ROLE_READ_ONLY). So is
 *      a company the key has read-only access to (FORBIDDEN, details.code
 *      CONNECTION_READ_ONLY). A report read (GET on a `reports.*` or
 *      `arsredovisning.*` operation) refuses a dimension filter its endpoint
 *      does not register (VALIDATION_ERROR) and names any other unregistered
 *      query parameter in `X-Ignored-Query-Params` (STRICT_REPORT_QUERY_PARAMS
 *      refuses those too). A route with no `companyId` in the URL that
 *      resolves a company from a resource row (`/operations/:id`,
 *      `/webhook-deliveries/:id/retry`) runs the SAME gate through
 *      `ctx.checkCompanyAccess(companyId)` before it reads or writes anything
 *      of that company.
 *   5. Resolves the dry-run flag (`?dry_run=true` query OR `X-Dry-Run` header)
 *      and the stage flag (`?stage=true`), refusing stage on an endpoint that
 *      does not stage (STAGE_NOT_SUPPORTED) and any value but true/false,
 *      and the `Preview-Token` header, refusing it (VALIDATION_ERROR) where
 *      the endpoint does not pin previews and when it is malformed.
 *   6. Resolves `Idempotency-Key` (header) and claims it before the write
 *      runs: a finished first call is replayed, the same key with another
 *      body is 409 IDEMPOTENCY_KEY_REUSE, and a repeat while the first call
 *      still runs is 409 IDEMPOTENCY_KEY_IN_PROGRESS with Retry-After. The
 *      dry-run flag is part of the cache identity and a dry run is never
 *      claimed or cached, so a simulation can never be replayed in place of
 *      the real write that follows it. Neither is a 409 PREVIEW_STALE.
 *   7. Invokes the handler with a typed RouteContext.
 *   8. Stamps `X-Request-Id` and `Gnubok-Version` on the response, plus
 *      `Retry-After` on a 429.
 *   9. Catches any thrown value and converts it to the v1 error envelope via
 *      `v1ErrorResponse`.
 *
 * Usage:
 *
 *   export const GET = withApiV1('companies.list', async (req, ctx) => {
 *     // ctx.requestId, ctx.log, ctx.user, ctx.companyId (when in URL),
 *     // ctx.supabase, ctx.scopes, ctx.mode, ctx.dryRun, ctx.idempotencyKey
 *     return ok({ companies: [...] }, { requestId: ctx.requestId })
 *   })
 */

import '@/lib/server-baseline'
import { type SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { truncateIp } from '@/lib/api/ip'
import {
  type ApiKeyMode,
  type ApiKeyScope,
  type ApiKeyServiceAccount,
  apiKeyCommitActor,
  createServiceClientNoCookies,
  extractBearerToken,
  hasScope,
  OAUTH_MCP_KEY_NAME,
  RATE_LIMIT_RETRY_AFTER_SECONDS,
  scopeKind,
  validateApiKey,
} from '@/lib/auth/api-keys'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { withSIEExternalReport } from '@/lib/import/sie-period-read'
import type { V1RequiredScope } from '@/lib/auth/scopes'
import { INVOICER_API_SCOPES, INVOICER_ROLE, roleAllowsScope } from '@/lib/auth/invoicer-role'
import { getMultiUserState, isMembershipDormant } from '@/lib/entitlements/multi-user'
import { getEndpointByConcretePath, getEndpointForOperation } from './registry'
import {
  assertReportQuery,
  IGNORED_QUERY_PARAMS_HEADER,
  isReportRead,
  registeredQueryParams,
  STRICT_REPORT_QUERY_PARAMS,
} from './report-period'
import {
  checkIdempotencyKey,
  claimIdempotencyKey,
  hashRequest,
  type IdempotencyClaim,
  type IdempotencyClaimTarget,
  type IdempotencyHit,
  IdempotencyKeyInProgressError,
  IdempotencyKeyReuseError,
} from '@/lib/api/idempotency'
import { startPackageForV1Endpoint } from '@/lib/modules/package-doors'
import { packageStartRefusal } from '@/lib/modules/package-gate'
import { createLogger, type Logger } from '@/lib/logger'
import { isPreviewToken, MALFORMED_PREVIEW_TOKEN_MESSAGE, PREVIEW_TOKEN_HEADER } from '@/lib/operations/preview-token'
import { v1ErrorResponse, v1ErrorResponseFromCode } from './errors'
import { handleDeclarationFor, malformedPathIds, normalizeV1Handles, withResponseHandles } from './handles'
import { WRAPPED_RESPONSE_HEADERS } from './security-headers'
import { API_V1_VERSION, API_V1_VERSION_HEADER } from './version'
import { v1EndpointDoor, type OperationLike } from '@/lib/permissions/doors'
import { agentShadow, type AgentShadowTarget, type TodayOutcome } from '@/lib/permissions/shadow'

const IDEMPOTENCY_HEADER = 'Idempotency-Key'
const DRY_RUN_HEADER = 'X-Dry-Run'
// Every state-changing method. PUT is included even though most v1 writes are
// POST/PATCH: the set drives THREE behaviors (test-key dry-run forcing,
// idempotency replay, requireIdempotencyKey enforcement), and omitting PUT
// would let test keys write through PUT routes for real.
const REQUIRES_IDEMPOTENCY = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
// RFC 9110 safe methods. The read-only role gate treats EVERYTHING else as a
// write: a superset of REQUIRES_IDEMPOTENCY, so an exotic method can never
// slip a viewer past the gate. Deliberately separate from REQUIRES_IDEMPOTENCY,
// whose semantics (replay, dry-run forcing) must not widen as a side effect.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** The read-only company role (see `CompanyRole` in `@/types`). */
const READ_ONLY_ROLE = 'viewer'

export interface ApiV1Context {
  /** Stable id for this HTTP request: appears in logs, error envelope, X-Request-Id. */
  requestId: string
  /** Logger pre-bound with { requestId, userId, companyId?, operation, apiKeyId? }. */
  log: Logger
  /** Authenticated user id. */
  userId: string
  /** API key id of the caller. Used for actor attribution on pending_operations / audit_log. */
  apiKeyId: string | undefined
  /** API key human name. */
  apiKeyName: string | undefined
  /**
   * The service account the calling key belongs to (lib/service-accounts), or
   * null for a person's key. For a service account `userId` is its sponsor:
   * RLS-shaped reads and the company gate run as the sponsor, and the key
   * reaches only the account's company (`allowedCompanyIds`).
   */
  serviceAccount: ApiKeyServiceAccount | null
  /**
   * WHO this request acts as in every record it writes: the commit-actor
   * scope the handler runs in (journal_entries.committed_actor_*, audit_log),
   * and what a staged operation or a rejection records. `service_account`
   * labelled with the account's name for a service account's key, else
   * `api_key` labelled with the key's name.
   */
  actor: CommitActor
  /** Scopes granted to the calling key. */
  scopes: ApiKeyScope[]
  /**
   * The key's company allowlist (api_key_companies): null when the key
   * reaches every company its user belongs to, else the only company ids it
   * may reach. The wrapper already refuses a URL companyId outside it; the
   * company-less routes (`/companies`, `/portfolio/*`) must filter their
   * own membership listings by it, and a company-less route that resolves a
   * company from a resource row goes through `checkCompanyAccess`.
   */
  allowedCompanyIds: string[] | null
  /**
   * Companies in the allowlist where the key may only read
   * (api_key_companies.access = 'read'), or null when there are none. The
   * wrapper already refuses a write there; exposed for the route that echoes
   * the key's grant (`GET /api-key`), which reads it through
   * `companyWriteRefusal`.
   */
  readOnlyCompanyIds: string[] | null
  /**
   * The company gate the wrapper runs for a URL `:companyId`, for a company
   * the handler resolved itself (from an operation or webhook delivery row):
   * membership, the key's company allowlist, the viewer role and per-company
   * read-only access (both refuse a write), and the multi-user seat gate.
   * Resolves to null when the caller may proceed, else to the error response
   * the handler must return as-is. The not-found answer (non-member, or a
   * company outside the allowlist) carries `notFoundDetails` only, never the
   * company id, so a foreign resource looks exactly like an unknown one.
   */
  checkCompanyAccess: (
    companyId: string,
    options?: { notFoundDetails?: Record<string, unknown> },
  ) => Promise<Response | null>
  /**
   * Largest amount in SEK this key may commit with no human approving it, or
   * null for no ceiling (the default, and what every key predating the column
   * has). It also rides on `actor`, which the handler runs under, so it binds
   * every door without the door reading it: the engine refuses any verifikat
   * above it, the attest service any attest above it
   * (lib/bookkeeping/unattended-ceiling.ts), and an operation write is priced
   * on its preview as its staged twin would be (lib/operations/v1.ts).
   */
  unattendedCommitLimit: number | null
  /**
   * test|live. Test keys are simulation-only: the wrapper forces `dryRun` on
   * for every write, so handlers never need to special-case `mode`; they just
   * honor `dryRun` as usual.
   */
  mode: ApiKeyMode
  /** Service-role Supabase client (no cookies). All queries MUST filter by company_id. */
  supabase: SupabaseClient
  /**
   * Resolved company id from the URL `:companyId` segment. Undefined for
   * routes that don't include the segment (`/companies`, `/operations/:id`,
   * `/health`); those that act on one company call `checkCompanyAccess`.
   */
  companyId?: string
  /**
   * Whether this request's caller may write the URL company at all: its
   * membership is not read-only (viewer) and the key's access to the company
   * is not read-only. The same two gates that refuse a write request above
   * the handler; exposed for a READ route that must decide whether a side
   * effect of the read may be persisted (it also needs the matching write
   * scope). It reflects the URL `:companyId` gate only: false when the route
   * has no `:companyId` segment, and it stays false there even after
   * `checkCompanyAccess` passes for a company resolved from a resource row.
   */
  companyWritable: boolean
  /** Resolved dry-run flag. Routes that mutate state must honor this. */
  dryRun: boolean
  /**
   * `?stage=true`: stage the write for approval instead of committing it.
   * Only ever true on an endpoint registered with `stageSupported` (an
   * operation write with a staging binding, served by v1OperationHandler):
   * the wrapper refuses the flag everywhere else, so a hand-written route
   * can never commit a request its caller sent to be staged.
   */
  stage: boolean
  /**
   * The `Preview-Token` header (lib/operations/preview-token.ts), or null.
   * Only ever set on an endpoint registered with `previewTokenSupported`
   * (an operation write, served by v1OperationHandler) and only in the
   * shape a dry run issues: the wrapper refuses it everywhere else, so a
   * hand-written write can never commit while ignoring the pin its caller
   * sent.
   */
  previewToken: string | null
  /** Resolved idempotency key, if supplied. */
  idempotencyKey: string | null
}

interface ApiV1Options {
  /** Override the required scope (e.g. for ad-hoc endpoints not in the catalogue). */
  requireScope?: ApiKeyScope
  /**
   * When true, idempotency is enforced: POST/PATCH/DELETE without an
   * `Idempotency-Key` header return 400. Default false; can be flipped on
   * per-route once the integrator audience is sophisticated enough.
   * Every v1 write sets it or is listed, with a reason, in
   * `__tests__/v1-write-idempotency.test.ts`.
   */
  requireIdempotencyKey?: boolean
  /**
   * The handler replays `Idempotency-Key` itself. The wrapper's cache is keyed
   * by the URL `:companyId`, so a route without one (`POST /companies`) gets
   * no replay from it; declaring this records that the handler covers it.
   */
  handlerIdempotency?: boolean
  /**
   * The handler writes nothing: a read that takes its input as a POST body
   * (an operation of kind 'read'). Recorded for the idempotency contract
   * test, which has nothing to ask of a read; changes no request handling.
   */
  readOnly?: boolean
  /**
   * The response carries a credential shown exactly once (a minted
   * service-account key). Idempotency-Key is then neither claimed nor
   * replayed, even when sent: a replay would need the plaintext stored in
   * idempotency_keys for a day, while an API key is otherwise stored only as
   * its SHA-256. A repeat mints a second key, visible and revocable. Such a
   * write is listed in KEY_OPTIONAL_WRITES (v1-write-idempotency.test.ts).
   */
  secretResponse?: boolean
  /**
   * The operation behind the endpoint (v1OperationHandler passes it), whose
   * door the permission shadow reads; a hand-written endpoint is classified
   * by its own registration.
   */
  doorOperation?: OperationLike
}

// Next.js 16 always passes `{ params: Promise<...> }` as the second arg.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type DynamicParams = { params: Promise<Record<string, string | string[]>> } | { params: Promise<{}> }

type V1Handler<P extends DynamicParams = { params: Promise<Record<string, never>> }> = (
  request: Request,
  ctx: ApiV1Context,
  params: P,
) => Promise<NextResponse | Response>

function generateRequestId(): string {
  return `req_${crypto.randomUUID()}`
}

/**
 * Anon-key Supabase client for the wrapper's public-scope code path. RLS is
 * enforced (no service-role privilege escalation) so even an accidental DB
 * call from a public handler is constrained to anon-accessible rows.
 *
 * Fails closed at first-call if the required env vars are missing: better
 * to surface the misconfiguration on the first request than silently 500
 * deeper in the handler.
 */
function createAnonClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error(
      '[api/v1] NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set to serve public-scope v1 endpoints',
    )
  }
  return createServiceRoleClient(url, key)
}

/**
 * Forensic identifiers for security event logs (failed auth, scope deny,
 * company-membership deny). We log a *truncated* source IP (last octet
 * dropped for IPv4, last 80 bits zeroed for IPv6) and user-agent so audit
 * trails can correlate suspicious patterns by network neighbourhood
 * without persisting full identifying IPs in the log store.
 *
 * Data minimisation: GDPR Art.5(1)(c) / Art.5(1)(f). Truncation preserves
 * the diagnostic value (city-level geolocation, ASN, abuse-pattern
 * correlation) while eliminating point-of-presence identification.
 *
 * Honors `x-forwarded-for` when set (Vercel / proxies); behind Vercel the
 * leftmost value is rewritten by the edge so we accept it as authoritative.
 */
export { truncateIp }

function extractForensicContext(request: Request, log: Logger): { ip: string | undefined; userAgent: string | undefined } {
  const fwd = request.headers.get('x-forwarded-for')
  const raw = fwd ? fwd.split(',')[0]?.trim() : request.headers.get('x-real-ip') ?? undefined
  const ip = truncateIp(raw || undefined)
  if (raw && !ip) {
    // x-forwarded-for / x-real-ip carried a non-empty payload we couldn't parse.
    // Surface as a warn so spoofed / unexpected proxy values are visible in
    // security monitoring instead of silently dropped. Never log the raw value:
    // that would defeat the truncation step.
    log.warn('unparseable forwarded-for header dropped', { headerLength: raw.length })
  }
  const userAgent = request.headers.get('user-agent') ?? undefined
  return { ip, userAgent }
}

function isDryRun(request: Request, url: URL): boolean {
  // Case-insensitive on BOTH surfaces. The header was always lowercased, but
  // the query flag used to require exactly 'true', so '?dry_run=True'
  // committed for real while the caller believed it previewed: the worst
  // possible parse of a preview flag. Any other value ('1', 'yes', 'false')
  // stays non-dry-run, unchanged.
  const queryVal = url.searchParams.get('dry_run')
  if (queryVal !== null && queryVal.toLowerCase() === 'true') return true
  const headerVal = request.headers.get(DRY_RUN_HEADER)
  if (headerVal && headerVal.toLowerCase() === 'true') return true
  return false
}

/**
 * `?stage=true` (any case): stage instead of commit. Strict, unlike
 * dry_run's "anything else commits": a misspelt staging flag must never
 * commit what its caller meant to stage, so only true and false are read and
 * anything else is refused (null). Absent is false.
 */
function parseStageFlag(url: URL): boolean | null {
  const raw = url.searchParams.get('stage')
  if (raw === null) return false
  const value = raw.toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

/**
 * Canonical idempotency hash for a v1 request.
 *
 * `dryRun` is part of the identity of the request. The documented commit flow
 * (see `dry-run.ts`) is "re-issue the exact same request without
 * `dry_run=true`, same Idempotency-Key", so a simulation and the real write
 * that follows it share method, path and body. Hashing only those three made
 * the two indistinguishable: the preview got cached under the commit's hash
 * and the commit replayed it, returning 200 with `{ dry_run: true, preview }`
 * while writing nothing.
 *
 * The flag is only added to the hashed object when it is TRUE, so an ordinary
 * (non-dry-run) write hashes byte-identically to previous releases. Idempotency
 * rows live for 24h; folding `dry_run: false` in unconditionally would make
 * every key in flight across this deploy fail the `request_hash` comparison and
 * answer a legitimate retry with IDEMPOTENCY_KEY_REUSE.
 *
 * Both the cache lookup and the cache store go through this function: if the
 * two hash inputs ever drift apart, a stored response can never be found
 * again, which is a subtler failure than the one this fixes.
 */
function buildRequestHash(input: {
  method: string
  path: string
  body: unknown
  dryRun: boolean
  /** ?stage=true: a staged write and a commit of the same body are different requests. */
  stage?: boolean
}): string {
  return hashRequest({
    method: input.method,
    path: input.path,
    body: input.body,
    ...(input.dryRun ? { dry_run: true } : {}),
    ...(input.stage ? { stage: true } : {}),
  })
}

/**
 * The wrapper's idempotency hash, for a handler that replays the key itself
 * (handlerIdempotency: a route with no `:companyId`). `body` is the parsed
 * JSON body, as the wrapper hashes it.
 */
export function v1RequestHash(request: Request, body: unknown, dryRun: boolean): string {
  return buildRequestHash({ method: request.method, path: new URL(request.url).pathname, body, dryRun })
}

/**
 * The answer to a replayed key, one shape for the wrapper and for the
 * handlers that replay themselves: the cached body, 200 for a cached success
 * (400 for a cached error) and `Idempotent-Replayed: true`.
 */
export function v1IdempotentReplay(hit: IdempotencyHit, requestId: string): Response {
  const replay = NextResponse.json(hit.body, { status: hit.status === 'success' ? 200 : 400 })
  replay.headers.set('Idempotent-Replayed', 'true')
  return stampHeaders(replay, requestId)
}

/**
 * The 409 for a key the request cannot run under, or null for any other
 * error: IDEMPOTENCY_KEY_REUSE (the key belongs to another body) or
 * IDEMPOTENCY_KEY_IN_PROGRESS (the same request is still running; retry it
 * after Retry-After, when it replays the first answer).
 */
async function v1IdempotencyRefusal(
  err: unknown,
  key: string,
  ctx: { requestId: string; log: Logger },
): Promise<Response | null> {
  if (err instanceof IdempotencyKeyReuseError) {
    ctx.log.warn('idempotency key reused with different body')
    return v1ErrorResponseFromCode('IDEMPOTENCY_KEY_REUSE', ctx.log, { requestId: ctx.requestId, details: { key } })
  }
  if (err instanceof IdempotencyKeyInProgressError) {
    ctx.log.warn('idempotency key in progress')
    return v1ErrorResponseFromCode('IDEMPOTENCY_KEY_IN_PROGRESS', ctx.log, {
      requestId: ctx.requestId,
      details: { key },
      retryAfterSeconds: err.retryAfterSeconds,
    })
  }
  return null
}

/**
 * Claim `Idempotency-Key` before a v1 write runs, one shape for the wrapper
 * and the handlers that replay the key themselves (handlerIdempotency).
 * Answers the claim to settle once the write has run (complete() with the
 * response, or release() on a failure), or the response that ends the
 * request: the replay of a finished first call, or a 409 (see
 * v1IdempotencyRefusal).
 */
export async function claimV1IdempotencyKey(
  supabase: SupabaseClient,
  target: IdempotencyClaimTarget,
  ctx: { requestId: string; log: Logger },
): Promise<{ claim: IdempotencyClaim } | { response: Response }> {
  try {
    const outcome = await claimIdempotencyKey(supabase, target)
    if ('claim' in outcome) return outcome
    ctx.log.info('idempotent replay', { idempotencyKey: target.key })
    return { response: v1IdempotentReplay(outcome.replay, ctx.requestId) }
  } catch (err) {
    const refusal = await v1IdempotencyRefusal(err, target.key, ctx)
    if (refusal) return { response: refusal }
    throw err
  }
}

/**
 * A multipart body as the hash sees it: each part by name, a text part by its
 * value, a file part by its name, type, size and SHA-256. Never the raw text:
 * a client picks a fresh random boundary for every request it encodes, so a
 * resent upload never matched the first one byte for byte and the documented
 * retry (same key, same request) answered IDEMPOTENCY_KEY_REUSE instead of
 * replaying. Parts are ordered by name (a stable sort, so repeated names keep
 * their order).
 */
async function multipartForHash(form: FormData): Promise<{ multipart: Array<[string, unknown]> }> {
  const parts: Array<[string, unknown]> = []
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      parts.push([name, value])
      continue
    }
    const digest = await crypto.subtle.digest('SHA-256', await value.arrayBuffer())
    const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    parts.push([name, { file_name: value.name, type: value.type, size: value.size, sha256 }])
  }
  parts.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return { multipart: parts }
}

async function readBodyForHash(request: Request): Promise<{ body: unknown; cloned: Request }> {
  // We need the body to hash it, but the handler also needs it. Read from a
  // CLONE for the hash and pass the original through to the handler: that
  // way the handler's `await request.json()` still works regardless of how
  // the runtime implements stream teeing.
  if (/^multipart\/form-data/i.test(request.headers.get('content-type') ?? '')) {
    try {
      return { body: await multipartForHash(await request.clone().formData()), cloned: request }
    } catch {
      // Not parseable as multipart: hash the raw text as before; the handler
      // refuses the body itself.
    }
  }
  const reader = request.clone()
  const text = await reader.text()
  if (!text) return { body: null, cloned: request }
  try {
    return { body: JSON.parse(text), cloned: request }
  } catch {
    return { body: text, cloned: request }
  }
}

/** Why the company gate refuses a write in a company the key reaches. */
export type CompanyWriteRefusal = 'ROLE_READ_ONLY' | 'CONNECTION_READ_ONLY'

/**
 * The two read-only gates of the company gate, as one verdict: the role gate
 * (a viewer membership) first, then the key's read-only access to the
 * company. Null when neither applies and a write may proceed. The gate below
 * and `GET /api-key` both read it, so the grant a key is shown and the one it
 * is held to cannot drift apart.
 */
export function companyWriteRefusal(
  membershipRole: string | undefined,
  companyId: string,
  readOnlyCompanyIds: string[] | null,
): CompanyWriteRefusal | null {
  if (membershipRole === READ_ONLY_ROLE) return 'ROLE_READ_ONLY'
  const target = companyId.toLowerCase()
  if (readOnlyCompanyIds?.some((id) => id.toLowerCase() === target)) return 'CONNECTION_READ_ONLY'
  return null
}

interface CompanyGateInput {
  supabase: SupabaseClient
  userId: string
  allowedCompanyIds: string[] | null
  readOnlyCompanyIds: string[] | null
  method: string
  requiredScope: V1RequiredScope
  requestId: string
  log: Logger
  forensic: { ip: string | undefined; userAgent: string | undefined }
}

/**
 * The gate's verdict. `denied` is the error response to return as-is, or null
 * when the caller may proceed. `writable` is true only on a pass where the
 * membership is not read-only (viewer) and the key's access to the company is
 * not read-only, the two gates that refuse a write request; it is always
 * false on a refusal.
 */
type CompanyGateResult =
  | { denied: Response; writable: false; role?: string; permissionRefusal?: string }
  | { denied: null; writable: boolean; role?: string }

/**
 * `facts` names a refusal of the role or the key's access (what the
 * permission shadow compares decide() with) and the role it read.
 */
function refuse(denied: Response, facts?: { role?: string; permissionRefusal?: string }): CompanyGateResult {
  return { denied, writable: false, ...facts }
}

/**
 * The company gate of the v1 surface: one function for a company named in
 * the URL and for one a company-less route resolved from a resource row, so
 * the two doors cannot drift apart. Resolves to `{ denied: null, writable }`
 * when the caller may proceed, else to `{ denied: <error response> }` to
 * return as-is.
 *
 * `notFoundDetails` is the whole `details` of the NOT_FOUND answer. The URL
 * door echoes the companyId the caller sent; a resource door passes what an
 * unknown id of its own gets, so a resource of an unreachable company is
 * indistinguishable from one that does not exist.
 */
async function checkCompanyAccessGate(
  input: CompanyGateInput,
  companyId: string,
  notFoundDetails: Record<string, unknown> | undefined,
): Promise<CompanyGateResult> {
  const { supabase, log, requestId, forensic, method, requiredScope } = input

  const { data: membership, error: membershipErr } = await supabase
    .from('company_members')
    .select('company_id, role')
    .eq('user_id', input.userId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (membershipErr) {
    log.error('failed to resolve company membership', membershipErr as Error)
    return refuse(await v1ErrorResponseFromCode('INTERNAL_ERROR', log, { requestId }))
  }

  if (!membership) {
    log.warn('user is not a member of the requested company', { companyId, ...forensic })
    // 404 (not 403) so we don't leak company existence to unauthorized callers.
    return refuse(await v1ErrorResponseFromCode('NOT_FOUND', log, {
      requestId,
      ...(notFoundDetails ? { details: notFoundDetails } : {}),
    }))
  }

  // Per-key company allowlist (api_key_companies): a member company the
  // key was not issued for is answered exactly like a non-member one, so
  // the allowlist reveals nothing membership would not. Checked after
  // the membership row so the two denials share one shape, and before
  // the role and seat gates so a refused company costs no extra read.
  if (
    input.allowedCompanyIds &&
    !input.allowedCompanyIds.some((id) => id.toLowerCase() === companyId.toLowerCase())
  ) {
    log.warn('requested company is outside the key allowlist', { companyId, ...forensic })
    return refuse(await v1ErrorResponseFromCode('NOT_FOUND', log, {
      requestId,
      ...(notFoundDetails ? { details: notFoundDetails } : {}),
    }))
  }

  const membershipRole = (membership as { role?: string }).role

  // The invoicing-only role (lib/auth/invoicer-role.ts) reaches customers,
  // invoices and articles, whatever scopes the key holds: this surface runs
  // as the service role, so this is the only gate between an invoicer's key
  // and the rest of the books. Read or write, a door outside those scopes is
  // refused. After the membership and allowlist answers, so a non-member
  // sees exactly what it saw before.
  if (!roleAllowsScope(membershipRole, requiredScope)) {
    log.warn('invoicer membership refused outside its scopes', {
      companyId,
      method,
      requiredScope,
      ...forensic,
    })
    return refuse(await v1ErrorResponseFromCode('FORBIDDEN', log, {
      requestId,
      status: 403,
      reason: 'role_scope_limited',
      details: {
        code: 'ROLE_SCOPE_LIMITED',
        companyId,
        role: INVOICER_ROLE,
        required_scope: requiredScope,
        allowed_scopes: INVOICER_API_SCOPES,
        message:
          'This company membership has the Invoicing role: only customers, invoices (quotes and orders included) and articles are reachable. Ask a company owner or admin to change the role.',
      },
    }), { role: membershipRole, permissionRefusal: 'ROLE_SCOPE_LIMITED' })
  }

  const isWrite =
    !SAFE_METHODS.has(method) ||
    (requiredScope !== 'authenticated' && scopeKind(requiredScope) === 'write')
  const writeRefusal = companyWriteRefusal(membershipRole, companyId, input.readOnlyCompanyIds)
  const roleReadOnly = writeRefusal === 'ROLE_READ_ONLY'
  const connectionReadOnly = writeRefusal === 'CONNECTION_READ_ONLY'

  // Read-only role gate. Cookie routes enforce the viewer role through
  // withRouteContext({ requireWrite }) and the DB enforces it through
  // RLS + triggers for cookie sessions, but this surface runs as the
  // service role: nothing below this line would stop a viewer's key from
  // posting. A request is a write when EITHER its method is unsafe
  // (catches action verbs whatever their scope) OR its scope is an
  // elevated grant (catches reads-by-method that still manage tenant
  // state, e.g. GET /webhooks on webhooks:manage). Dry-run and test
  // keys are refused too: a viewer has no write to simulate.
  //
  // Placed AFTER the membership 404 so a non-member sees exactly what it
  // saw before (no new company-existence signal), and BEFORE the seat
  // gate so a refused write costs no extra read.
  if (roleReadOnly && isWrite) {
    log.warn('read-only membership refused write request', {
      companyId,
      method,
      requiredScope,
      ...forensic,
    })
    return refuse(await v1ErrorResponseFromCode('FORBIDDEN', log, {
      requestId,
      status: 403,
      reason: 'role_read_only',
      details: {
        code: 'ROLE_READ_ONLY',
        companyId,
        role: READ_ONLY_ROLE,
        required_scope: requiredScope,
        message:
          'This company membership is read-only (viewer): write requests are refused. Ask a company owner or admin to change the role.',
      },
    }), { role: membershipRole, permissionRefusal: 'ROLE_READ_ONLY' })
  }

  // Read-only connection gate: the key reaches this company but was
  // given read-only access to it (api_key_companies.access = 'read',
  // migration 20260928112724). Same write test as the role gate above,
  // and after it, so a viewer keeps the answer that names the role.
  if (connectionReadOnly && isWrite) {
    log.warn('read-only company access refused write request', {
      companyId,
      method,
      requiredScope,
      ...forensic,
    })
    return refuse(await v1ErrorResponseFromCode('FORBIDDEN', log, {
      requestId,
      status: 403,
      reason: 'connection_read_only',
      details: {
        code: 'CONNECTION_READ_ONLY',
        companyId,
        required_scope: requiredScope,
        message:
          'This API key has read-only access to this company: write requests are refused. Give the key write access to the company under Settings > API & MCP.',
      },
    }), { role: membershipRole, permissionRefusal: 'CONNECTION_READ_ONLY' })
  }

  // Multi-user seat gate: the API-key surface is a chokepoint like the
  // cookie routes and MCP. A non-owner membership in a frozen company
  // (multi_user lapsed past its 20-day grace) is refused here so an old
  // key cannot keep working the books after the freeze. Owners pass
  // without the extra read; the service client sees team-scoped grants.
  if (membershipRole !== 'owner') {
    const access = await getMultiUserState(supabase, companyId)
    if (isMembershipDormant(membershipRole as string, access.state)) {
      log.warn('multi-user seat gate refused frozen membership', { companyId, ...forensic })
      return refuse(await v1ErrorResponseFromCode('FORBIDDEN', log, {
        requestId,
        status: 403,
        reason: 'multi_user_frozen',
        details: {
          companyId,
          capability: 'multi_user',
          message: 'Company is paused for this account: multiple users require a paid plan. Ask the company owner to upgrade.',
        },
      }))
    }
  }

  return { denied: null, writable: !roleReadOnly && !connectionReadOnly, role: membershipRole }
}

/**
 * Wrap a v1 route handler with auth, scope, idempotency, dry-run, request-id,
 * logging, and v1 error envelope handling.
 *
 * `operation` is a stable identifier for logs ('companies.list', 'invoices.create'...).
 */
export function withApiV1<P extends DynamicParams = { params: Promise<Record<string, never>> }>(
  operation: string,
  handler: V1Handler<P>,
  options: ApiV1Options = {},
): (request: Request, params: P) => Promise<Response> {
  const wrapped = async function wrapped(request: Request, params: P): Promise<Response> {
    const requestId = generateRequestId()
    const start = Date.now()
    const log = createLogger(`api/v1/${operation}`, { requestId, operation })

    const url = new URL(request.url)
    const path = url.pathname
    const forensic = extractForensicContext(request, log)
    // The Idempotency-Key claim this request holds until it is settled.
    let heldClaim: IdempotencyClaim | null = null
    // The permission shadow's report of the handler's outcome (lib/permissions/
    // shadow.ts), armed right before the handler runs, fired once.
    let settleShadow: ((status: number) => void) | null = null

    try {
      // 1. Determine required scope before auth, from the route's own
      //    endpoint definition. Public endpoints skip authentication. A
      //    handler whose route never registered fails closed: NOT_FOUND
      //    for every caller, never an unscoped run.
      const endpoint = getEndpointForOperation(operation, request.method)
      const requiredScope =
        options.requireScope ?? (endpoint === undefined ? null : endpoint.scope === null ? 'public' : endpoint.scope)

      if (requiredScope === null) {
        log.warn('endpoint not registered', { path, method: request.method, ...forensic })
        return await v1ErrorResponseFromCode('NOT_FOUND', log, {
          requestId,
          details: { path, method: request.method },
        })
      }

      // 2. Public endpoints: invoke handler with an anon context. If a Bearer
      //    token IS supplied we opportunistically validate it so rate-limiting
      //    and key attribution are applied, but a missing or invalid token
      //    does NOT block the request (the route is, by definition, public).
      //    Falling back to the anon client when unauthenticated keeps the
      //    least-privilege guarantee: an accidental DB call from a public
      //    handler hits RLS, not the service role.
      if (requiredScope === 'public') {
        const token = extractBearerToken(request)
        let publicCtx: ApiV1Context = {
          requestId,
          log,
          userId: 'anonymous',
          apiKeyId: undefined,
          apiKeyName: undefined,
          serviceAccount: null,
          actor: { type: 'api_key', label: 'Anonymous' },
          scopes: [],
          allowedCompanyIds: null,
          readOnlyCompanyIds: null,
          // A public endpoint has no company to open: fail closed.
          checkCompanyAccess: (_companyId, options) =>
            v1ErrorResponseFromCode('NOT_FOUND', log, {
              requestId,
              ...(options?.notFoundDetails ? { details: options.notFoundDetails } : {}),
            }),
          unattendedCommitLimit: null,
          mode: 'live',
          supabase: createAnonClient(),
          companyWritable: false,
          dryRun: false,
          stage: false,
          previewToken: null,
          idempotencyKey: null,
        }
        if (token) {
          const auth = await validateApiKey(token)
          if (!('error' in auth)) {
            publicCtx = {
              ...publicCtx,
              log: log.child({ userId: auth.userId, apiKeyId: auth.apiKeyId, mode: auth.mode }),
              userId: auth.userId,
              apiKeyId: auth.apiKeyId,
              apiKeyName: auth.apiKeyName,
              serviceAccount: auth.serviceAccount,
              actor: apiKeyCommitActor(auth),
              scopes: auth.scopes,
              allowedCompanyIds: auth.allowedCompanyIds,
              readOnlyCompanyIds: auth.readOnlyCompanyIds,
              unattendedCommitLimit: auth.unattendedCommitLimit,
              mode: auth.mode,
              supabase: createServiceClientNoCookies(),
            }
          }
          // Invalid token on a public route is silently downgraded to anon:
          // do not surface 401 since the route doesn't require auth at all.
        }
        const response = await handler(request, publicCtx, params)
        return stampHeaders(response, requestId)
      }

      // 3. Authenticate via Bearer token.
      const token = extractBearerToken(request)
      if (!token) {
        log.warn('missing bearer token', forensic)
        return await v1ErrorResponseFromCode('UNAUTHORIZED', log, { requestId })
      }

      const auth = await validateApiKey(token)
      if ('error' in auth) {
        log.warn('api key validation failed', { status: auth.status, reason: auth.error, ...forensic })
        const rateLimited = auth.status === 429
        // A coded refusal (a paused agent, a suspended service account)
        // answers its own structured error; everything else is the bare 401
        // or 429.
        const code = auth.code ?? (rateLimited ? 'RATE_LIMITED' : 'UNAUTHORIZED')
        return await v1ErrorResponseFromCode(code, log, {
          requestId,
          reason: auth.error,
          ...(rateLimited ? { retryAfterSeconds: RATE_LIMIT_RETRY_AFTER_SECONDS } : {}),
        })
      }

      const userLog = log.child({
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        mode: auth.mode,
        ...(auth.serviceAccount ? { serviceAccountId: auth.serviceAccount.id } : {}),
      })

      // The permission shadow: decide() beside the role and access gates
      // below, told what they did. It reads nothing and changes nothing. A
      // missing scope is not compared: scope checks stay at the wire and
      // decide() runs behind them.
      const recordShadow = agentShadow({
        door: `v1:${operation}`,
        method: request.method,
        userId: auth.userId,
        key: {
          kind: auth.serviceAccount
            ? 'service_account'
            : auth.client || auth.apiKeyName === OAUTH_MCP_KEY_NAME
              ? 'oauth'
              : 'manual',
          scopes: auth.scopes,
          apiKeyId: auth.apiKeyId ?? null,
          agentIdentityId: auth.agentIdentityId ?? null,
        },
        doorRule: () => (endpoint ? v1EndpointDoor(endpoint, options.doorOperation) : null),
      })
      const shadowAccess = (companyId: string): AgentShadowTarget['companyAccess'] =>
        auth.readOnlyCompanyIds?.some((id) => id.toLowerCase() === companyId.toLowerCase()) ? 'read' : 'write'

      // 4. Scope check. An 'authenticated' route needs the valid key above
      //    and no particular scope.
      if (requiredScope !== 'authenticated' && !hasScope(auth.scopes, requiredScope)) {
        userLog.warn('insufficient scope', {
          required: requiredScope,
          granted: auth.scopes,
          ...forensic,
        })
        return await v1ErrorResponseFromCode('INSUFFICIENT_SCOPE', userLog, {
          requestId,
          details: { required_scope: requiredScope, granted_scopes: auth.scopes },
        })
      }

      // 5. Resolve URL companyId and verify access.
      //
      // Next.js 16 invokes a route handler with `{ params: undefined }` for a
      // STATIC route (no `[segment]` in the path): see app-route module.js
      // `handlerContext = { params: context.params ? ... : undefined }`. The
      // only authenticated static route on this surface is `/api/v1/companies`,
      // so awaiting `params.params` blindly null-derefs there (`undefined` has
      // no `.companyId`) and the catch below turns it into a 500 for every
      // valid key. Dynamic routes still pass a real `Promise<{ companyId }>`.
      // Guard the await and default to an empty param set.
      const rawParams = ((await params?.params) ?? {}) as Record<
        string,
        string | string[] | undefined
      >

      // 5a. Typed handles (./handles.ts): a je_/inv_/cmp_... handle in the
      //     path, the query string or the body becomes its plain UUID
      //     here, so the company gate, the idempotency hash and every
      //     handler see the id they always saw. A handle of the wrong type
      //     is refused before anything is read. A request without handles
      //     passes on as the same Request with the same params.
      const handles = await normalizeV1Handles(request, rawParams)
      if (!handles.ok) {
        userLog.warn('handle type mismatch', { fields: handles.mismatches.map((m) => m.field) })
        return await v1ErrorResponseFromCode('HANDLE_TYPE_MISMATCH', userLog, {
          requestId,
          details: { issues: handles.mismatches },
        })
      }
      const resolvedParams = handles.params
      const handlerRequest = handles.request
      const handlerParams = handles.changed
        ? ({ ...params, params: Promise.resolve(resolvedParams) } as unknown as P)
        : params
      const rawCompanyId = resolvedParams.companyId
      const companyId = typeof rawCompanyId === 'string' ? rawCompanyId : undefined

      // 5a'. Typed path ids. A typed path parameter (companies/:companyId,
      //      invoices/:id, ...) names a uuid column, so a value that is not a
      //      UUID once handles are read (an OpenAPI placeholder such as
      //      "string", a truncated id) names nothing. It used to reach
      //      Postgres, which refused it with 22P02, and the company gate
      //      answered that as a logged 500. It is the 400 VALIDATION_ERROR a
      //      malformed id gets across this surface (and on MCP). A malformed
      //      companyId is refused before the gate: there is no company to look
      //      up. Any other after it, so a company the key cannot see still
      //      answers 404, never 400. The details carry the flat { field,
      //      message } the routes' own id checks answer and the issues list.
      const malformedIds = malformedPathIds(endpoint?.path, resolvedParams)
      const refuseMalformedIds = async () => {
        userLog.warn('malformed path id', { fields: malformedIds.map((issue) => issue.field) })
        return v1ErrorResponseFromCode('VALIDATION_ERROR', userLog, {
          requestId,
          details: { ...malformedIds[0], issues: malformedIds },
        })
      }
      if (malformedIds.some((issue) => issue.field === 'companyId')) return await refuseMalformedIds()

      const supabase = createServiceClientNoCookies()
      let companyWritable = false

      const companyGate: CompanyGateInput = {
        supabase,
        userId: auth.userId,
        allowedCompanyIds: auth.allowedCompanyIds,
        readOnlyCompanyIds: auth.readOnlyCompanyIds,
        method: request.method,
        requiredScope,
        requestId,
        log: userLog,
        forensic,
      }

      let shadowRole: string | undefined
      if (companyId !== undefined) {
        const gate = await checkCompanyAccessGate(companyGate, companyId, { companyId })
        if (gate.denied) {
          if (gate.permissionRefusal) {
            recordShadow(
              { outcome: 'deny', code: gate.permissionRefusal, by: 'gate' },
              { companyId, role: gate.role ?? null, companyAccess: shadowAccess(companyId) },
            )
          }
          return gate.denied
        }
        companyWritable = gate.writable
        shadowRole = gate.role
      }
      if (malformedIds.length > 0) return await refuseMalformedIds()

      // 5b. Report query gate. A report dropped any parameter it did not
      //     read, so ?dim_no=6&dim_code=P001 on the trial balance answered
      //     the whole company's report to a caller who believed it filtered.
      //     A dimension filter the report does not register is now refused
      //     (400); any other stray parameter is served and named in
      //     X-Ignored-Query-Params, unless STRICT_REPORT_QUERY_PARAMS refuses
      //     it too. The registered query is what the spec publishes and, per
      //     query-params-registered.test.ts, what the route reads, so the
      //     allowlist cannot drift from the parser. After the access gates,
      //     so a company the key cannot see still answers 404, never 400.
      let ignoredQueryParams: string[] = []
      if (isReportRead(request.method, operation)) {
        const registered = registeredQueryParams(getEndpointByConcretePath(request.method, path))
        if (registered) {
          const gate = await assertReportQuery(request, registered, { requestId, log: userLog }, {
            strict: STRICT_REPORT_QUERY_PARAMS,
          })
          // Stamped like a handler's answer: the routes that refused in
          // their handler before sent the wrapped security headers too.
          if (!gate.ok) return stampHeaders(gate.response, requestId)
          ignoredQueryParams = gate.ignored
          if (ignoredQueryParams.length > 0) {
            // Names only (values can be personal data): which parameters
            // integrations send is the evidence the strict switch waits for.
            userLog.info('report read ignored unregistered query params', { ignored_params: ignoredQueryParams })
          }
        }
      }

      // 5c. Stage flag. `?stage=true` turns an operation write into a pending
      //     operation for approval (v1OperationHandler). Refused on every
      //     endpoint that does not stage, reads included: a hand-written
      //     write would otherwise ignore the flag and commit what its caller
      //     sent to be staged. After the access gates, so a company the key
      //     cannot see still answers 404, never 400.
      const stage = parseStageFlag(url)
      if (stage === null) {
        return await v1ErrorResponseFromCode('VALIDATION_ERROR', userLog, {
          requestId,
          details: { issues: [{ field: 'stage', message: 'stage must be true or false.' }] },
        })
      }
      if (stage && !endpoint?.stageSupported) {
        userLog.warn('stage requested on an endpoint that does not stage', { path, method: request.method })
        return await v1ErrorResponseFromCode('STAGE_NOT_SUPPORTED', userLog, {
          requestId,
          details: { path, method: request.method },
        })
      }

      // 5d. Preview-Token. A pin the endpoint cannot check is refused, never
      //     ignored: a hand-written write would otherwise commit whatever the
      //     current state produces while its caller believes the preview it
      //     showed is pinned. An empty or malformed value is refused too, so
      //     a templated header that lost its value never commits unpinned.
      const previewTokenHeader = request.headers.get(PREVIEW_TOKEN_HEADER)
      if (previewTokenHeader !== null) {
        const refusal = !endpoint?.previewTokenSupported
          ? 'This endpoint does not accept a preview token: only writes marked x-preview-token-supported in the OpenAPI spec do. Send the request without the header.'
          : !isPreviewToken(previewTokenHeader.trim())
            ? MALFORMED_PREVIEW_TOKEN_MESSAGE
            : null
        if (refusal) {
          userLog.warn('preview token refused', { path, method: request.method })
          return await v1ErrorResponseFromCode('VALIDATION_ERROR', userLog, {
            requestId,
            details: { issues: [{ field: PREVIEW_TOKEN_HEADER, message: refusal }] },
          })
        }
      }
      const previewToken = previewTokenHeader === null ? null : previewTokenHeader.trim()

      // 6. Idempotency. Mandatory for state-changing methods when the route
      //    opts in (or when an Idempotency-Key header is supplied).
      const idempotencyKey = request.headers.get(IDEMPOTENCY_HEADER)
      const isMutation = REQUIRES_IDEMPOTENCY.has(request.method)

      // Test keys are simulation-only: every write is forced to dry-run so
      // nothing persists (the credential bakes in `?dry_run=true`). A mutating
      // endpoint that can't be simulated (dryRunSupported=false, or unregistered)
      // would otherwise write for real: block it outright so a test key can
      // never touch real data. Reads pass through unchanged (real data, no write).
      let forceDryRun = false
      if (auth.mode === 'test' && isMutation) {
        const endpoint = getEndpointByConcretePath(request.method, path)
        if (!endpoint || !endpoint.dryRunSupported) {
          userLog.warn('test key blocked from non-simulatable endpoint', {
            path,
            method: request.method,
            ...forensic,
          })
          return await v1ErrorResponseFromCode('TEST_KEY_WRITE_BLOCKED', userLog, {
            requestId,
            details: { path, method: request.method },
          })
        }
        forceDryRun = true
      }

      if (options.requireIdempotencyKey && isMutation && !idempotencyKey) {
        userLog.warn('missing idempotency key on mutating request')
        return await v1ErrorResponseFromCode('VALIDATION_ERROR', userLog, {
          requestId,
          details: {
            issues: [{ field: IDEMPOTENCY_HEADER, message: 'Idempotency-Key header is required for write requests.' }],
          },
        })
      }

      // 6b. Package start gate. A write that starts new work in a package
      //     (lib/modules/package-doors.ts: a new invoice, salary run, expense
      //     claim, till connection, ...) refuses while the company has that
      //     package switched off or winding down; settling what is open never
      //     does. Before the idempotency claim, so a refusal holds no key.
      if (isMutation && companyId && endpoint) {
        const startPackage = startPackageForV1Endpoint(endpoint)
        if (startPackage) {
          const refusal = await packageStartRefusal(supabase, companyId, startPackage)
          if (refusal) {
            userLog.info('package start refused', { packageId: refusal.packageId })
            return await v1ErrorResponseFromCode(refusal.code, userLog, {
              requestId,
              details: refusal.details,
              messageSv: refusal.messageSv,
              messageEn: refusal.messageEn,
            })
          }
        }
      }

      // 7. Dry-run resolution. Test keys force it on regardless of the flag.
      //    Resolved BEFORE the idempotency lookup because it feeds the request
      //    hash: a preview and its follow-up commit must never share a cache
      //    entry.
      const dryRun = isDryRun(request, url) || forceDryRun

      // 8. If idempotency-key supplied, claim it before the write runs. A
      //    dry run writes nothing, so it claims nothing: it only looks the
      //    key up (a finished call with another body is still key reuse).
      let workingRequest = handlerRequest
      if (idempotencyKey && isMutation && companyId && !options.secretResponse) {
        const { body, cloned } = await readBodyForHash(handlerRequest)
        workingRequest = cloned
        // The handle-free path and body: a retry that spells an id as a
        // handle is the same request as one that sends the UUID.
        const reqHash = buildRequestHash({ method: request.method, path: handles.path, body, dryRun, stage })
        if (dryRun) {
          try {
            const hit = await checkIdempotencyKey(supabase, auth.userId, companyId, idempotencyKey, reqHash)
            if (hit) {
              userLog.info('idempotent replay', { idempotencyKey })
              return v1IdempotentReplay(hit, requestId)
            }
          } catch (err) {
            const refusal = await v1IdempotencyRefusal(err, idempotencyKey, { requestId, log: userLog })
            if (refusal) return refusal
            throw err
          }
        } else {
          const claimed = await claimV1IdempotencyKey(
            supabase,
            { userId: auth.userId, companyId, scope: 'api_route', key: idempotencyKey, requestHash: reqHash },
            { requestId, log: userLog },
          )
          if ('response' in claimed) return claimed.response
          heldClaim = claimed.claim
        }
      }

      const ctx: ApiV1Context = {
        requestId,
        log: userLog.child({ companyId }),
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        apiKeyName: auth.apiKeyName,
        serviceAccount: auth.serviceAccount,
        actor: apiKeyCommitActor(auth),
        scopes: auth.scopes,
        allowedCompanyIds: auth.allowedCompanyIds,
        readOnlyCompanyIds: auth.readOnlyCompanyIds,
        // A resource door gets the refusal only: ctx.companyWritable stays
        // the URL `:companyId` verdict (false on a company-less route).
        checkCompanyAccess: async (resolvedCompanyId, options) =>
          (await checkCompanyAccessGate(companyGate, resolvedCompanyId, options?.notFoundDetails))
            .denied,
        unattendedCommitLimit: auth.unattendedCommitLimit,
        mode: auth.mode,
        supabase,
        companyId,
        companyWritable,
        dryRun,
        stage,
        previewToken,
        idempotencyKey,
      }

      // 9. Invoke handler, inside the commit-actor scope.
      //
      // commitEntry() reads getActor() as its fallback and forwards it to the
      // commit_journal_entry RPC, which stamps journal_entries.committed_actor_*
      // and the audit_log COMMIT row (migration 20260619120000). Wrapping here
      // rather than threading a parameter means EVERY v1 write is attributed,
      // including the ones that reach the ledger through a helper several
      // frames down (reverseEntry, correctEntry, the supplier-invoice paths).
      //
      // Before this, runWithActor had exactly ONE production call site, the
      // pending-operations commit. Everything committing outside that path was
      // anonymous: on production, 99.8% of storno entries and 100% of
      // correction entries carried no actor at all, which are precisely the two
      // sanctioned rättelse paths under BFL 5 kap. 5 § and the place where
      // "who did this, and when" is a legal question rather than a nicety.
      //
      // `api_key` is the honest label for this surface: a gnubok_sk_ bearer
      // token. A service account's key acts as `service_account`, labelled
      // with the account's name (its sponsor is the user the rows carry). The
      // OAuth/MCP surfaces set their own actor and are unaffected.
      //
      // The same scope carries the key's unattended ceiling, for the same
      // reason: every door that posts (categorize, batch-categorize, mark-paid,
      // a storno, ...) is bound by it in the engine, including a door added
      // later that never heard of it (#125).
      if (companyId !== undefined) {
        const shadowCompanyId = companyId
        settleShadow = (status) => {
          const today: TodayOutcome =
            status === 403
              ? { outcome: 'deny', code: 'HANDLER_FORBIDDEN', by: 'handler' }
              : { outcome: stage ? 'stage' : 'allow', dryRun }
          recordShadow(today, {
            companyId: shadowCompanyId,
            role: shadowRole ?? null,
            companyAccess: shadowAccess(shadowCompanyId),
          })
        }
      }
      let response: Response = await runWithActor(
        ctx.actor,
        () => withSIEExternalReport(supabase,companyId,operation,()=>handler(workingRequest,ctx,handlerParams)),
      )

      // 9b. Typed handles on the way out: the endpoints in V1_HANDLE_COVERAGE
      //     gain `handle` next to their resource's id (./handles.ts). Before
      //     the claim settles, so a replay answers the same body. A dry run
      //     or a staging answers a preview, not the resource: left alone.
      const handleDecl = handleDeclarationFor(operation)
      if (handleDecl && !dryRun && !stage) {
        response = await withResponseHandles(response, handleDecl)
      }

      // Signal test mode on every test-key response so integrators can see the
      // request was simulation-only without inspecting the body.
      if (ctx.mode === 'test') {
        response.headers.set('X-Gnubok-Mode', 'test')
      }

      // A served report names the parameters it did not apply. Only on a
      // success: a route that refuses them itself (the four with their own
      // allowlist) must not also say it ignored them.
      if (ignoredQueryParams.length > 0 && response.status < 400) {
        response.headers.set(IGNORED_QUERY_PARAMS_HEADER, ignoredQueryParams.join(', '))
      }

      // 10. Settle the claim: store the response (best-effort), or give the
      //     key back so a retry runs again.
      //
      //     A dry run never holds a claim: its response describes a write that
      //     did not happen, and caching it under a real Idempotency-Key is
      //     exactly how the documented "preview, then commit with the same
      //     key" flow used to lose the commit.
      //
      //     A 5xx is released: a failure is never cached. So is a 429: a
      //     throttle says "not now", and replaying it under the same key would
      //     turn a 15-minute cooldown into the cache's 24-hour TTL (the
      //     documented retry is "same request after Retry-After", which is
      //     exactly a same-key retry).
      //
      //     So is a 409 PREVIEW_STALE: it says "not in this state", wrote
      //     nothing, and its documented retry is the same request and key
      //     with the fresh preview token, which a cached refusal would
      //     answer forever (the token is a header, not part of the hash).
      if (heldClaim) {
        const claim = heldClaim
        heldClaim = null
        if (response.status < 500 && response.status !== 429 && !(await isPreviewStaleResponse(response))) {
          const body = await response.clone().json().catch(() => ({}))
          await claim.complete(response.status >= 400 ? 'error' : 'success', body as Record<string, unknown>)
        } else {
          await claim.release()
        }
      }

      settleShadow?.(response.status)
      settleShadow = null

      ctx.log.info('op completed', {
        durationMs: Date.now() - start,
        status: response.status,
        dryRun,
      })

      return stampHeaders(response, requestId)
    } catch (err) {
      // A thrown failure wrote nothing to replay: give the key back.
      if (heldClaim) await heldClaim.release()
      // Resolve the envelope first so the log level can follow the mapped
      // status — thrown 4xx domain errors are expected outcomes (warn), only
      // 5xx are runtime errors. v1ErrorResponse logs the error itself at the
      // same threshold.
      const response = await v1ErrorResponse(err, log, { requestId })
      settleShadow?.(response.status)
      const meta = { durationMs: Date.now() - start, status: response.status }
      if (response.status < 500) log.warn('op failed', err as Error, meta)
      else log.error('op failed', err as Error, meta)
      return response
    }
  }
  return Object.assign(wrapped, {
    [V1_HANDLER_CONTRACT]: {
      operation,
      requireIdempotencyKey: options.requireIdempotencyKey === true,
      handlerIdempotency: options.handlerIdempotency === true,
      readOnly: options.readOnly === true,
    } satisfies V1HandlerContract,
  })
}

const V1_HANDLER_CONTRACT = Symbol.for('accounted.api.v1.handler-contract')

/**
 * What a withApiV1 handler was declared with, as far as retries go. Read by
 * the idempotency contract test (`__tests__/v1-write-idempotency.test.ts`),
 * which fails a v1 write that neither requires `Idempotency-Key` nor is
 * listed there with a reason. Undefined for anything withApiV1 did not wrap.
 */
export interface V1HandlerContract {
  operation: string
  requireIdempotencyKey: boolean
  /** The handler replays the key itself (a route with no `:companyId`). */
  handlerIdempotency: boolean
  /** The handler writes nothing (a read taking a POST body). */
  readOnly: boolean
}

export function v1HandlerContract(handler: unknown): V1HandlerContract | undefined {
  if (typeof handler !== 'function') return undefined
  return (handler as unknown as Record<symbol, V1HandlerContract | undefined>)[V1_HANDLER_CONTRACT]
}

/** A 409 PREVIEW_STALE (lib/operations/preview-token.ts): it wrote nothing and is never cached. */
async function isPreviewStaleResponse(response: Response): Promise<boolean> {
  if (response.status !== 409) return false
  const body = (await response.clone().json().catch(() => null)) as { error?: { code?: unknown } } | null
  return body?.error?.code === 'PREVIEW_STALE'
}

function stampHeaders(response: Response, requestId: string): Response {
  if (!response.headers.get('X-Request-Id')) response.headers.set('X-Request-Id', requestId)
  if (!response.headers.get(API_V1_VERSION_HEADER)) {
    response.headers.set(API_V1_VERSION_HEADER, API_V1_VERSION)
  }
  // Apply security headers to every wrapped v1 response: same set as the
  // public discovery routes PLUS X-Robots-Tag noai so authenticated payloads
  // are excluded from AI training sets (Claude, ChatGPT, Perplexity, Google
  // -Extended respect this; others won't).
  for (const [k, v] of Object.entries(WRAPPED_RESPONSE_HEADERS)) {
    if (!response.headers.get(k)) response.headers.set(k, v)
  }
  return response
}
