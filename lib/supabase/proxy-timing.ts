/**
 * Per-request timing for the auth proxy (lib/supabase/middleware.ts).
 *
 * The proxy runs in front of every page, RSC, prefetch and /api request and
 * makes several sequential network calls (Supabase Auth, the active-company
 * RPC, MFA factor lookups). Nothing measured that cost until now, while the
 * route wrapper (lib/api/with-route-context.ts) has logged authMs/companyMs/
 * handlerMs per API call for months. These helpers give the proxy the same
 * Server-Timing header and one structured "proxy completed" log line per
 * request so the fixed per-request cost can be read off Vercel logs and the
 * browser Timing tab instead of guessed.
 *
 * Pure functions only: the middleware test suite mocks Supabase heavily, so
 * classification and formatting live here where they can be unit-tested
 * without that harness.
 */

export type ProxyRequestKind = 'api' | 'prefetch' | 'rsc' | 'page'

export interface ProxyTimings {
  /** supabase.auth.getUser(): a network round trip to Supabase Auth. */
  authMs: number
  /** Session-timeout state: getClaims + HMAC verify + auto_logout read. */
  sessionMs: number
  /** resolve_active_company RPC (or the query fallback) incl. write-back. */
  companyMs: number
  /** MFA assurance level + listFactors (the latter is a network call). */
  mfaMs: number
}

export type ProxyTimingKey = keyof ProxyTimings

/**
 * Header used on /api responses. withRouteContext owns `Server-Timing` on
 * API routes and only sets it when absent, so the proxy's numbers travel on
 * a separate header there; on page/RSC responses nothing else sets
 * Server-Timing and the proxy uses the standard header directly.
 */
export const PROXY_TIMING_HEADER = 'X-Proxy-Timing'

export function createProxyTimings(): ProxyTimings {
  return { authMs: 0, sessionMs: 0, companyMs: 0, mfaMs: 0 }
}

/** Run `fn` and add its wall time to `timing[key]` (accumulates on repeats). */
export async function timed<T>(
  timing: ProxyTimings,
  key: ProxyTimingKey,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now()
  try {
    return await fn()
  } finally {
    timing[key] += Date.now() - start
  }
}

/**
 * Which kind of request the proxy is fronting. Prefetch and RSC requests
 * are recognised by the headers the Next.js app router sends
 * (`Next-Router-Prefetch: 1`, `RSC: 1`); header names are case-insensitive
 * on the Fetch `Headers` interface, so lower-case lookups are fine.
 */
export function classifyProxyRequest(
  pathname: string,
  headers: Headers,
): ProxyRequestKind {
  if (pathname.startsWith('/api')) return 'api'
  if (headers.get('next-router-prefetch') === '1') return 'prefetch'
  if (headers.get('rsc') === '1') return 'rsc'
  return 'page'
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NUMERIC_RE = /^\d+$/
/** Prefixes whose tail is a secret (invite tokens, payslip links, PKCE). */
const TOKEN_PREFIXES = ['/invite', '/payslip', '/auth']

/**
 * Collapse a concrete pathname to a loggable route template: UUIDs become
 * `:id`, numbers `:n`, long opaque segments `:token`, and paths under the
 * token-carrying prefixes are cut to the prefix so a secret never lands in
 * a log line.
 */
export function proxyRouteTemplate(pathname: string): string {
  for (const prefix of TOKEN_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return `${prefix}/*`
    }
  }
  const segments = pathname.split('/').map((segment) => {
    if (segment === '') return segment
    if (UUID_RE.test(segment)) return ':id'
    if (NUMERIC_RE.test(segment)) return ':n'
    if (segment.length >= 24) return ':token'
    return segment
  })
  return segments.join('/') || '/'
}

/** `Server-Timing` value: one `mw-*` metric per phase plus the total. */
export function formatProxyServerTiming(
  timing: ProxyTimings,
  totalMs: number,
): string {
  return [
    `mw-auth;dur=${timing.authMs}`,
    `mw-session;dur=${timing.sessionMs}`,
    `mw-company;dur=${timing.companyMs}`,
    `mw-mfa;dur=${timing.mfaMs}`,
    `mw-total;dur=${totalMs}`,
  ].join(', ')
}
