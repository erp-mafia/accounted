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
 *      the token when one is supplied.
 *   4. When the URL contains `companyId`, verifies the API key's user has
 *      access to that company via `company_members`. Multi-company keys are
 *      supported transparently — the URL is the source of truth.
 *   5. Resolves `Idempotency-Key` (header) and replays cached responses.
 *   6. Resolves the dry-run flag (`?dry_run=true` query OR `X-Dry-Run` header).
 *   7. Invokes the handler with a typed RouteContext.
 *   8. Stamps `X-Request-Id`, `Gnubok-Version`, `X-RateLimit-Limit` on the
 *      response.
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

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import {
  type ApiKeyMode,
  type ApiKeyScope,
  createServiceClientNoCookies,
  extractBearerToken,
  hasScope,
  validateApiKey,
} from '@/lib/auth/api-keys'

// Per CLAUDE.md: any route that emits events via eventBus must call
// ensureInitialized() at module level to wire extension event handlers
// (email, cloud-backup, push-notifications, etc.). Calling it here in the
// wrapper guarantees every v1 route gets the init at import time — a single
// source of truth so future routes can't forget. The function itself is
// idempotent (guarded by a module-level boolean).
ensureInitialized()
import { resolveRequiredScope } from '@/lib/auth/scopes'
import { getEndpointByConcretePath } from './registry'
import {
  checkIdempotencyKey,
  hashRequest,
  IdempotencyKeyReuseError,
  storeIdempotencyResponse,
} from '@/lib/api/idempotency'
import { createLogger, type Logger } from '@/lib/logger'
import { v1ErrorResponse, v1ErrorResponseFromCode } from './errors'
import { WRAPPED_RESPONSE_HEADERS } from './security-headers'
import { API_V1_VERSION, API_V1_VERSION_HEADER } from './version'

const IDEMPOTENCY_HEADER = 'Idempotency-Key'
const DRY_RUN_HEADER = 'X-Dry-Run'
const REQUIRES_IDEMPOTENCY = new Set(['POST', 'PATCH', 'DELETE'])

export interface ApiV1Context {
  /** Stable id for this HTTP request — appears in logs, error envelope, X-Request-Id. */
  requestId: string
  /** Logger pre-bound with { requestId, userId, companyId?, operation, apiKeyId? }. */
  log: Logger
  /** Authenticated user id. */
  userId: string
  /** API key id of the caller. Used for actor attribution on pending_operations / audit_log. */
  apiKeyId: string | undefined
  /** API key human name. */
  apiKeyName: string | undefined
  /** Scopes granted to the calling key. */
  scopes: ApiKeyScope[]
  /**
   * test|live. Test keys are simulation-only — the wrapper forces `dryRun` on
   * for every write, so handlers never need to special-case `mode`; they just
   * honor `dryRun` as usual.
   */
  mode: ApiKeyMode
  /** Service-role Supabase client (no cookies). All queries MUST filter by company_id. */
  supabase: SupabaseClient
  /**
   * Resolved company id from the URL `:companyId` segment. Undefined for
   * routes that don't include the segment (`/companies`, `/operations/:id`,
   * `/health`).
   */
  companyId?: string
  /** Resolved dry-run flag. Routes that mutate state must honor this. */
  dryRun: boolean
  /** Resolved idempotency key, if supplied. */
  idempotencyKey: string | null
}

