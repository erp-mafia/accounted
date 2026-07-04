/**
 * Structured error shape designed for agents (MCP, automation) that need to
 * dispatch on error programmatically rather than read the Swedish prose.
 *
 * Key design decisions:
 *   - code is machine-readable and stable; agents pattern-match on it
 *   - message_sv is the existing UI string from getErrorMessage()
 *   - message_en gives the agent a translation it can act on without parsing
 *     Swedish tokens
 *   - remediation, when present, points the agent at a tool/args/resource
 *     that fixes the problem. Optional: only set when there's a clear
 *     mechanical next step
 *
 * Both MCP and REST consume this. errorResponse() below produces the standard
 * REST envelope so a single registry covers every entry point.
 */
import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { getErrorMessage } from './get-error-message'
import {
  getErrorEntry,
  type StructuredErrorEntry,
  type StructuredErrorRemediation,
} from './structured-errors'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  CannotCorrectNonPostedError,
  CannotReverseNonPostedError,
  CannotReverseStornoError,
  DimensionValidationError,
  EntryAlreadyReversedError,
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  InvalidMappingResultError,
  JournalEntryNotBalancedError,
  JournalEntryNotFoundError,
  CurrencyRevaluationAlreadyExistsError,
  MeaninglessCorrectionError,
  NoOpenPeriodForDateError,
  TargetPeriodClosedError,
  TargetPeriodLockedError,
  isBookkeepingError,
} from '../bookkeeping/errors'

export type { StructuredErrorRemediation }

export interface StructuredError {
  code: string
  message_sv: string
  message_en: string
  remediation?: StructuredErrorRemediation
  /**
   * ALWAYS present. `true` → transient failure: the identical request may
   * succeed after a short backoff (pair with idempotency_key on staging
   * tools). `false` → permanent for these inputs: retrying is wasted work
   * until arguments or system state change. From the registry entry when the
   * code declares it; otherwise inferred by isTransientFailure().
   */
  retryable: boolean
}

// Postgres SQLSTATEs that indicate a transient condition: the same statement
// can succeed on retry without any input change.
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '57014', // query_canceled (statement timeout)
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
  '55P03', // lock_not_available
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
])

const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 502, 503, 504, 522, 524])

// Message-level signatures for transient failures. Tools commonly wrap DB
// errors as plain `Error(\`Database error: ${message}\`)`, losing the
// SQLSTATE: these patterns survive that wrapping.
const TRANSIENT_MESSAGE_PATTERNS = [
  /fetch failed/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN/,
  /socket hang up/i,
  /deadlock detected/i,
  /could not serialize access/i,
  /canceling statement due to statement timeout/i,
  /connection terminated/i,
  /too many clients/i,
  /rate limit/i,
  /timed out/i,
]

function isTransientFailure(error: unknown, message: string): boolean {
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>
    const inner = typeof obj.error === 'object' && obj.error !== null ? (obj.error as Record<string, unknown>) : undefined
    for (const c of [obj.code, inner?.code]) {
      if (typeof c === 'string' && TRANSIENT_SQLSTATES.has(c)) return true
    }
    for (const s of [obj.status, obj.statusCode]) {
      if (typeof s === 'number' && TRANSIENT_HTTP_STATUSES.has(s)) return true
    }
  }
  return TRANSIENT_MESSAGE_PATTERNS.some((re) => re.test(message))
}

interface StructuredErrorOptions {
  /**
   * Optional: scope the agent attempted to use, for INSUFFICIENT_SCOPE remediation.
   */
  attemptedScope?: string
  /**
   * Optional: tool name being called, used in fallback remediation hints.
   */
  toolName?: string
}

/**
 * Pull a stable code out of various error shapes.
 */
function extractCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null

  const obj = error as Record<string, unknown>

  // Typed bookkeeping error: { code: 'JOURNAL_ENTRY_NOT_BALANCED', ... }
  if (typeof obj.code === 'string' && /^[A-Z_]+$/.test(obj.code)) {
    return obj.code
  }

  // Wrapped error: { error: { code: '...' } }
  if (typeof obj.error === 'object' && obj.error !== null) {
    const inner = obj.error as Record<string, unknown>
    if (typeof inner.code === 'string' && /^[A-Z_]+$/.test(inner.code)) {
      return inner.code
    }
  }

  return null
}

/**
 * Heuristically infer a code from the message text when nothing structured
 * is available. Keeps known-error patterns programmatically dispatchable.
 */
function inferCode(message: string): string | null {
  if (/Period must be locked before closing/i.test(message)) return 'PERIOD_NOT_LOCKED'
  if (/Year-end closing must be executed/i.test(message)) return 'YEAR_END_NOT_RUN'
  if (/Kan inte låsa period:.*affärstransaktion/i.test(message)) return 'PERIOD_HAS_UNBOOKED_TRANSACTIONS'
  if (/Insufficient scope/i.test(message)) return 'INSUFFICIENT_SCOPE'
  if (/already has a journal entry/i.test(message)) return 'TRANSACTION_ALREADY_CATEGORIZED'
  if (/already been sent/i.test(message) || /already sent/i.test(message)) return 'INVOICE_ALREADY_SENT'
  if (/locked\/closed fiscal period/i.test(message)) return 'PERIOD_LOCKED'
  if (/Bokföringen är låst/i.test(message)) return 'PERIOD_LOCKED'
  if (/Transaction not found/i.test(message)) return 'NOT_FOUND'
  if (/Invoice not found/i.test(message)) return 'NOT_FOUND'
  return null
}

function extractEnglishMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>
    if (typeof obj.error === 'string') return obj.error
    if (typeof obj.message === 'string') return obj.message
    if (typeof obj.error === 'object' && obj.error !== null) {
      const inner = obj.error as Record<string, unknown>
      if (typeof inner.message === 'string') return inner.message
    }
  }
  return 'Unknown error'
}

/**
 * Build a StructuredError for an arbitrary thrown value.
 *
 * Always returns a valid StructuredError; never throws.
 */
export function getStructuredError(
  error: unknown,
  options: StructuredErrorOptions = {}
): StructuredError {
  const message_en = extractEnglishMessage(error)
  const message_sv = getErrorMessage(error)

  const transient = isTransientFailure(error, message_en)
  let code = extractCode(error) ?? inferCode(message_en) ?? 'UNKNOWN_ERROR'
  // Nothing more specific matched but the failure is transient: surface the
  // stable TRANSIENT_ERROR code so agents can dispatch on it.
  if (code === 'UNKNOWN_ERROR' && transient) code = 'TRANSIENT_ERROR'

  const entry = getErrorEntry(code)
  let remediation = entry?.remediation

  // Specialize INSUFFICIENT_SCOPE with the actual scope name when known.
  if (code === 'INSUFFICIENT_SCOPE' && options.attemptedScope && remediation) {
    remediation = {
      ...remediation,
      description: `The current API key does not have the "${options.attemptedScope}" scope. Mint a new key with that scope or add it to the existing key in API settings.`,
    }
  }

  return {
    code,
    message_sv,
    message_en,
    ...(remediation ? { remediation } : {}),
    // Registry declaration wins; otherwise the transient inference decides.
    // Always explicit: agents must never have to distinguish absent from false.
    retryable: entry?.retryable ?? transient,
  }
}

// ────────────────────────────────────────────────────────────────────
// REST error envelope
// ────────────────────────────────────────────────────────────────────

export interface ErrorEnvelope {
  error: {
    code: string
    message: string
    message_en?: string
    remediation?: StructuredErrorRemediation
    requestId?: string
    details?: unknown
  }
}

interface ErrorResponseContext {
  requestId?: string
  /** Additional details to attach to the response for the user/agent. */
  details?: unknown
  /** When known, override the http status from the registry entry. */
  status?: number
  /**
   * Override the registry messages when the route computes a dynamic message
   * (e.g. interpolating a rolling year range). Provide both or neither so the
   * sv/en pair never drifts apart.
   */
  messageSv?: string
  messageEn?: string
}

