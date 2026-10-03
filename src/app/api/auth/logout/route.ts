import { z } from 'zod'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'
import {
  authError,
  authOk,
  rejectCrossSiteAuthRequest,
} from '@/lib/auth/auth-route-helpers'
import {
  AUTH_COOKIE_FLAGS_MARKER,
  isAuthTokenCookieName,
  supabaseAuthStorageKey,
} from '@/lib/supabase/auth-cookies'
import {
  expiredCookieOptions,
  requestProtocolFromHeaders,
} from '@/lib/supabase/cookie-options'
import {
  SESSION_AUTH_METHOD_HINT_COOKIE,
  SESSION_TIMEOUT_COOKIE,
} from '@/lib/auth/session-timeout-shared'
import { BOOKS_GATE_COOKIE } from '@/lib/onboarding/books-gate'
import { COMPANY_PICKED_COOKIE } from '@/lib/company/context'

const log = createLogger('auth-logout')

const LogoutSchema = z.object({
  // 'global' (every device) is supabase-js's signOut() default, which every
  // sign-out button used; 'local' ends only this browser's session (the
  // session-timeout controller).
  scope: z.enum(['global', 'local']).default('global'),
})

/**
 * Cookies that only mean something while a session exists, cleared with it
 * so nothing identifying stays behind (CASA 6.6.1): the company hint, the
 * per-user home-domain marker, the explicit company choice, the books gate,
 * the timeout state and method hint, and the session-cookie marker. The
 * language cookie stays (a display preference).
 */
const SESSION_BOUND_COOKIES = [
  'gnubok-company-id',
  'gnubok-home-ok',
  COMPANY_PICKED_COOKIE,
  BOOKS_GATE_COOKIE,
  SESSION_TIMEOUT_COOKIE,
  SESSION_AUTH_METHOD_HINT_COOKIE,
  AUTH_COOKIE_FLAGS_MARKER,
]

/**
 * POST /api/auth/logout
 *
 * Revokes the session at GoTrue (scope global or local) and deletes the
 * HttpOnly session cookie, which page scripts cannot do any more. Replaces
 * every browser supabase.auth.signOut() call.
 *
 * Needs no valid session: a dead or expired one is cleaned up all the same,
 * and an AAL1 session (the MFA verify page's "log out") is allowed through
 * the proxy's MFA gate for exactly this (apiPathSkipsMfaGate). If GoTrue
 * refuses the revocation the cookies are still removed, so the browser is
 * signed out either way; `revoked` says whether the server side ended too.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSiteAuthRequest(request)
  if (rejected) return rejected

  let body: unknown = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = LogoutSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return authError(400, 'validation_error', 'Ogiltig utloggning.', 'Invalid sign-out request.')
  }
  const { scope } = parsed.data

  const supabase = await createClient()
  let revoked = true
  try {
    const { error } = await supabase.auth.signOut({ scope })
    if (error) {
      revoked = false
      log.warn('signOut was refused by the auth server; clearing cookies anyway', {
        status: error.status,
        code: error.code,
      })
    }
  } catch (err) {
    revoked = false
    log.warn('signOut threw; clearing cookies anyway', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const response = authOk({ revoked })
  const expired = expiredCookieOptions(requestProtocolFromHeaders(request.headers))
  const cookieStore = await cookies()
  const present = cookieStore.getAll().map((cookie) => cookie.name)

  // auth-js deletes the session cookie itself on success; after a refused
  // revocation it keeps it, so remove every chunk (and a PKCE verifier) here.
  const key = supabaseAuthStorageKey()
  if (!revoked && key) {
    for (const name of present) {
      if (isAuthTokenCookieName(name, key) || name === `${key}-code-verifier`) {
        response.cookies.set(name, '', expired)
      }
    }
  }
  for (const name of SESSION_BOUND_COOKIES) {
    if (present.includes(name)) response.cookies.set(name, '', expired)
  }
  return response
}