interface ApiV1Options {
  /** Override the required scope (e.g. for ad-hoc endpoints not in the catalogue). */
  requireScope?: ApiKeyScope
  /**
   * When true, idempotency is enforced — POST/PATCH/DELETE without an
   * `Idempotency-Key` header return 400. Default false; can be flipped on
   * per-route once the integrator audience is sophisticated enough.
   */
  requireIdempotencyKey?: boolean
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
 * Fails closed at first-call if the required env vars are missing — better
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
  return createClient(url, key)
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
export function truncateIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined
  // IPv4: validate octets are 0-255, then drop last octet → "203.0.113.0/24".
  // Out-of-range octets indicate a spoofed or malformed header; refuse to
  // log a pseudo-IP that would pollute abuse-pattern analysis.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (v4) {
    const octets = [v4[1], v4[2], v4[3], v4[4]].map((s) => Number.parseInt(s, 10))
    if (octets.every((o) => o >= 0 && o <= 255)) {
      return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`
    }
    return undefined
  }
  // IPv6: keep first 3 hextets → "2001:db8:abc::/48"
  const v6 = /^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):/i.exec(ip)
  if (v6) return `${v6[1]}::/48`
  return undefined
}

function extractForensicContext(request: Request, log: Logger): { ip: string | undefined; userAgent: string | undefined } {
  const fwd = request.headers.get('x-forwarded-for')
  const raw = fwd ? fwd.split(',')[0]?.trim() : request.headers.get('x-real-ip') ?? undefined
  const ip = truncateIp(raw || undefined)
  if (raw && !ip) {
    // x-forwarded-for / x-real-ip carried a non-empty payload we couldn't parse.
    // Surface as a warn so spoofed / unexpected proxy values are visible in
    // security monitoring instead of silently dropped. Never log the raw value
    // — that would defeat the truncation step.
    log.warn('unparseable forwarded-for header dropped', { headerLength: raw.length })
  }
  const userAgent = request.headers.get('user-agent') ?? undefined
  return { ip, userAgent }
}

function isDryRun(request: Request, url: URL): boolean {
  if (url.searchParams.get('dry_run') === 'true') return true
  const headerVal = request.headers.get(DRY_RUN_HEADER)
  if (headerVal && headerVal.toLowerCase() === 'true') return true
  return false
}

async function readBodyForHash(request: Request): Promise<{ body: unknown; cloned: Request }> {
  // We need the body to hash it, but the handler also needs it. Read from a
  // CLONE for the hash and pass the original through to the handler — that
  // way the handler's `await request.json()` still works regardless of how
  // the runtime implements stream teeing.
  const reader = request.clone()
  const text = await reader.text()
  if (!text) return { body: null, cloned: request }
  try {
    return { body: JSON.parse(text), cloned: request }
  } catch {
    return { body: text, cloned: request }
  }
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
  return async function wrapped(request: Request, params: P): Promise<Response> {
    const requestId = generateRequestId()
    const start = Date.now()
    const log = createLogger(`api/v1/${operation}`, { requestId, operation })

    const url = new URL(request.url)
    const path = url.pathname
    const forensic = extractForensicContext(request, log)

    try {
      // 1. Determine required scope before auth. Public endpoints can skip
      //    authentication entirely.
      const requiredScope = options.requireScope ?? resolveRequiredScope(request.method, path)

      if (requiredScope === null) {
        log.warn('endpoint not registered', { path, method: request.method, ...forensic })
        return await v1ErrorResponseFromCode('NOT_FOUND', log, {
          requestId,
          details: { path, method: request.method },
        })
      }

      // 2. Public endpoints: invoke handler with an anon context. If a Bearer
      //    token IS supplied we opportunistically validate it so rate-limiting
      //    and key attribution are applied — but a missing or invalid token
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
          scopes: [],
          mode: 'live',
          supabase: createAnonClient(),
          dryRun: false,
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
              scopes: auth.scopes,
              mode: auth.mode,
              supabase: createServiceClientNoCookies(),
            }
          }
          // Invalid token on a public route is silently downgraded to anon —
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
        const code = auth.status === 429 ? 'RATE_LIMITED' : 'UNAUTHORIZED'
        return await v1ErrorResponseFromCode(code, log, { requestId, reason: auth.error })
      }

      const userLog = log.child({
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        mode: auth.mode,
      })

      // 4. Scope check.
      if (!hasScope(auth.scopes, requiredScope)) {
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
      // STATIC route (no `[segment]` in the path) — see app-route module.js
      // `handlerContext = { params: context.params ? ... : undefined }`. The
      // only authenticated static route on this surface is `/api/v1/companies`,
      // so awaiting `params.params` blindly null-derefs there (`undefined` has
      // no `.companyId`) and the catch below turns it into a 500 for every
      // valid key. Dynamic routes still pass a real `Promise<{ companyId }>`.
      // Guard the await and default to an empty param set.
      const resolvedParams = ((await params?.params) ?? {}) as Record<
        string,
        string | string[] | undefined
      >
      const rawCompanyId = resolvedParams.companyId
      const companyId = typeof rawCompanyId === 'string' ? rawCompanyId : undefined

      const supabase = createServiceClientNoCookies()

      if (companyId !== undefined) {
        const { data: membership, error: membershipErr } = await supabase
          .from('company_members')
          .select('company_id, role')
          .eq('user_id', auth.userId)
          .eq('company_id', companyId)
          .maybeSingle()

        if (membershipErr) {
          userLog.error('failed to resolve company membership', membershipErr as Error)
          return await v1ErrorResponseFromCode('INTERNAL_ERROR', userLog, { requestId })
        }

        if (!membership) {
          userLog.warn('user is not a member of company in URL', { companyId, ...forensic })
          // 404 (not 403) so we don't leak company existence to unauthorized callers.
          return await v1ErrorResponseFromCode('NOT_FOUND', userLog, {
            requestId,
            details: { companyId },
          })
        }
      }

      // 6. Idempotency. Mandatory for state-changing methods when the route
      //    opts in (or when an Idempotency-Key header is supplied).
      const idempotencyKey = request.headers.get(IDEMPOTENCY_HEADER)
      const isMutation = REQUIRES_IDEMPOTENCY.has(request.method)

      // Test keys are simulation-only: every write is forced to dry-run so
      // nothing persists (the credential bakes in `?dry_run=true`). A mutating
      // endpoint that can't be simulated (dryRunSupported=false, or unregistered)
      // would otherwise write for real — block it outright so a test key can
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

      // 7. If idempotency-key supplied, check for cached response.
      let bodyForHash: unknown = null
      let workingRequest = request
      if (idempotencyKey && isMutation && companyId) {
        const { body, cloned } = await readBodyForHash(request)
        bodyForHash = body
        workingRequest = cloned
        const reqHash = hashRequest({ method: request.method, path, body })
        try {
          const hit = await checkIdempotencyKey(supabase, auth.userId, companyId, idempotencyKey, reqHash)
          if (hit) {
            userLog.info('idempotent replay', { idempotencyKey })
            const replay = NextResponse.json(hit.body, { status: hit.status === 'success' ? 200 : 400 })
            replay.headers.set('Idempotent-Replayed', 'true')
            return stampHeaders(replay, requestId)
          }
        } catch (err) {
          if (err instanceof IdempotencyKeyReuseError) {
            userLog.warn('idempotency key reused with different body')
            return await v1ErrorResponseFromCode('IDEMPOTENCY_KEY_REUSE', userLog, {
              requestId,
              details: { key: idempotencyKey },
            })
          }
          throw err
        }
      }

      // 8. Dry-run resolution. Test keys force it on regardless of the flag.
      const dryRun = isDryRun(workingRequest, url) || forceDryRun

      const ctx: ApiV1Context = {
        requestId,
        log: userLog.child({ companyId }),
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        apiKeyName: auth.apiKeyName,
        scopes: auth.scopes,
        mode: auth.mode,
        supabase,
        companyId,
        dryRun,
        idempotencyKey,
      }

      // 9. Invoke handler.
      const response = await handler(workingRequest, ctx, params)

      // Signal test mode on every test-key response so integrators can see the
      // request was simulation-only without inspecting the body.
      if (ctx.mode === 'test') {
        response.headers.set('X-Gnubok-Mode', 'test')
      }

      // 10. Persist idempotency cache (best-effort).
      if (idempotencyKey && isMutation && companyId && response.status < 500) {
        try {
          const body = await response.clone().json().catch(() => ({}))
          const reqHash = hashRequest({ method: request.method, path, body: bodyForHash })
          const status: 'success' | 'error' = response.status >= 400 ? 'error' : 'success'
          await storeIdempotencyResponse(
            supabase,
            auth.userId,
            companyId,
            idempotencyKey,
            reqHash,
            status,
            body as Record<string, unknown>,
            'api_route',
          )
        } catch (err) {
          userLog.warn('failed to persist idempotency response', err as Error)
        }
      }

      ctx.log.info('op completed', {
        durationMs: Date.now() - start,
        status: response.status,
        dryRun,
      })

      return stampHeaders(response, requestId)
    } catch (err) {
      log.error('op failed', err as Error, { durationMs: Date.now() - start })
      return await v1ErrorResponse(err, log, { requestId })
    }
  }
}

function stampHeaders(response: Response, requestId: string): Response {
  if (!response.headers.get('X-Request-Id')) response.headers.set('X-Request-Id', requestId)
  if (!response.headers.get(API_V1_VERSION_HEADER)) {
    response.headers.set(API_V1_VERSION_HEADER, API_V1_VERSION)
  }
  // Apply security headers to every wrapped v1 response — same set as the
  // public discovery routes PLUS X-Robots-Tag noai so authenticated payloads
  // are excluded from AI training sets (Claude, ChatGPT, Perplexity, Google
  // -Extended respect this; others won't).
  for (const [k, v] of Object.entries(WRAPPED_RESPONSE_HEADERS)) {
    if (!response.headers.get(k)) response.headers.set(k, v)
  }
  return response
}
