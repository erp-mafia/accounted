/**
 * PII redaction primitives.
 *
 * This module is the single source of truth for what must never leave the
 * process in clear text. It lives under `lib/observability/` rather than
 * inside `lib/logger.ts` so that the logger AND the observability sink share
 * one implementation: if the denylist lived in the logger only, a direct
 * `captureException()` call would reach a third-party provider unredacted.
 * Keeping one copy makes drift between the two paths impossible.
 *
 * The logs this guards carry personnummer, bank account numbers and financial
 * data. Under GDPR that data must not be shipped to an error-tracking vendor,
 * so redaction runs on every path into the sink, not just on the log path.
 *
 * Three mechanisms:
 *   1. A key denylist (`REDACT_KEYS`): any object key matching case-insensitively
 *      has its whole value replaced, however deeply nested.
 *   2. A personnummer regex applied to every string. UUIDs are stripped first,
 *      because a UUID's hex runs can otherwise look like a 10/12-digit
 *      personnummer and would nuke useful ids. A hit replaces the WHOLE string:
 *      the digits around a personnummer are usually themselves identifying.
 *   3. Substring patterns for emails, Swedish IBANs and gnubok API keys,
 *      replaced in place with a placeholder naming what was removed. These are
 *      self-delimiting secrets, so the rest of the string (a log line, a stack
 *      trace) stays useful.
 *
 * `redact()` is idempotent: running it twice is safe and produces the same
 * result, which is what lets the sink re-redact records the logger already
 * cleaned without changing them.
 *
 * This module must not import anything (least of all the logger): it sits at
 * the bottom of the import graph so nothing can create a cycle through it.
 */

export const REDACTED = '[REDACTED]'

export const REDACT_KEYS = new Set([
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
// gnubok API keys (secret keys and invite tokens). The wire-format prefix is
// permanent (see CLAUDE.md: the gnubok_* prefixes are kept on purpose), so
// this pattern will not rot with the Accounted rename.
const API_KEY_PATTERN = /gnubok_(?:sk|inv)_[A-Za-z0-9_]+/g
// Swedish IBAN: SE + 22 digits, optionally grouped with spaces
// ("SE4550000000058398257466" or "SE45 5000 0000 0583 9825 7466").
const SE_IBAN_PATTERN = /\bSE(?:\s?\d){22}\b/g
// Pragmatic email shape: enough to catch real addresses in log lines without
// matching package specs like "pkg@1.2.3" (the domain must end in a TLD).
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

export function redactString(value: string): string {
  // Strip UUIDs first to avoid false-positive personnummer matches
  const stripped = value.replace(UUID_PATTERN, '')
  if (PERSONNUMMER_PATTERN.test(stripped)) {
    return REDACTED
  }
  // Substring secrets are replaced in place (distinct placeholders, so an
  // adapter or a human can tell WHAT was removed). The placeholders contain
  // no digits and no '@', so re-running redactString over them is a no-op:
  // this is what keeps redact() idempotent.
  return value
    .replace(API_KEY_PATTERN, '[REDACTED_API_KEY]')
    .replace(SE_IBAN_PATTERN, '[REDACTED_IBAN]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
}

/**
 * Query keys whose value is an identity number whatever its written form. An
 * organisationsnummer is listed because a sole trader's IS the owner's
 * personnummer, and a form the regex misses ('121212+1212' decodes to a space
 * where the '+' was) must not slip through on such a key.
 */
const IDENTITY_QUERY_KEYS = new Set(['org_number', 'orgnr', 'personal_number', 'pnr'])

function decodeQueryPart(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '))
  } catch {
    return part
  }
}

/**
 * A request path ('/route?a=1&b=2') as it may leave the process. The pathname
 * goes through redactString like any string; each query value is decoded and
 * goes through it on its own, and the value of a key on the denylist (or one
 * naming an identity number) is replaced whole, so `?org_number=` never
 * reaches a vendor in clear while `?page=2` stays readable.
 */
export function redactRequestPath(path: string): string {
  const q = path.indexOf('?')
  const pathname = redactString(q === -1 ? path : path.slice(0, q))
  const query = q === -1 ? '' : path.slice(q + 1)
  if (!query) return pathname
  const pairs = query.split('&').map((pair) => {
    const eq = pair.indexOf('=')
    const key = decodeQueryPart(eq === -1 ? pair : pair.slice(0, eq))
    if (eq === -1) return redactString(key)
    const lower = key.toLowerCase()
    if (REDACT_KEYS.has(lower) || IDENTITY_QUERY_KEYS.has(lower)) return `${key}=${REDACTED}`
    return `${key}=${redactString(decodeQueryPart(pair.slice(eq + 1)))}`
  })
  return `${pathname}?${pairs.join('&')}`
}

/**
 * An Error a vendor SDK can take (it wants an instance, not redact()'s plain
 * object), with the message and the stack redacted as redact() does them.
 */
export function redactedError(err: unknown): Error {
  const source = err instanceof Error ? err : new Error(String(err))
  const safe = new Error(redactString(source.message))
  safe.name = source.name
  safe.stack = typeof source.stack === 'string' ? redactString(source.stack) : undefined
  return safe
}

export function redact(value: unknown, keyPath = ''): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      // The stack is kept (redacted like any other string) in EVERY
      // environment: the observability sink only runs in production, and a
      // stackless event is useless to group on. Production STDOUT still drops
      // it: that stripping happens in the logger's emit path (lib/logger.ts),
      // which is the only consumer that wants stackless records.
      stack: typeof value.stack === 'string' ? redactString(value.stack) : undefined,
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