interface MinimalLogger {
  error: (msg: string, ...args: unknown[]) => void
}

function entryFor(code: string): StructuredErrorEntry {
  return (
    getErrorEntry(code) ??
    getErrorEntry('INTERNAL_ERROR') ?? {
      httpStatus: 500,
      message_sv: 'Något gick fel. Försök igen.',
      message_en: 'Internal server error.',
    }
  )
}

function postgresCodeToStructured(code: string): string | null {
  switch (code) {
    case '23505':
    case '23503':
    case '23514':
    case '22P02':
    case '22003':
      return 'VALIDATION_ERROR'
    case '23502':
      return 'VALIDATION_ERROR'
    case '42501':
      return 'FORBIDDEN'
    case '42P01':
      return 'NOT_FOUND'
    case '40001':
    case '40P01':
      return 'CONFLICT'
    default:
      return null
  }
}

function isZodError(err: unknown): err is ZodError {
  return err instanceof ZodError || (err instanceof Error && err.name === 'ZodError')
}

function isPostgresError(err: unknown): err is { code: string; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((err as { code: string }).code)
  )
}

/**
 * Build the canonical REST error envelope for any thrown value.
 *
 * Order of dispatch:
 *   1. typed BookkeepingError → reuses bookkeepingErrorResponse()
 *   2. ZodError                → VALIDATION_ERROR with field-level details
 *   3. Postgres error code     → mapped to a structured code
 *   4. Error with `code` field present in registry → use that
 *   5. Anything else            → INTERNAL_ERROR
 *
 * Always logs the underlying error (no silent error returns). The caller
 * must pass a logger so the request id propagates to the log line.
 */
export function errorResponse(
  err: unknown,
  log: MinimalLogger,
  ctx: ErrorResponseContext = {},
): NextResponse {
  // 1. Bookkeeping domain errors: route through the registry, preserving
  //    the structured details each typed error class carries.
  if (isBookkeepingError(err)) {
    const { code, details } = extractBookkeepingDetails(err)
    log.error(code, err as Error, { requestId: ctx.requestId })
    const entry = entryFor(code)
    return buildResponse(code, entry, ctx.requestId, details ?? ctx.details)
  }

  // 2. Zod validation errors
  if (isZodError(err)) {
    const issues = (err as ZodError).issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
      code: i.code,
    }))
    log.error('validation failed', err as Error, {
      requestId: ctx.requestId,
      issueCount: issues.length,
    })
    const entry = entryFor('VALIDATION_ERROR')
    const details = mergeDetails({ issues }, ctx.details)
    return buildResponse('VALIDATION_ERROR', entry, ctx.requestId, details)
  }

  // 3. Postgres errors
  if (isPostgresError(err)) {
    const mapped = postgresCodeToStructured(err.code)
    log.error('database error', err as unknown as Error, {
      requestId: ctx.requestId,
      pgCode: err.code,
    })
    if (mapped) {
      const entry = entryFor(mapped)
      const details = mergeDetails({ pgCode: err.code }, ctx.details)
      return buildResponse(mapped, entry, ctx.requestId, details)
    }
  }

  // 4. Errors with a known structured code on them
  const code = extractCode(err)
  if (code && getErrorEntry(code)) {
    const entry = entryFor(code)
    log.error(`${code}`, err instanceof Error ? err : new Error(String(err)), { requestId: ctx.requestId })
    const status = ctx.status ?? entry.httpStatus
    return buildResponse(code, { ...entry, httpStatus: status }, ctx.requestId, ctx.details)
  }

  // 5. Fallback: log the actual error so we can still debug
  log.error('unhandled error', err instanceof Error ? err : new Error(String(err)), {
    requestId: ctx.requestId,
  })
  const fallback = entryFor('INTERNAL_ERROR')
  return buildResponse('INTERNAL_ERROR', fallback, ctx.requestId, ctx.details)
}

