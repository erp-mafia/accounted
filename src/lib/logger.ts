/**
 * Structured logger for server-side code.
 *
 * Emits JSON in production (Vercel logs ingest these), pretty text in dev.
 * Suppresses info/warn in test (preserves existing test-noise contract).
 *
 * Backward-compatible with the legacy `log.error(msg, ...args)` callers: any
 * extra args after the message are merged into the structured payload:
 *   - Error instances become `err: { name, message, stack, code }`
 *   - plain objects merge into the context fields (after PII redaction)
 *   - everything else goes into `details: [...]`
 *
 * New code should prefer the explicit ctx form: `log.error('msg', err, ctx)`.
 *
 * Use `log.child({ requestId, companyId, ... })` to bind a context that is
 * merged into every subsequent call. The `with-route-context` wrapper relies
 * on this to thread requestId through a request lifecycle.
 *
 * Observability: every `error` record, plus any record explicitly flagged
 * `alert: true` at any level, is additionally forwarded to the observability
 * sink (`@/lib/observability`). The sink is a no-op until a vendor adapter is
 * registered, so this is inert today; once an adapter is dropped in, every
 * existing `log.error()` call site becomes a reported event with its bound
 * request context, without touching a single call site.
 *
 * PII: the redaction primitives live in `@/lib/observability/redact` and are
 * shared with the sink, so the personnummer regex and the key denylist run on
 * the way to a third-party provider exactly as they run on the way to stdout.
 * The record handed to `forwardToSink` is already redacted; the sink redacts
 * again (redaction is idempotent) so no path can bypass it.
 */

// Relative, not `@/lib/...`: the logger sits at the bottom of the import graph
// and is pulled in by everything, so it should not depend on path-alias
// resolution being configured in whatever context it is loaded from.
import { captureException, captureMessage, type ObservabilityLevel } from './observability/sink'
import { redact, redactString } from './observability/redact'

type LogLevel = 'info' | 'warn' | 'error'

// The sink speaks the vendor-neutral level vocabulary ('warning', not 'warn').
// Without this map every alert-flagged info/warn record arrived at the
// provider as severity 'error' and paged like one.
const SINK_LEVEL: Record<LogLevel, ObservabilityLevel> = {
  info: 'info',
  warn: 'warning',
  error: 'error',
}

export interface LogContext {
  requestId?: string
  userId?: string
  companyId?: string
  operation?: string
  entityType?: string
  entityId?: string
  durationMs?: number
  /**
   * Demand out-of-band alerting for this record. Forwards it to the
   * observability sink even at info/warn level, and even when console output
   * is suppressed. Use it for failures a human must act on, not for noise.
   */
  alert?: boolean
  [k: string]: unknown
}

export interface Logger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  child(extra: LogContext): Logger
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !(v instanceof Error) &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    Object.getPrototypeOf(v) === Object.prototype
  )
}

function shouldLog(level: LogLevel): boolean {
  if (process.env.NODE_ENV === 'test') return level === 'error'
  return true
}

interface LogRecord {
  level: LogLevel
  module: string
  msg: string
  ts: string
  err?: unknown
  details?: unknown[]
  [k: string]: unknown
}

function buildRecord(
  level: LogLevel,
  module: string,
  base: LogContext,
  message: string,
  args: unknown[],
): LogRecord {
  const ctx: Record<string, unknown> = { ...base }
  let err: unknown
  const details: unknown[] = []

  for (const arg of args) {
    if (arg instanceof Error) {
      // First Error wins; subsequent ones land in details
      if (err === undefined) err = redact(arg)
      else details.push(redact(arg))
    } else if (isPlainObject(arg)) {
      Object.assign(ctx, redact(arg) as Record<string, unknown>)
    } else if (arg !== undefined) {
      details.push(redact(arg))
    }
  }

  const record: LogRecord = {
    level,
    module,
    msg: redactString(message),
    ts: new Date().toISOString(),
    ...(redact(ctx) as Record<string, unknown>),
  }
  if (err !== undefined) record.err = err
  if (details.length > 0) record.details = details
  return record
}

/** A `redact()`-serialized Error: `{ name, message, stack?, code? }`. */
function isSerializedError(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).name === 'string' &&
    typeof (v as Record<string, unknown>).message === 'string' &&
    'stack' in (v as Record<string, unknown>)
  )
}

/**
 * Drop `stack` from every serialized error in the record, however nested.
 *
 * This is the STDOUT half of the stack policy: production log lines stay
 * small and grep-friendly without stack noise, exactly as before. The sink
 * path deliberately does NOT run this: `redact()` keeps a redacted stack on
 * the serialized error, because the error tracker only runs in production and
 * needs the stack to group events (see lib/observability/redact.ts).
 */
