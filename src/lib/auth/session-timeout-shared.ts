export const SESSION_TIMEOUT_COOKIE = 'gnubok-session-timeout'
export const SESSION_AUTH_METHOD_HINT_COOKIE = 'gnubok-auth-method'
export const SESSION_TIMEOUT_CHANNEL = 'gnubok-session-timeout'
/** Set by middleware on the 401 it answers an expired cookie session with. */
export const SESSION_TIMEOUT_REASON_HEADER = 'x-session-timeout-reason'

export type SessionAuthMethod = 'password' | 'bankid'
export type SessionTimeoutReason = 'idle' | 'absolute'

export interface SessionTimeoutClientState {
  enabled: boolean
  idleTimeoutMs: number
  absoluteTimeoutMs: number
  warningMs: number
  serverNow: number
  startedAt: number
  lastActivityAt: number
  method: SessionAuthMethod
}

export function isSessionAuthMethod(value: unknown): value is SessionAuthMethod {
  return value === 'password' || value === 'bankid'
}

/**
 * Announce an expired session that a plain data request ran into, so the
 * SessionTimeoutController signs out and routes to /login exactly as it does
 * for an expired heartbeat.
 *
 * The controller's own timers are the normal detector, but a backgrounded
 * mobile tab has them throttled: the first thing that notices is often the
 * request the user just made. Without this the page stays up while every
 * action fails, and the failure surfaces as a message about that action
 * (an upload that "misslyckades") rather than as the re-login it really is.
 *
 * Returns whether the response was in fact a session timeout, so callers can
 * skip their own error toast when the redirect is already on its way.
 */
export function notifySessionExpired(response: Response): boolean {
  const raw = response.status === 401
    ? response.headers.get(SESSION_TIMEOUT_REASON_HEADER)
    : null
  if (raw !== 'idle' && raw !== 'absolute') return false

  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(SESSION_TIMEOUT_CHANNEL)
    channel.postMessage({ type: 'expired', reason: raw })
    channel.close()
  }
  return true
}

export function setSessionAuthMethodHint(method: SessionAuthMethod): void {
  if (typeof document === 'undefined') return

  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${SESSION_AUTH_METHOD_HINT_COOKIE}=${method}; Path=/; Max-Age=300; SameSite=Lax${secure}`
}
