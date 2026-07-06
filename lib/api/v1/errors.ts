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
import { getErrorEntry } from '@/lib/errors/structured-errors'
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

/**
 * Quick check: does this code map to a registered entry? Used by callers that
 * want to validate a code before throwing it (e.g. registry-driven dispatch).
 */
export function isRegisteredV1Code(code: string): boolean {
  return getErrorEntry(code) !== undefined
}
