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
