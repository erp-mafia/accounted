import 'server-only'

import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { requestClientIp, truncateIp } from '@/lib/api/ip'
import { requestHost } from '@/lib/domains/trusted-app-origin'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  SESSION_AUTH_METHOD_HINT_COOKIE,
  type SessionAuthMethod,
} from '@/lib/auth/session-timeout-shared'
import {
  httpOnlyCookieOptions,
  requestProtocolFromHeaders,
} from '@/lib/supabase/cookie-options'

/**
 * Shared plumbing for the /api/auth/* routes that replaced the browser's
 * direct supabase.auth calls when the session became server-held (the
 * session cookie is HttpOnly, so sign-in, OTP, MFA and sign-out have to run
 * where the cookie can be written).
 */

type ErrorBody = { error: { code: string; message: string; message_en: string } }

/** The canonical error envelope, with a Swedish and an English message. */
export function authError(
  status: number,
  code: string,
  message: string,
  messageEn: string,
): NextResponse<ErrorBody> {
  return NextResponse.json(
    { error: { code, message, message_en: messageEn } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}

/**
 * A GoTrue error as the canonical envelope. The code is GoTrue's own
 * (invalid_credentials, over_request_rate_limit, insufficient_aal, ...), which
 * is what classifyAuthError on the pages keys on; the messages are localised
 * through getErrorMessage like every other auth surface.
 */
export function gotrueErrorResponse(
  error: { code?: string; status?: number; message?: string },
  fallbackStatus = 400,
): NextResponse<ErrorBody> {
  const status = error.status && error.status >= 400 && error.status < 600 ? error.status : fallbackStatus
  return authError(
    status,
    error.code ?? 'auth_error',
    getErrorMessage(error, { context: 'auth', locale: 'sv' }),
    getErrorMessage(error, { context: 'auth', locale: 'en' }),
  )
}

/**
 * Refuse a state-changing auth request that did not come from this app's own
 * pages. These routes set the session cookie, so a cross-site form post
 * could otherwise sign a victim's browser into an attacker's account (login
 * CSRF), which the old direct-to-GoTrue calls never allowed. Requiring a JSON
 * body closes the form-post path (a cross-origin JSON request needs a CORS
 * preflight this app never grants); Sec-Fetch-Site and Origin close the rest
 * on browsers that send them.
 */
export function rejectCrossSiteAuthRequest(request: Request): NextResponse | null {
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^application\/json(\s*;|$)/i.test(contentType.trim())) {
    return authError(415, 'unsupported_media_type', 'Ogiltig förfrågan.', 'Invalid request.')
  }

  // Every current browser sends Sec-Fetch-Site; trust it when present. A
  // same-site sibling cannot get a JSON POST through anyway (the CORS
  // preflight fails), so only an explicit cross-site request is refused.
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite) {
    return fetchSite === 'cross-site'
      ? authError(403, 'cross_site_request', 'Ogiltig förfrågan.', 'Invalid request.')
      : null
  }

  // Older browsers: fall back to comparing Origin with the addressed host.
  const origin = request.headers.get('origin')
  if (!origin) return null
  let originHost: string | null = null
  try {
    originHost = origin === 'null' ? null : new URL(origin).host.toLowerCase()
  } catch {
    originHost = null
  }
  const host = requestHost(request)?.toLowerCase() ?? null
  if (!originHost || !host || originHost !== host) {
    return authError(403, 'cross_site_request', 'Ogiltig förfrågan.', 'Invalid request.')
  }
  return null
}

/** The /24 (IPv4) or /48 (IPv6) the request came from, for rate limiting. */
export function clientNetwork(request: Request): string {
  return truncateIp(requestClientIp(request)) ?? 'unknown'
}

/** A stable, non-reversible rate-limit key for an e-mail address. */
export function emailRateKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32)
}

/**
 * Apply one or more sliding-window limits (lib/auth/rate-limit-http.ts; a
 * no-op where Upstash is not configured, like local dev and self-hosting).
 * Returns the 429 of the first limit that trips, as the auth envelope, so
 * the pages classify it as rate_limited.
 */
export async function authRateLimit(
  limits: Array<{ prefix: string; identifier: string; maxRequests: number; windowMs: number }>,
): Promise<NextResponse | null> {
  for (const limit of limits) {
    const result = await checkRateLimit(limit)
    if (!result.ok) {
      const response = authError(
        429,
        'over_request_rate_limit',
        'För många försök. Vänta en stund och försök igen.',
        'Too many attempts. Wait a moment and try again.',
      )
      const retryAfter = result.response?.headers.get('Retry-After')
      if (retryAfter) response.headers.set('Retry-After', retryAfter)
      return response
    }
  }
  return null
}

/**
 * Remember how this session signed in, for the session-timeout state the
 * proxy mints on the next request (it labels the re-login the timeout page
 * offers). Short-lived and HttpOnly; the proxy clears it once read.
 */
export function setSessionAuthMethodHint(
  response: NextResponse,
  request: Request,
  method: SessionAuthMethod,
): void {
  response.cookies.set(
    SESSION_AUTH_METHOD_HINT_COOKIE,
    method,
    httpOnlyCookieOptions(300, requestProtocolFromHeaders(request.headers)),
  )
}

/**
 * Whether a fresh session still owes an MFA step-up: the user has a verified
 * factor on the server-authenticated record GoTrue just returned, and the
 * session is below AAL2. Mirrors what mfa.getAuthenticatorAssuranceLevel()
 * computed in the browser before, from data that did not pass through a
 * cookie.
 */
export function stepUpOwed(
  user: { factors?: Array<{ status: string }> | null } | null | undefined,
  accessToken: string | null | undefined,
): boolean {
  const hasVerifiedFactor = user?.factors?.some((factor) => factor.status === 'verified') ?? false
  if (!hasVerifiedFactor) return false
  return accessTokenAal(accessToken) !== 'aal2'
}

/**
 * The `aal` claim of an access token GoTrue has JUST issued on this request.
 * Decoded without verification on purpose: the token came straight from the
 * auth server over TLS in this very call, and the answer only decides where
 * the page navigates next; every gate re-verifies on the following request.
 */
export function accessTokenAal(accessToken: string | null | undefined): string | null {
  if (!accessToken) return null
  const payload = accessToken.split('.')[1]
  if (!payload) return null
  try {
    const json = Buffer.from(payload.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8')
    const claims = JSON.parse(json) as { aal?: unknown }
    return typeof claims.aal === 'string' ? claims.aal : null
  } catch {
    return null
  }
}

/** JSON success with the no-store header every auth answer carries. */
export function authOk<T>(data: T, init?: { status?: number }): NextResponse<{ data: T }> {
  return NextResponse.json(
    { data },
    { status: init?.status ?? 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
