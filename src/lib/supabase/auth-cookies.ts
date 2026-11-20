import { httpOnlyCookieOptions, supabaseAuthCookieOptions } from './cookie-options'

/**
 * Server-side view of the Supabase session cookie: its name, its (possibly
 * chunked) value, and the one-time upgrade of cookies written before the
 * session became server-held.
 */

/** @supabase/ssr's fixed lifetime for a set session cookie (400 days). */
export const AUTH_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60

/**
 * Marks that the session cookie the browser holds was written by this
 * server with the current attributes. The value is a fingerprint of the
 * attributes plus the cookie value, so the marker is tied to one exact
 * cookie under one attribute policy: any session cookie the server did not
 * write itself (a pre-HttpOnly cookie, or one an old tab's script created
 * after the server cleared the session) mismatches and is rewritten once,
 * and so does every cookie after the policy itself changes (Secure turned on
 * for a self-host that moved to https, or HttpOnly turned off as the first
 * step of a clean rollback). Never holds token material.
 */
export const AUTH_COOKIE_FLAGS_MARKER = 'gnubok-session-cookie'

/**
 * A pre-HttpOnly cookie is rewritten only while its access token has at
 * least this long to live. Closer to expiry the next request refreshes the
 * session anyway (auth-js refreshes within 90 s of expiry) and writes the new
 * tokens with the new attributes. Staying well clear of that window keeps a
 * rewrite of the CURRENT tokens from ever racing a parallel request that
 * rotates them: both decide on the same cookie, so they cannot straddle the
 * refresh margin.
 */
const UPGRADE_MIN_REMAINING_MS = 5 * 60 * 1000

const MAX_CHUNKS = 32

interface CookieReader {
  get(name: string): { name: string; value: string } | undefined
  getAll(): Array<{ name: string; value: string }>
}

interface CookieSetOptions {
  path?: string
  sameSite?: 'lax' | 'strict' | 'none'
  httpOnly?: boolean
  secure?: boolean
  maxAge?: number
}

interface CookieWriter {
  set(name: string, value: string, options: CookieSetOptions): unknown
  getAll(): Array<{ name: string; value: string }>
}

/**
 * The session cookie name supabase-js derives from the project URL:
 * `sb-<first label of the host>-auth-token` (`sb-127-auth-token` for a local
 * stack on 127.0.0.1). @supabase/ssr uses it unchanged unless
 * `cookieOptions.name` is set, which this codebase never does.
 */
export function supabaseAuthStorageKey(
  supabaseUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL,
): string | null {
  if (!supabaseUrl) return null
  try {
    const hostname = new URL(supabaseUrl).hostname
    const ref = hostname.split('.')[0]
    return ref ? `sb-${ref}-auth-token` : null
  } catch {
    return null
  }
}

/** The session cookie itself or one of its `.N` chunks (not the PKCE verifier). */
export function isAuthTokenCookieName(name: string, key: string): boolean {
  if (name === key) return true
  if (!name.startsWith(`${key}.`)) return false
  return /^\d+$/.test(name.slice(key.length + 1))
}

/** Names of the session cookie and its chunks present in a cookie list. */
export function authTokenCookieNames(
  cookies: Array<{ name: string }>,
  key: string,
): string[] {
  return cookies.map((cookie) => cookie.name).filter((name) => isAuthTokenCookieName(name, key))
}

/**
 * The session cookie value, reassembled from chunks the way @supabase/ssr
 * does: the unchunked name wins, otherwise `.0`, `.1`, ... in order until one
 * is missing. Null when there is no session cookie.
 */
export function readAuthCookieValue(cookies: CookieReader, key: string): string | null {
  const whole = cookies.get(key)?.value
  if (whole) return whole

  let combined = ''
  for (let index = 0; index < MAX_CHUNKS; index += 1) {
    const chunk = cookies.get(`${key}.${index}`)?.value
    if (!chunk) break
    combined += chunk
  }
  return combined || null
}

function base64UrlToUtf8(value: string): string | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/**
 * `expires_at` (epoch seconds) of the session a cookie value encodes, or
 * null when it cannot be read. Only the expiry is looked at: the value is
 * unsigned and never trusted for anything that decides access.
 */
export function authCookieExpiresAt(value: string): number | null {
  const json = value.startsWith('base64-') ? base64UrlToUtf8(value.slice('base64-'.length)) : value
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as { expires_at?: unknown }
    return typeof parsed?.expires_at === 'number' ? parsed.expires_at : null
  } catch {
    return null
  }
}

async function fingerprint(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  let binary = ''
  for (const byte of digest.subarray(0, 16)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * Give a session cookie written before the server-held switch the new
 * attributes, once, without logging anyone out.
 *
 * Runs in the proxy after auth-js has had its chance to refresh. Three cases:
 *
 * - auth-js wrote the session cookie on this response (a refresh, or a
 *   removal): those writes already carry the new attributes, so only the
 *   marker follows the new value (or goes, with the session).
 * - The browser holds a cookie the marker vouches for: nothing to do.
 * - Otherwise the cookie predates the switch (or was written by an old tab's
 *   script): on a GET or HEAD it is re-emitted verbatim with the new
 *   attributes and the marker is set, unless the access token is close
 *   enough to expiry that a refresh is imminent (see
 *   UPGRADE_MIN_REMAINING_MS).
 *
 * Old tabs still running the previous script cannot overwrite the HttpOnly
 * cookie afterwards (browsers refuse a script write over an HttpOnly cookie
 * of the same name, domain and path).
 */
export async function upgradeLegacyAuthCookies(
  request: { cookies: CookieReader; method?: string },
  response: { cookies: CookieWriter },
  requestProtocol: string | null,
  now: number = Date.now(),
): Promise<void> {
  const key = supabaseAuthStorageKey()
  if (!key) return

  const marker = request.cookies.get(AUTH_COOKIE_FLAGS_MARKER)?.value
  const writtenThisRequest = authTokenCookieNames(response.cookies.getAll(), key).length > 0
  const current = readAuthCookieValue(request.cookies, key)

  if (!current) {
    if (marker) {
      response.cookies.set(AUTH_COOKIE_FLAGS_MARKER, '', httpOnlyCookieOptions(0, requestProtocol))
    }
    return
  }

  const policy = supabaseAuthCookieOptions(requestProtocol)
  const currentFingerprint = await fingerprint(
    `${policy.httpOnly ? 'h' : '-'}${policy.secure ? 's' : '-'}|${current}`,
  )
  if (marker === currentFingerprint) return

  if (!writtenThisRequest) {
    // Only on reads (page loads, API GETs). A state-changing request may be
    // the one that ends or replaces the session (sign-out, sign-in): a
    // rewrite of the old value there would race the route's own write of
    // the same cookie in one response. The next GET does the upgrade.
    if (request.method && request.method !== 'GET' && request.method !== 'HEAD') return

    const expiresAt = authCookieExpiresAt(current)
    if (expiresAt === null || expiresAt * 1000 - now < UPGRADE_MIN_REMAINING_MS) return

    const options = { ...policy, maxAge: AUTH_COOKIE_MAX_AGE_SECONDS }
    for (const name of authTokenCookieNames(request.cookies.getAll(), key)) {
      const value = request.cookies.get(name)?.value
      if (value) response.cookies.set(name, value, options)
    }
  }

  response.cookies.set(
    AUTH_COOKIE_FLAGS_MARKER,
    currentFingerprint,
    httpOnlyCookieOptions(AUTH_COOKIE_MAX_AGE_SECONDS, requestProtocol),
  )
}