function stripErrorStacks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripErrorStacks)
  if (typeof value === 'object' && value !== null) {
    const dropStack = isSerializedError(value)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (dropStack && k === 'stack') continue
      out[k] = stripErrorStacks(v)
    }
    return out
  }
  return value
}

function emit(record: LogRecord) {
  const fn =
    record.level === 'error' ? console.error : record.level === 'warn' ? console.warn : console.log

  if (process.env.NODE_ENV === 'production') {
    fn(JSON.stringify(stripErrorStacks(record)))
    return
  }

  // Pretty dev output
  const { level, module, msg, ts: _ts, err, details, ...ctx } = record
  const ctxKeys = Object.keys(ctx)
  const ctxStr = ctxKeys.length > 0 ? ' ' + ctxKeys.map((k) => `${k}=${JSON.stringify(ctx[k])}`).join(' ') : ''
  const prefix = `[${module}]`
  const tag = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'INFO'
  fn(`${prefix} ${tag} ${msg}${ctxStr}`)
  if (err) fn('  err:', err)
  if (details && details.length > 0) fn('  details:', ...details)
}

/**
 * `alert: true` marks a record for out-of-band alerting. It is honoured
 * whether it arrives on the bound context (`log.child({ alert: true })`) or as
 * a field on one of the call's own context args.
 */
function hasAlertFlag(base: LogContext, args: unknown[]): boolean {
  if (base.alert === true) return true
  return args.some((arg) => isPlainObject(arg) && arg.alert === true)
}

/**
 * Hand a finished log record to the observability sink.
 *
 * The record is already redacted: `buildRecord` runs `redact()` over the
 * context, the args and the message before this is ever reached. The sink
 * redacts a second time on its own boundary, so no field can reach a provider
 * without passing the denylist and the personnummer regex.
 *
 * Errors are captured as exceptions (the provider gets a redacted stack to
 * group on, in production too: emit() strips stacks from STDOUT only);
 * records without an Error become messages at the record's own severity, so
 * an alert-flagged info/warn arrives as info/warning rather than error. Both
 * entry points swallow their own failures, so this can never throw into a
 * caller's path.
 */
function forwardToSink(record: LogRecord): void {
  const { level, module, msg, ts, err, details, ...ctx } = record
  const context: Record<string, unknown> = {
    ...ctx,
    module,
    logLevel: level,
    loggedAt: ts,
    logMessage: msg,
  }
  if (details !== undefined) context.details = details

  if (err !== undefined) {
    captureException(err, context)
  } else {
    captureMessage(msg, SINK_LEVEL[level], context)
  }
}

function write(
  module: string,
  base: LogContext,
  level: LogLevel,
  message: string,
  args: unknown[],
): void {
  // Errors always report. `alert: true` also reports at info/warn, and does so
  // even when console output is suppressed (test env), so an explicit alert
  // can never be swallowed by the console log-level policy.
  const forward = level === 'error' || hasAlertFlag(base, args)
  const toConsole = shouldLog(level)
  if (!forward && !toConsole) return

  const record = buildRecord(level, module, base, message, args)
  if (forward) forwardToSink(record)
  if (toConsole) emit(record)
}

function makeLogger(module: string, base: LogContext): Logger {
  return {
    info(message: string, ...args: unknown[]) {
      write(module, base, 'info', message, args)
    },
    warn(message: string, ...args: unknown[]) {
      write(module, base, 'warn', message, args)
    },
    error(message: string, ...args: unknown[]) {
      write(module, base, 'error', message, args)
    },
    child(extra: LogContext): Logger {
      return makeLogger(module, { ...base, ...extra })
    },
  }
}

export function createLogger(module: string, base: LogContext = {}): Logger {
  return makeLogger(module, base)
}

/**
 * Test-only escape hatch. Returns a logger that writes records to the supplied
 * array instead of stdout. Useful for asserting on emitted log lines.
 *
 * Deliberately does NOT forward to the observability sink: it is a pure record
 * builder. Tests that assert on what the sink receives should use
 * `createLogger()` with a fake sink registered via `registerObservabilitySink`.
 */
export function createTestLogger(module: string, sink: LogRecord[], base: LogContext = {}): Logger {
  const push = (level: LogLevel, message: string, args: unknown[]) => {
    sink.push(buildRecord(level, module, base, message, args))
  }
  return {
    info(message: string, ...args: unknown[]) {
      push('info', message, args)
    },
    warn(message: string, ...args: unknown[]) {
      push('warn', message, args)
    },
    error(message: string, ...args: unknown[]) {
      push('error', message, args)
    },
    child(extra: LogContext): Logger {
      return createTestLogger(module, sink, { ...base, ...extra })
    },
  }
}