function mergeDetails(
  base: Record<string, unknown>,
  extra: unknown,
): Record<string, unknown> {
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    return { ...base, ...(extra as Record<string, unknown>) }
  }
  return base
}

function extractBookkeepingDetails(err: unknown): { code: string; details?: unknown } {
  if (err instanceof AccountsNotInChartError) {
    return { code: err.code, details: { account_numbers: err.accountNumbers } }
  }
  if (err instanceof JournalEntryNotBalancedError) {
    return {
      code: err.code,
      details: { totalDebit: err.totalDebit, totalCredit: err.totalCredit, kind: err.kind },
    }
  }
  if (err instanceof FiscalPeriodNotFoundError) return { code: err.code }
  if (err instanceof EntryDateOutsideFiscalPeriodError) {
    return {
      code: err.code,
      details: {
        entryDate: err.entryDate,
        periodName: err.periodName,
        periodStart: err.periodStart,
        periodEnd: err.periodEnd,
      },
    }
  }
  if (err instanceof JournalEntryNotFoundError) return { code: err.code }
  if (err instanceof CannotReverseNonPostedError) {
    return { code: err.code, details: { currentStatus: err.currentStatus } }
  }
  if (err instanceof CannotReverseStornoError) {
    return { code: err.code, details: { sourceType: err.sourceType } }
  }
  if (err instanceof CannotCorrectNonPostedError) {
    return { code: err.code, details: { currentStatus: err.currentStatus } }
  }
  if (err instanceof EntryAlreadyReversedError) return { code: err.code }
  if (err instanceof CurrencyRevaluationAlreadyExistsError) return { code: err.code }
  if (err instanceof InvalidMappingResultError) {
    return {
      code: err.code,
      details: { debitAccount: err.debitAccount, creditAccount: err.creditAccount },
    }
  }
  if (err instanceof MeaninglessCorrectionError) {
    return { code: err.code, details: { reason: err.reason } }
  }
  if (err instanceof DimensionValidationError) {
    return { code: err.code, details: { issues: err.issues } }
  }
  if (err instanceof NoOpenPeriodForDateError) {
    return { code: err.code, details: { date: err.date } }
  }
  if (err instanceof TargetPeriodClosedError) {
    return { code: err.code, details: { date: err.date } }
  }
  if (err instanceof TargetPeriodLockedError) {
    return { code: err.code, details: { date: err.date, lockDate: err.lockDate } }
  }
  if (err instanceof BookkeepingDatabaseError) {
    return { code: err.code, details: { operation: err.operation } }
  }
  return { code: 'INTERNAL_ERROR' }
}

function buildResponse(
  code: string,
  entry: StructuredErrorEntry,
  requestId: string | undefined,
  details: unknown,
): NextResponse {
  const body: ErrorEnvelope = {
    error: {
      code,
      message: entry.message_sv,
      message_en: entry.message_en,
      ...(entry.remediation ? { remediation: entry.remediation } : {}),
      ...(requestId ? { requestId } : {}),
      ...(details !== undefined ? { details } : {}),
    },
  }
  const res = NextResponse.json(body, { status: entry.httpStatus })
  if (requestId) res.headers.set('X-Request-Id', requestId)
  return res
}

/**
 * Construct an envelope-shaped error directly from a code (when the route
 * already knows the failure mode). Skips dispatch: useful inside a handler
 * that wants the standard shape without throwing.
 */
export function errorResponseFromCode(
  code: string,
  log: MinimalLogger,
  ctx: ErrorResponseContext & { reason?: string } = {},
): NextResponse {
  const entry = entryFor(code)
  log.error(code, ctx.reason ?? entry.message_en, { requestId: ctx.requestId })
  const status = ctx.status ?? entry.httpStatus
  return buildResponse(
    code,
    {
      ...entry,
      httpStatus: status,
      ...(ctx.messageSv ? { message_sv: ctx.messageSv } : {}),
      ...(ctx.messageEn ? { message_en: ctx.messageEn } : {}),
    },
    ctx.requestId,
    ctx.details,
  )
}
