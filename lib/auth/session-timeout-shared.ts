export const SESSION_TIMEOUT_COOKIE = 'gnubok-session-timeout'
export const SESSION_AUTH_METHOD_HINT_COOKIE = 'gnubok-auth-method'
export const SESSION_TIMEOUT_CHANNEL = 'gnubok-session-timeout'

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

export function setSessionAuthMethodHint(method: SessionAuthMethod): void {
  if (typeof document === 'undefined') return

  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${SESSION_AUTH_METHOD_HINT_COOKIE}=${method}; Path=/; Max-Age=300; SameSite=Lax${secure}`
}
