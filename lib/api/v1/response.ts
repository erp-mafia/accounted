/**
 * v1 REST response envelopes.
 *
 *   ok(data)                       → 200  { data, meta: { request_id, api_version } }
 *   paginated(data, next_cursor)   → 200  { data, meta: { request_id, api_version, next_cursor } }
 *   accepted(operationId, type)    → 202  { data: { operation_id, status, poll_url, webhook_event }, meta }
 *   created(data)                  → 201  same shape as ok
 *
 * Every helper stamps X-Request-Id + Gnubok-Version on the response and
 * accepts an optional `audit` block for write responses (per the architectural
 * decision in the plan that writes return their voucher_number / audit_url
 * inline so the agent doesn't need a second round-trip).
 */

import { NextResponse } from 'next/server'
import { API_V1_VERSION, API_V1_VERSION_HEADER } from './version'

export interface AuditBlock {
  voucher_number?: string
  voucher_url?: string
  audit_trail_url?: string
  immutable_at?: string
}

export interface ResponseMeta {
  request_id: string
  api_version: string
  next_cursor?: string
  audit?: AuditBlock
  /**
   * Names of `?expand=` keys whose underlying data fetch failed during a
   * soft-degraded response. Present only when at least one expansion was
   * requested AND failed. Agents that need transactional guarantees can
   * detect a degraded response without parsing the body.
   */
  partial_expansions?: string[]
  /**
   * Registry-coverage disclosure for list endpoints whose backing register
   * may not span all of the company's bookkeeping (e.g. the invoice
   * register after a mid-year migration). Shape is endpoint-specific and
   * documented in the endpoint's registry entry. Present only when the
   * endpoint computes it.
   */
  coverage?: Record<string, unknown>
}

interface ResponseOptions {
  requestId: string
  status?: number
  headers?: Record<string, string>
  audit?: AuditBlock
  /** Cursor for the *next* page; omitted when this is the last page. */
  nextCursor?: string
  /** Names of `?expand=` keys whose data fetch failed (soft-degrade). */
  partialExpansions?: string[]
  /** Endpoint-specific register-coverage disclosure (see ResponseMeta.coverage). */
  coverage?: Record<string, unknown>
  /** Marks the response as a replay of a previously-cached idempotent call. */
  idempotentReplay?: boolean
  /** Marks the response as a dry-run preview rather than a committed write. */
  dryRun?: boolean
  /** Rate-limit headers, when known. */
  rateLimit?: { limit: number; remaining: number; resetAt?: Date }
}

function applyStandardHeaders(res: NextResponse, opts: ResponseOptions): NextResponse {
  res.headers.set('X-Request-Id', opts.requestId)
  res.headers.set(API_V1_VERSION_HEADER, API_V1_VERSION)
  if (opts.idempotentReplay) res.headers.set('Idempotent-Replayed', 'true')
  if (opts.dryRun) res.headers.set('X-Dry-Run', 'true')
  if (opts.rateLimit) {
    res.headers.set('X-RateLimit-Limit', String(opts.rateLimit.limit))
    res.headers.set('X-RateLimit-Remaining', String(opts.rateLimit.remaining))
    if (opts.rateLimit.resetAt) {
      res.headers.set('X-RateLimit-Reset', String(Math.floor(opts.rateLimit.resetAt.getTime() / 1000)))
    }
  }
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      res.headers.set(k, v)
    }
  }
  return res
}

function buildMeta(opts: ResponseOptions): ResponseMeta {
  const meta: ResponseMeta = {
    request_id: opts.requestId,
    api_version: API_V1_VERSION,
  }
  if (opts.nextCursor) meta.next_cursor = opts.nextCursor
  if (opts.audit) meta.audit = opts.audit
  if (opts.coverage) meta.coverage = opts.coverage
  if (opts.partialExpansions && opts.partialExpansions.length > 0) {
    meta.partial_expansions = opts.partialExpansions
  }
  return meta
}

/**
 * 200 OK with `{ data, meta }`.
 */
export function ok<T>(data: T, opts: ResponseOptions): NextResponse {
  const res = NextResponse.json({ data, meta: buildMeta(opts) }, { status: opts.status ?? 200 })
  return applyStandardHeaders(res, opts)
}

/**
 * 200 OK with `{ data: T[], meta: { next_cursor } }`. Use for list endpoints.
 */
export function paginated<T>(data: T[], opts: ResponseOptions): NextResponse {
  const res = NextResponse.json({ data, meta: buildMeta(opts) }, { status: 200 })
  return applyStandardHeaders(res, opts)
}

/**
 * 201 Created. Mirror of ok() with status 201 for POST that creates a resource.
 */
export function created<T>(data: T, opts: ResponseOptions): NextResponse {
  return ok(data, { ...opts, status: 201 })
}

/**
 * 202 Accepted for async long-running operations. Returns the operation_id +
 * polling URL + the webhook event the caller can subscribe to for completion.
 */
export function accepted(
  operationId: string,
  operationType: string,
  opts: ResponseOptions,
): NextResponse {
  const data = {
    operation_id: operationId,
    type: operationType,
    status: 'queued' as const,
    poll_url: `/api/v1/operations/${operationId}`,
    webhook_event: 'operation.completed',
  }
  return ok(data, { ...opts, status: 202 })
}

/**
 * 204 No Content. Used for DELETE responses. No body.
 */
export function noContent(opts: ResponseOptions): NextResponse {
  const res = new NextResponse(null, { status: 204 })
  return applyStandardHeaders(res, opts)
}
