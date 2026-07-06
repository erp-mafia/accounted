/**
 * Wraps a single external HTTP call to a third-party provider (Fortnox, Bokio,
 * Visma, Briox, BL/Björn Lundén, Enable Banking, etc.) with structured
 * logging and code-mapped errors.
 *
 * Translates HTTP failures and network errors into ProviderCallError, which
 * the route wrapper's errorResponse() recognises as a structured code. This
 * keeps the user message + remediation consistent across providers without
 * each call site having to repeat the mapping.
 */

import { createLogger, type Logger } from '@/lib/logger'

export type ProviderCallErrorCode =
  | 'PROVIDER_AUTH_EXPIRED'
  | 'PROVIDER_LICENSE_MISSING'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNREACHABLE'
  | 'PROVIDER_UPSTREAM_ERROR'

export class ProviderCallError extends Error {
  readonly code: ProviderCallErrorCode
  readonly provider: string
  readonly status?: number
  readonly retryAfterSeconds?: number

  constructor(
    code: ProviderCallErrorCode,
    provider: string,
    message: string,
    extras: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message)
    this.name = 'ProviderCallError'
    this.code = code
    this.provider = provider
    this.status = extras.status
    this.retryAfterSeconds = extras.retryAfterSeconds
  }
}

export function isProviderCallError(err: unknown): err is ProviderCallError {
  return err instanceof ProviderCallError
}

interface ProviderCallOptions {
  /** Provider id ('fortnox', 'bokio', 'visma', etc.). */
  provider: string
  /** Short label for what this call does, e.g. 'fetch_invoices'. */
  operation: string
  /** Optional logger; if omitted a `provider/<provider>` logger is created. */
  log?: Logger
  /** Extra context merged into the log line. */
  context?: Record<string, unknown>
}

/**
 * Run an async callable that performs the actual HTTP request and translate
 * its failures. The callable should throw a `Response` (preferred) or a
 * regular Error; ProviderCallError is mapped from the response status.
 *
 * Example:
 *   await withProviderCall(
 *     { provider: 'fortnox', operation: 'fetch_invoices' },
 *     async () => {
 *       const res = await fetch(url, { headers })
 *       if (!res.ok) throw res
 *       return res.json()
 *     },
 *   )
 */
export async function withProviderCall<T>(
  options: ProviderCallOptions,
  call: () => Promise<T>,
): Promise<T> {
  const log = (options.log ?? createLogger(`provider/${options.provider}`)).child({
    provider: options.provider,
    providerOp: options.operation,
    ...options.context,
  })

  const start = Date.now()
  try {
    const result = await call()
    log.info('provider call ok', { latencyMs: Date.now() - start })
    return result
  } catch (raw) {
    const latencyMs = Date.now() - start

    if (raw instanceof Response) {
      const mapped = mapResponseError(raw, options.provider)
      log.error('provider call failed (http)', mapped, {
        latencyMs,
        status: raw.status,
      })
      throw mapped
    }

    if (raw instanceof ProviderCallError) {
      log.error('provider call failed', raw, { latencyMs })
      throw raw
    }

    if (raw instanceof Error && isNetworkError(raw)) {
      const wrapped = new ProviderCallError(
        'PROVIDER_UNREACHABLE',
        options.provider,
        raw.message,
      )
      log.error('provider call unreachable', wrapped, { latencyMs })
      throw wrapped
    }

    // Unknown shape: re-throw so the outer handler can decide. We still log it.
    log.error('provider call failed (unknown)', raw as Error, { latencyMs })
    throw raw
  }
}

