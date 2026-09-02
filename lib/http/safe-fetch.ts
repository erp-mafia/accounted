/**
 * Guarded outbound `fetch` for URLs a tenant controls.
 *
 * Several server-side paths fetch a URL that a company member can write
 * straight into the database through PostgREST (RLS lets members update
 * their own rows, so app-side normalisation at create time is not a
 * boundary): `woocommerce_connections.store_url`, `shopify_connections.
 * shop_domain`, `company_settings.logo_url`. Fetching those with a bare
 * `fetch()` from the Vercel function's network position is a textbook SSRF:
 * cloud metadata (169.254.169.254), loopback, RFC 1918 ranges, and any 3xx
 * that bounces the request there AFTER a hostname check passed.
 *
 * This helper is the one place such fetches go through:
 *
 *   1. The URL must be http(s). Anything else is refused up front.
 *   2. Unless the URL's origin is explicitly trusted by the caller (e.g. the
 *      deployment's own Supabase storage origin, which may legitimately be a
 *      private address on a self-hosted install), EVERY A/AAAA record of the
 *      hostname must be publicly routable and the scheme must be https. That
 *      check is `validateWebhookUrl` from the webhook dispatcher, reused
 *      verbatim so there is a single definition of "safe address" in the
 *      codebase. IP-literal hostnames are classified directly, without DNS.
 *   3. Redirects are never followed: `redirect: 'manual'` is forced and any
 *      3xx (or an opaque-redirect response) is a refusal, not a response.
 *
 * Compared to `lib/webhooks/pinned-fetch.ts` this keeps the `fetch` /
 * `Response` surface that the callers (and their tests) are written against,
 * at the cost of the DNS-rebinding window between validation and connect that
 * the pinned transport closes. That window is the same one url-guard.ts
 * documents for its own callers and is acceptable for these read-only feeds;
 * a caller that needs pinning should use pinnedHttpsFetch instead.
 *
 * Timeouts stay the caller's responsibility (`signal: AbortSignal.timeout()`),
 * and body size is bounded with `readBodyWithCap` so a hostile host cannot
 * balloon memory before a size check runs.
 */

import { isIP } from 'node:net'
import {
  validateWebhookUrl as validateWebhookUrlDefault,
  type WebhookUrlValidationReason,
} from '@/lib/webhooks/url-guard'

export type SafeFetchRefusalReason =
  | WebhookUrlValidationReason
  | 'unsupported_scheme'
  | 'redirect_blocked'

/**
 * Thrown when the guard refuses to open (or to keep) a connection. Callers
 * must treat this as terminal for the URL: retrying does not help, and the
 * stored URL should be surfaced to the user as invalid rather than fetched.
 */
export class UnsafeUrlError extends Error {
  readonly name = 'UnsafeUrlError'

  constructor(
    readonly reason: SafeFetchRefusalReason,
    readonly detail: string,
  ) {
    super(`Refused to fetch URL (${reason}): ${detail}`)
  }
}

/** Name-based so it survives duplicate module instances (vitest isolation). */
export function isUnsafeUrlError(error: unknown): error is UnsafeUrlError {
  return error instanceof Error && error.name === 'UnsafeUrlError'
}

export interface SafeFetchOptions {
  /**
   * Origins (`scheme://host[:port]`) that skip the public-address check.
   * Reserved for infrastructure the app already talks to (the deployment's
   * own Supabase storage). Redirect refusal still applies to these.
   */
  trustedOrigins?: readonly string[]
}

export interface SafeFetchDeps {
  /** DNS validation seam. Defaults to url-guard's validateWebhookUrl. */
  validateUrl?: typeof validateWebhookUrlDefault
  /** Transport seam. Defaults to the global fetch (resolved at call time). */
  fetchImpl?: typeof fetch
}

type ValidateUrlOptions = NonNullable<Parameters<typeof validateWebhookUrlDefault>[1]>

/**
 * `dns.resolve4('10.0.0.1')` is not a lookup, it is an error (or worse, a
 * provider-dependent echo). For IP-literal hostnames, feed the literal to the
 * validator as if it were the single DNS answer so the address classifier
 * runs on it directly and the result is deterministic.
 */
function literalResolvers(hostname: string): ValidateUrlOptions | undefined {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const family = isIP(bare)
  if (family === 0) return undefined

  const literal = (async () => [bare]) as unknown as ValidateUrlOptions['resolve4']
  const noRecords = (async () => {
    const err = new Error(`No records for ${bare}`) as NodeJS.ErrnoException
    err.code = 'ENODATA'
    throw err
  }) as unknown as ValidateUrlOptions['resolve4']

  return family === 4
    ? { resolve4: literal, resolve6: noRecords }
    : { resolve4: noRecords, resolve6: literal }
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function isTrustedOrigin(parsed: URL, trustedOrigins: readonly string[] | undefined): boolean {
  if (!trustedOrigins || trustedOrigins.length === 0) return false
  const target = parsed.origin
  return trustedOrigins.some((entry) => originOf(entry) === target)
}

function isRedirectResponse(res: Response): boolean {
  if (res.type === 'opaqueredirect') return true
  return res.status >= 300 && res.status < 400
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    // Best-effort socket cleanup; the response is being refused anyway.
  }
}

/**
 * Fetch `rawUrl` only if it is safe to connect to, never following redirects.
 * Throws `UnsafeUrlError` on refusal; transport errors propagate unchanged so
 * callers keep their existing retry semantics for the network-blip case.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
  deps: SafeFetchDeps = {},
): Promise<Response> {
  const validateUrl = deps.validateUrl ?? validateWebhookUrlDefault
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new UnsafeUrlError('invalid_url', 'URL did not parse.')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UnsafeUrlError(
      'unsupported_scheme',
      `Only http(s) URLs can be fetched (got ${parsed.protocol}).`,
    )
  }

  if (!isTrustedOrigin(parsed, options.trustedOrigins)) {
    const validation = await validateUrl(rawUrl, literalResolvers(parsed.hostname))
    if (!validation.ok) {
      throw new UnsafeUrlError(validation.reason, validation.detail)
    }
  }

  const response = await fetchImpl(rawUrl, { ...init, redirect: 'manual' })

  if (isRedirectResponse(response)) {
    await discardBody(response)
    throw new UnsafeUrlError(
      'redirect_blocked',
      `${parsed.hostname} answered ${response.status || 'with a redirect'}; redirects are never followed.`,
    )
  }

  return response
}

/**
 * Read a response body into a Buffer, refusing anything over `maxBytes`.
 *
 * Checks the declared Content-Length first (cheap, no bytes read), then
 * streams with a running total so a host that lies about (or omits) the
 * length is cut off at the cap instead of being buffered whole. Returns null
 * when the cap is exceeded; the body is cancelled in that case.
 */
export async function readBodyWithCap(res: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(res)
    return null
  }

  const body = res.body
  if (!body || typeof body.getReader !== 'function') {
    // Bodyless or non-streaming Response (test doubles, some polyfills):
    // fall back to a whole read with a post-hoc check.
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.byteLength > maxBytes ? null : buf
  }

  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}
