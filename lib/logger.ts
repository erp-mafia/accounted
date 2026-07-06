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
 */

type LogLevel = 'info' | 'warn' | 'error'

export interface LogContext {
  requestId?: string
  userId?: string
  companyId?: string
  operation?: string
  entityType?: string
  entityId?: string
  durationMs?: number
  [k: string]: unknown
}

export interface Logger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  child(extra: LogContext): Logger
}

const REDACTED = '[REDACTED]'

const REDACT_KEYS = new Set([
  'password',
  'token',
  'access_token',
  'refresh_token',
  'apikey',
  'api_key',
  'secret',
  'authorization',
  'cookie',
  'bank_account',
  'bankaccount',
  'iban',
  'personnummer',
  'ssn',
  'credentials',
])

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const PERSONNUMMER_PATTERN = /\b\d{6}-?\d{4}\b|\b\d{8}-?\d{4}\b/

function redactString(value: string): string {
  // Strip UUIDs first to avoid false-positive personnummer matches
  const stripped = value.replace(UUID_PATTERN, '')
  if (PERSONNUMMER_PATTERN.test(stripped)) {
    return REDACTED
  }
  return value
}

function redact(value: unknown, keyPath = ''): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: process.env.NODE_ENV === 'production' ? undefined : value.stack,
      code: (value as Error & { code?: unknown }).code,
    }
  }
  if (Array.isArray(value)) return value.map((v, i) => redact(v, `${keyPath}[${i}]`))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTED
      } else {
        out[k] = redact(v, keyPath ? `${keyPath}.${k}` : k)
      }
    }
    return out
  }
  return value
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

function emit(record: LogRecord) {
  const fn =
    record.level === 'error' ? console.error : record.level === 'warn' ? console.warn : console.log

  if (process.env.NODE_ENV === 'production') {
    fn(JSON.stringify(record))
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

function makeLogger(module: string, base: LogContext): Logger {
  return {
    info(message: string, ...args: unknown[]) {
      if (!shouldLog('info')) return
      emit(buildRecord('info', module, base, message, args))
    },
    warn(message: string, ...args: unknown[]) {
      if (!shouldLog('warn')) return
      emit(buildRecord('warn', module, base, message, args))
    },
    error(message: string, ...args: unknown[]) {
      if (!shouldLog('error')) return
      emit(buildRecord('error', module, base, message, args))
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
