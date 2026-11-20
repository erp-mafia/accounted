/**
 * Carries an e-mail address from a page that links to /login (the signup
 * page's "Logga in" for an address that already has an account) to the login
 * form, which fills it in.
 *
 * The address goes through the tab's sessionStorage, never the URL: a query
 * parameter lands in browser history, request logs and Referer headers. The
 * login page takes it once on load (read and removed), so it outlives neither
 * the visit nor the tab, and a sign-out empties sessionStorage anyway
 * (lib/auth/clear-browser-storage.ts). It is a prefill only: nothing is
 * submitted, and the person can change it before signing in. A link opened
 * in a new tab has its own sessionStorage, so the field is just empty there.
 */
export const LOGIN_EMAIL_HANDOFF_KEY = 'accounted-login-email'

/** The longest address SMTP can deliver to (RFC 5321 path limit). */
export const LOGIN_EMAIL_MAX_LENGTH = 254

type HandoffStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * The address worth filling in, or null. One `@` with text on both sides, no
 * whitespace or control characters, at most 254 characters: the shape of an
 * address, not a verdict on it (the sign-in itself decides).
 */
export function normalizeLoginEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim()
  if (email.length === 0 || email.length > LOGIN_EMAIL_MAX_LENGTH) return null
  if (/\p{Cc}/u.test(email)) return null
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return null
  return email
}

function tabStorage(): HandoffStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    // Blocked storage (private mode, policy): the form opens empty.
    return null
  }
}

/** Leave `email` for the login form in this tab. Ignores what is not an address. */
export function handOffLoginEmail(email: string, storage: HandoffStorage | null = tabStorage()): void {
  const value = normalizeLoginEmail(email)
  if (!value || !storage) return
  try {
    storage.setItem(LOGIN_EMAIL_HANDOFF_KEY, value)
  } catch {
    // Full or blocked storage: the form opens empty.
  }
}

/** Take the address left for the login form, once: it is removed as it is read. */
export function takeLoginEmailHandoff(storage: HandoffStorage | null = tabStorage()): string | null {
  if (!storage) return null
  try {
    const value = storage.getItem(LOGIN_EMAIL_HANDOFF_KEY)
    if (value === null) return null
    storage.removeItem(LOGIN_EMAIL_HANDOFF_KEY)
    return normalizeLoginEmail(value)
  } catch {
    // Blocked storage: safe to ignore, the form opens empty and the person
    // types the address, as without a hand-off.
    return null
  }
}
