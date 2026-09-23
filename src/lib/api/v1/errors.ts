/**
 * v1 REST error envelope.
 *
 * Wraps the existing structured-error machinery (lib/errors/get-structured-error)
 * into the v1-specific shape that agents consume:
 *
 *   {
 *     error: {
 *       code:               machine-readable, stable forever
 *       message:            Swedish prose
 *       message_en:         English prose (agents prefer this)
 *       details:            structured context (pgCode, field issues, period_id...)
 *       recovery_hint:      natural-language next step the agent can act on
 *       docs_url:           canonical error-doc URL
 *       valid_alternatives: hints like { unlock_endpoint, next_open_period, ...}
 *       request_id:         correlation id, echoed in X-Request-Id header
 *     }
 *   }
 *
 * The first three fields exist on the legacy `getStructuredError` output.
 * `recovery_hint`, `docs_url`, `valid_alternatives` are additive: derived from
 * the registry's `remediation` block (when present) plus a per-code doc-URL
 * derivation rule.
 */

import { NextResponse } from 'next/server'
import {
  errorResponse as legacyErrorResponse,
  errorResponseFromCode as legacyErrorResponseFromCode,
} from '@/lib/errors/get-structured-error'
import type { Logger } from '@/lib/logger'
import { API_V1_VERSION, API_V1_VERSION_HEADER } from './version'

const DOCS_BASE = process.env.NEXT_PUBLIC_APP_URL
  ? `${process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/docs/api/errors`
  : '/docs/api/errors'

export interface V1ErrorBody {
  error: {
    code: string
    message: string
    message_en?: string
    details?: unknown
    recovery_hint?: string
    docs_url?: string
    valid_alternatives?: Record<string, unknown>
    request_id?: string
  }
}

export interface V1ErrorContext {
  requestId: string
  /** Extra structured context for the agent (period_id, customer_id, ...). */
  details?: unknown
  /** Override the http status from the registry entry. */
  status?: number
  /** Agent-actionable next-step suggestions: { unlock_endpoint, next_open_period }. */
  validAlternatives?: Record<string, unknown>
  /**
   * Seconds to advertise in `Retry-After`. Set on retryable throttles so an
   * unattended client can pace itself instead of backing off blindly.
   */
  retryAfterSeconds?: number
}

function docsUrlFor(code: string): string {
  return `${DOCS_BASE}/${code}`
}

/**
 * Transform a legacy error envelope from `errorResponse()` into the v1 shape.
 *
 * The legacy shape is:
 *   { error: { code, message, message_en?, remediation?, requestId?, details? } }
 *
 * v1 needs:
 *   { error: { code, message, message_en?, details?, recovery_hint?, docs_url, valid_alternatives?, request_id? } }
 *
 * The remediation.description becomes recovery_hint; docs_url is derived from
 * the code; valid_alternatives is passed through unchanged.
 */
async function rewriteEnvelope(
  legacyResponse: NextResponse,
  ctx: V1ErrorContext,
): Promise<NextResponse> {
  const status = ctx.status ?? legacyResponse.status
  const body = (await legacyResponse.json().catch(() => null)) as
    | { error: { code: string; message: string; message_en?: string; remediation?: { description?: string }; details?: unknown } }
    | null

  if (!body?.error) {
    // Should never happen: legacyErrorResponse always returns the envelope.
    const fallback: V1ErrorBody = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Ett oväntat serverfel uppstod. Försök igen senare.',
        message_en: 'Internal server error.',
        docs_url: docsUrlFor('INTERNAL_ERROR'),
        request_id: ctx.requestId,
      },
    }
    return finalize(NextResponse.json(fallback, { status }), ctx)
  }

  const { code, message, message_en, remediation, details } = body.error

  const v1Body: V1ErrorBody = {
    error: {
      code,
      message,
      ...(message_en ? { message_en } : {}),
      ...(details !== undefined ? { details } : {}),
      ...(remediation?.description ? { recovery_hint: remediation.description } : {}),
      docs_url: docsUrlFor(code),
      ...(ctx.validAlternatives ? { valid_alternatives: ctx.validAlternatives } : {}),
      request_id: ctx.requestId,
    },
  }

  return finalize(NextResponse.json(v1Body, { status }), ctx)
}

function finalize(res: NextResponse, ctx: V1ErrorContext): NextResponse {
  res.headers.set('X-Request-Id', ctx.requestId)
  res.headers.set(API_V1_VERSION_HEADER, API_V1_VERSION)
  // The published skill tells agents to honor Retry-After on a 429. Until
  // this landed, /api/v1 never sent one, so that instruction pointed at a
  // header that did not exist.
  if (ctx.retryAfterSeconds !== undefined) {
    res.headers.set('Retry-After', String(ctx.retryAfterSeconds))
  }
  return res
}

/**
 * v1 error response from a thrown value. Dispatches through the legacy
 * machinery for code resolution, then rewrites into the v1 shape.
 *
 * Always logs the underlying error; never throws.
 */
export async function v1ErrorResponse(
  err: unknown,
  log: Logger,
  ctx: V1ErrorContext,
): Promise<NextResponse> {
  const legacy = legacyErrorResponse(err, log, {
    requestId: ctx.requestId,
    details: ctx.details,
    status: ctx.status,
  })
  return rewriteEnvelope(legacy, ctx)
}

/**
 * v1 error response from a known code (no thrown value involved).
 *
 * Use this when the route already knows the failure mode:
 *
 *   return v1ErrorResponseFromCode('PERIOD_LOCKED', log, {
 *     requestId: ctx.requestId,
 *     details: { period_id, locked_at },
 *     validAlternatives: { unlock_endpoint: '/v1/.../fiscal-periods/:id:unlock' },
 *   })
 */
export async function v1ErrorResponseFromCode(
  code: string,
  log: Logger,
  ctx: V1ErrorContext & { reason?: string },
): Promise<NextResponse> {
  const legacy = legacyErrorResponseFromCode(code, log, {
    requestId: ctx.requestId,
    details: ctx.details,
    status: ctx.status,
    reason: ctx.reason,
  })
  return rewriteEnvelope(legacy, ctx)
}

/** Minimal slice of the v1 route context the validation helpers need. */
export interface V1ValidationContext {
  requestId: string
  log: Logger
}

/** Structural view of a ZodError: enough to render the v1 issues list. */
export interface V1ZodErrorLike {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>
}

/**
 * Map Zod issues into the `{ field, message }` list the v1 envelope carries
 * under `details.issues`.
 */
export function v1ZodIssues(err: V1ZodErrorLike): Array<{ field: string; message: string }> {
  return err.issues.map((i) => ({
    field: i.path.join('.'),
    message: i.message,
  }))
}

/**
 * VALIDATION_ERROR envelope for a failed Zod parse:
 *
 *   const parsed = Schema.safeParse(rawBody)
 *   if (!parsed.success) return v1ValidationError(ctx, parsed.error)
 */
export async function v1ValidationError(
  ctx: V1ValidationContext,
  err: V1ZodErrorLike,
): Promise<NextResponse> {
  return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
    requestId: ctx.requestId,
    details: {
      issues: v1ZodIssues(err),
    },
  })
}
