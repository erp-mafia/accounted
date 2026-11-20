import { safeReturnTo } from '@/lib/auth/safe-return-to'
import { isSessionAuthMethod, type SessionAuthMethod } from '@/lib/auth/session-timeout-shared'

export const LOGIN_METHOD_COOKIE = 'accounted-login-method'

/**
 * Which login method the panel opens in. 'email' covers password login;
 * Google is a one-click redirect and never owns the panel state.
 */
export type LoginMethod = 'bankid' | 'email'

export function isLoginMethod(value: unknown): value is LoginMethod {
  return value === 'bankid' || value === 'email'
}

/**
 * Remember the method that just succeeded so the next visit opens the login
 * panel directly in that state. Read server-side by app/(auth)/login/page.tsx,
 * which is why this is a cookie and not localStorage: the server can render
 * the right state on the first paint, with no client-side flash.
 */
export function persistLoginMethodHint(method: LoginMethod): void {
  if (typeof document === 'undefined') return
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${LOGIN_METHOD_COOKIE}=${method}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
}

/**
 * The /login query parameter that names the panel to open. Its values are
 * the session-timeout redirect's (`password`, `bankid`), so one vocabulary
 * serves that redirect and links from other pages alike.
 */
export const LOGIN_METHOD_PARAM = 'method'

/** The panel a `method` parameter asks for, or null for anything else. */
export function loginMethodFromParam(value: string | null | undefined): LoginMethod | null {
  if (!isSessionAuthMethod(value)) return null
  return value === 'bankid' ? 'bankid' : 'email'
}

/**
 * Which method owns the login panel on the first render.
 *
 * - BankID off: the e-mail form (with password login off too, the page falls
 *   back to the remaining providers).
 * - A session-timeout re-login follows the method that timed out, password
 *   when the redirect named none.
 * - Otherwise a `method` parameter wins (a link that knows which method will
 *   work, such as "Logga in" for an address that already has an account),
 *   then the cookie hint of the last sign-in, then BankID, the Swedish
 *   default.
 * - The e-mail form is offered only when password login is on: a parameter
 *   or a hint asking for it otherwise opens BankID, so the panel never hides
 *   the one method that is there.
 *
 * This only chooses what the page shows first. Every method still runs its
 * own sign-in, and the MFA step-up after it, unchanged.
 */
export function resolveInitialLoginMethod({
  bankIdEnabled,
  passwordLoginEnabled,
  timedOut,
  requested,
  remembered,
}: {
  bankIdEnabled: boolean
  passwordLoginEnabled: boolean
  timedOut: boolean
  requested: LoginMethod | null
  remembered: LoginMethod | null
}): LoginMethod {
  if (!bankIdEnabled) return 'email'
  const method: LoginMethod = timedOut
    ? requested === 'bankid' ? 'bankid' : 'email'
    : requested ?? remembered ?? 'bankid'
  if (method === 'email' && !passwordLoginEnabled) return 'bankid'
  return method
}

/**
 * A link to /login that opens on `method` (when given) and resumes `next`
 * after the sign-in (re-vetted through safeReturnTo; '/' adds nothing).
 * It never carries an e-mail address: a URL lands in browser history,
 * request logs and Referer headers. An address to fill in travels in the
 * tab's sessionStorage instead (lib/auth/login-email-handoff.ts).
 */
export function buildLoginHref({
  method,
  next,
}: {
  method?: SessionAuthMethod
  next?: string | null
} = {}): string {
  const params = new URLSearchParams()
  if (method) params.set(LOGIN_METHOD_PARAM, method)
  const nextPath = safeReturnTo(next, '/')
  if (nextPath !== '/') params.set('next', nextPath)
  const query = params.toString()
  return query ? `/login?${query}` : '/login'
}
