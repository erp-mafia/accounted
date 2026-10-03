import { isSelfHosted } from '@/lib/env/public-flags'

/**
 * Attributes for every cookie the SERVER writes (CASA ADA AL1 2.3.1/2.3.2:
 * no Set-Cookie without HttpOnly, none without Secure where TLS is in use).
 *
 * The Supabase session cookie (sb-<ref>-auth-token, chunked .0/.1 when large)
 * used to be written with @supabase/ssr's defaults: readable by page scripts
 * (the browser client parsed it from document.cookie), no Secure attribute,
 * a 400-day lifetime. It is now server-held: only server code reads or
 * writes it, and the browser gets a short-lived access token from
 * /api/auth/session-token instead (lib/supabase/client.ts). Every server-side
 * Supabase client passes `supabaseAuthCookieOptions()` so the session cookie
 * and its deletions carry the same attributes wherever they are written.
 *
 * Deletions carry the attributes too: a clearing Set-Cookie without HttpOnly
 * is still a Set-Cookie without HttpOnly to a scanner, and the browser accepts
 * an HttpOnly deletion of any cookie the server may write.
 */

type CookieSameSite = 'lax'

export interface ServerCookieOptions {
  path: '/'
  sameSite: CookieSameSite
  httpOnly: true
  secure: boolean
  maxAge?: number
}

/**
 * The protocol a request arrived over as the public edge saw it: Vercel and
 * reverse proxies put it in x-forwarded-proto (first hop wins), and Next.js
 * sets the header for requests it serves itself.
 */
export function requestProtocolFromHeaders(
  headers: Pick<Headers, 'get'> | null | undefined,
): string | null {
  const forwarded = headers?.get('x-forwarded-proto')
  if (!forwarded) return null
  const first = forwarded.split(',')[0]?.trim().toLowerCase()
  return first ? first : null
}

function isHttpsProtocol(protocol: string | null | undefined): boolean {
  if (!protocol) return false
  const normalized = protocol.trim().toLowerCase().replace(/:$/, '')
  return normalized === 'https'
}

/**
 * Whether a configured app URL is served over TLS. Takes the value as an
 * argument and parses it at runtime: the Docker image carries a
 * `__NEXT_PUBLIC_APP_URL__` sentinel that docker-entrypoint.sh replaces at
 * container start, so the literal must survive the build (see
 * lib/env/public-flags.ts). The sentinel itself does not parse and reads as
 * "not https".
 */
function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Whether server-set cookies get the Secure attribute.
 *
 * - Served over https (per request): always.
 * - Hosted product in production: always (it is https-only; Vercel).
 * - Self-hosted: only when NEXT_PUBLIC_APP_URL is https. A plain-http LAN
 *   install must keep working: a browser drops a Secure cookie set over
 *   http, which would make signing in impossible there.
 * - Local http development (`next dev`): never, for the same reason.
 */
export function shouldUseSecureCookies(requestProtocol?: string | null): boolean {
  if (isHttpsProtocol(requestProtocol)) return true
  if (isSelfHosted()) return isHttpsUrl(process.env.NEXT_PUBLIC_APP_URL)
  return process.env.NODE_ENV === 'production'
}

/**
 * Cookie options for @supabase/ssr's createServerClient (`cookieOptions`).
 * @supabase/ssr fixes Max-Age itself (400 days on set, 0 on delete), so it is
 * deliberately absent here; the session's real lifetime is the refresh token's.
 */
export function supabaseAuthCookieOptions(requestProtocol?: string | null): {
  path: '/'
  sameSite: CookieSameSite
  httpOnly: true
  secure: boolean
} {
  return {
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
    secure: shouldUseSecureCookies(requestProtocol),
  }
}

/** Options for any other server-set cookie that page scripts never read. */
export function httpOnlyCookieOptions(
  maxAge?: number,
  requestProtocol?: string | null,
): ServerCookieOptions {
  return {
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
    secure: shouldUseSecureCookies(requestProtocol),
    ...(maxAge === undefined ? {} : { maxAge }),
  }
}

/** Options for deleting a server-set cookie (Max-Age 0, same attributes). */
export function expiredCookieOptions(requestProtocol?: string | null): ServerCookieOptions {
  return httpOnlyCookieOptions(0, requestProtocol)
}