function mapResponseError(res: Response, provider: string): ProviderCallError {
  if (res.status === 401 || res.status === 403) {
    return new ProviderCallError(
      'PROVIDER_AUTH_EXPIRED',
      provider,
      `Provider authentication failed: ${res.status} ${res.statusText}`,
      { status: res.status },
    )
  }
  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
    return new ProviderCallError(
      'PROVIDER_RATE_LIMITED',
      provider,
      `Provider rate limit hit: ${res.status} ${res.statusText}`,
      { status: res.status, retryAfterSeconds: retryAfter },
    )
  }
  if (res.status >= 500) {
    return new ProviderCallError(
      'PROVIDER_UPSTREAM_ERROR',
      provider,
      `Provider upstream error: ${res.status} ${res.statusText}`,
      { status: res.status },
    )
  }
  // 4xx other than 401/403/429 is application-level: surface as upstream so
  // the user gets a meaningful Swedish message; the actual cause is in logs.
  return new ProviderCallError(
    'PROVIDER_UPSTREAM_ERROR',
    provider,
    `Provider rejected request: ${res.status} ${res.statusText}`,
    { status: res.status },
  )
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : undefined
}

function isNetworkError(err: Error): boolean {
  // node-undici throws TypeError('fetch failed') with a `cause` for DNS/TCP issues.
  if (err.name === 'TypeError' && /fetch failed/i.test(err.message)) return true
  if (err.name === 'AbortError') return true
  // Known undici error codes
  const cause = (err as Error & { cause?: { code?: string } }).cause
  if (cause?.code && ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(cause.code)) {
    return true
  }
  return false
}

/**
 * Classify an error from a provider client (Fortnox/Bokio/Visma/Briox/BL) into
 * a structured error code. Reads `statusCode` (Fortnox client) or `status`
 * (other clients) off the thrown error and maps:
 *
 *   401/403 → PROVIDER_AUTH_EXPIRED
 *   429     → PROVIDER_RATE_LIMITED
 *   5xx     → PROVIDER_UPSTREAM_ERROR
 *   network → PROVIDER_UNREACHABLE
 *   other   → null (caller falls back to its domain-specific code, e.g.
 *             `PROVIDER_SIE_FETCH_FAILED`)
 *
 * Use at the boundary where a provider call's failure becomes a user-facing
 * response. Lets the toast show a specific Swedish message ("Anslutningen har
 * gått ut. Återanslut för att fortsätta." vs. "Försök igen om en stund.")
 * instead of the same generic message for every cause.
 */
export function classifyProviderError(error: unknown): ProviderCallErrorCode | null {
  if (error instanceof ProviderCallError) {
    return error.code
  }
  if (!(error instanceof Error)) return null

  const status =
    (error as Error & { statusCode?: number; status?: number }).statusCode ??
    (error as Error & { statusCode?: number; status?: number }).status

  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'PROVIDER_AUTH_EXPIRED'
    if (status === 429) return 'PROVIDER_RATE_LIMITED'
    if (status >= 500) return 'PROVIDER_UPSTREAM_ERROR'
  }
  if (isNetworkError(error)) return 'PROVIDER_UNREACHABLE'

  return null
}

/**
 * True when a provider token/OAuth failure means the integration license is
 * missing or inactive, NOT an ordinary expired/revoked grant.
 *
 * Fortnox answers its token endpoint with `error_missing_license` when the
 * customer's Fortnox account no longer carries the integration license. The
 * stored refresh token cannot be revived by re-authorizing: re-auth loops until
 * the customer re-orders the "Fortnox Integration" add-on. Distinguishing this
 * from a plain dead token lets callers say "activate the license, then
 * reconnect" instead of a bare "reconnect" that just fails again.
 *
 * Matches on the raw provider message string because the underlying refresh
 * helpers bake the body into the Error message; deliberately does NOT match
 * `invalid_grant` (that IS a revivable reconnect → PROVIDER_AUTH_EXPIRED).
 */
export function isMissingLicenseError(message: string): boolean {
  const haystack = message.toLowerCase()
  return (
    haystack.includes('error_missing_license') ||
    haystack.includes('missing_license') ||
    haystack.includes('missing license') ||
    haystack.includes('not have enough licenses')
  )
}
