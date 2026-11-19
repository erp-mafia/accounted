/**
 * What the Kivra and Billo clients share: one request helper with a deadline
 * and a typed error, and a token cache for their OAuth-style tokens.
 *
 * The error never carries a response body that could hold personal data:
 * the message is the status and the provider's short reason only.
 */
import { fetchWithTimeout, isTimeoutError } from '@/lib/http/fetch-with-timeout'
import type { DigitalMailboxProviderId } from './types'

export const DIGITAL_MAILBOX_TIMEOUT_MS = 20_000

export type DigitalMailboxErrorKind =
  | 'auth'
  | 'not_found'
  | 'conflict'
  | 'rejected'
  | 'rate_limited'
  | 'unavailable'
  | 'network'

export class DigitalMailboxApiError extends Error {
  readonly name = 'DigitalMailboxApiError'
  constructor(
    readonly provider: DigitalMailboxProviderId,
    readonly kind: DigitalMailboxErrorKind,
    message: string,
    readonly status: number | null = null,
    /** The provider's own error code (Billo errorCode, Kivra code), when it sent one. */
    readonly providerCode: string | null = null,
  ) {
    super(message)
  }
}

export function isDigitalMailboxApiError(error: unknown): error is DigitalMailboxApiError {
  return error instanceof Error && error.name === 'DigitalMailboxApiError'
}

export function errorKindForStatus(status: number): DigitalMailboxErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'unavailable'
  return 'rejected'
}

export interface ProviderRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  headers?: Record<string, string>
  /** JSON body. */
  json?: unknown
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string>
  /** What a short description in errors and logs calls this request. */
  description: string
}

export interface ProviderResponse {
  status: number
  headers: Headers
  /** Parsed JSON, or null for an empty or non-JSON body. */
  json: unknown
}

/** Pulls the provider's short reason out of an error body without echoing the whole body. */
function shortReason(body: unknown): { reason: string | null; code: string | null } {
  if (!body || typeof body !== 'object') return { reason: null, code: null }
  const b = body as Record<string, unknown>
  // Billo ProblemDetails puts the actionable sentence in title, validation in detail.
  const reason = [b.title, b.detail, b.short_message, b.long_message, b.message, b.error_description, b.error]
    .find((v): v is string => typeof v === 'string' && v.trim().length > 0)
  const rawCode = b.errorCode ?? b.code ?? null
  return {
    reason: reason ? reason.trim().slice(0, 200) : null,
    code: rawCode === null || rawCode === undefined ? null : String(rawCode).slice(0, 40),
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * One request to a provider. A non-2xx answer throws DigitalMailboxApiError
 * with the kind a caller decides on (auth, not found, conflict, ...).
 */
export async function providerRequest(
  provider: DigitalMailboxProviderId,
  req: ProviderRequest,
): Promise<ProviderResponse> {
  const headers: Record<string, string> = { accept: 'application/json', ...(req.headers ?? {}) }
  let body: string | undefined
  if (req.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(req.json)
  } else if (req.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(req.form).toString()
  }

  let res: Response
  try {
    res = await fetchWithTimeout(
      req.url,
      { method: req.method, headers, body, redirect: 'error' },
      { timeoutMs: DIGITAL_MAILBOX_TIMEOUT_MS, description: `${provider} ${req.description}` },
    )
  } catch (err) {
    const reason = isTimeoutError(err) ? 'timed out' : err instanceof Error ? err.message : String(err)
    throw new DigitalMailboxApiError(provider, 'network', `${req.description}: ${reason}`)
  }

  const json = await readJson(res)
  if (!res.ok) {
    const { reason, code } = shortReason(json)
    throw new DigitalMailboxApiError(
      provider,
      errorKindForStatus(res.status),
      `${req.description} answered ${res.status}${reason ? `: ${reason}` : ''}`,
      res.status,
      code,
    )
  }
  return { status: res.status, headers: res.headers, json }
}

/** A binary download from the provider's own API (Kivra parts). */
export async function providerDownload(
  provider: DigitalMailboxProviderId,
  url: string,
  headers: Record<string, string>,
  description: string,
): Promise<{ bytes: ArrayBuffer; contentType: string | null }> {
  let res: Response
  try {
    res = await fetchWithTimeout(
      url,
      { method: 'GET', headers, redirect: 'error' },
      { timeoutMs: DIGITAL_MAILBOX_TIMEOUT_MS, description: `${provider} ${description}` },
    )
  } catch (err) {
    const reason = isTimeoutError(err) ? 'timed out' : err instanceof Error ? err.message : String(err)
    throw new DigitalMailboxApiError(provider, 'network', `${description}: ${reason}`)
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw new DigitalMailboxApiError(provider, errorKindForStatus(res.status), `${description} answered ${res.status}`, res.status)
  }
  return { bytes: await res.arrayBuffer(), contentType: res.headers.get('content-type') }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface IssuedToken {
  token: string
  expiresInSeconds: number
}

export interface TokenCache {
  get(): Promise<string>
  /** Drop the cached token: after a 401, or after a scope change (a new tenant). */
  invalidate(): void
}

/** Refresh this long before the provider's expiry. */
const EXPIRY_MARGIN_MS = 60_000

/**
 * A token per process, refreshed before it expires. Concurrent callers share
 * one issuance instead of each asking the provider for a token.
 */
export function createTokenCache(issue: () => Promise<IssuedToken>, now: () => number = Date.now): TokenCache {
  let cached: { token: string; expiresAt: number } | null = null
  let inflight: Promise<string> | null = null
  return {
    async get() {
      if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.token
      if (!inflight) {
        inflight = issue()
          .then(({ token, expiresInSeconds }) => {
            const seconds = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 300
            cached = { token, expiresAt: now() + seconds * 1000 }
            return token
          })
          .finally(() => {
            inflight = null
          })
      }
      return inflight
    },
    invalidate() {
      cached = null
    },
  }
}

/**
 * Run `call` with a token; on an auth refusal, drop the token and try once
 * more with a fresh one (an expired or scope-stale token, never a bad key:
 * the second refusal is thrown).
 */
export async function withToken<T>(tokens: TokenCache, call: (token: string) => Promise<T>): Promise<T> {
  try {
    return await call(await tokens.get())
  } catch (err) {
    if (isDigitalMailboxApiError(err) && err.kind === 'auth' && err.status === 401) {
      tokens.invalidate()
      return call(await tokens.get())
    }
    throw err
  }
}

/** Base64 of bytes, for the JSON bodies both providers take files in. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}
