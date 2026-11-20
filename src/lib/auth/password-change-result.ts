/**
 * How POST /api/account/password answers, for the route and its three
 * callers (Säkerhet, /reset-password, /account/set-password).
 *
 * A 2xx means the password is saved AND every other session of the user is
 * confirmed ended (CASA 2.2.2). The one failure that leaves the password
 * saved is PASSWORD_CHANGED_REVOCATION_UNCONFIRMED: the write went through
 * and the auth server did not confirm the logout of the other sessions. Its
 * envelope carries `details.passwordChanged: true`, so a caller never asks
 * for the same password again (the auth server refuses an unchanged one) and
 * sends the user to "Logga ut från alla enheter" instead.
 *
 * No imports: the browser pages read this too.
 */

/** Registered in lib/errors/structured-errors.ts, which holds its sentences. */
export const PASSWORD_CHANGED_REVOCATION_UNCONFIRMED = 'PASSWORD_CHANGED_REVOCATION_UNCONFIRMED'

/** `error.details` of that failure. */
export interface PasswordChangedDetails {
  /** The new password is the user's password now. */
  passwordChanged: true
  /** The other sessions are not confirmed ended. */
  otherSessionsEnded: false
  /** The session that made the request is still signed in. */
  sessionKept: boolean
}

/**
 * Whether a failed POST /api/account/password says the password was saved
 * all the same: the form must not be offered again for the same password.
 */
export function passwordSavedDespiteFailure(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const error = (body as { error?: unknown }).error
  if (!error || typeof error !== 'object') return false
  const { code, details } = error as { code?: unknown; details?: unknown }
  if (code === PASSWORD_CHANGED_REVOCATION_UNCONFIRMED) return true
  return !!details && typeof details === 'object' && (details as { passwordChanged?: unknown }).passwordChanged === true
}
