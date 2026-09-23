/**
 * Classifies Supabase GoTrue auth errors into a small set of kinds the auth
 * pages can map to specific, localized inline messages.
 *
 * Security note: GoTrue deliberately returns the same `invalid_credentials`
 * code for "unknown email" and "wrong password" so the login form cannot be
 * used to probe which addresses have accounts (anti-enumeration). The UI must
 * keep that ambiguity: "wrong email or password", never "wrong password".
 *
 * Hosted runs a current GoTrue where `error.code` is always set; self-hosted
 * installations may run older images without `code`, so the classifier falls
 * back on the stable English message strings, then on HTTP status.
 */

export type AuthErrorKind =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'rate_limited'
  | 'user_banned'
  | 'email_exists'
  | 'weak_password'
  | 'email_invalid'
  | 'signup_disabled'
  | 'unknown'

const CODE_MAP: Record<string, AuthErrorKind> = {
  invalid_credentials: 'invalid_credentials',
  email_not_confirmed: 'email_not_confirmed',
  over_request_rate_limit: 'rate_limited',
  over_email_send_rate_limit: 'rate_limited',
  user_banned: 'user_banned',
  user_already_exists: 'email_exists',
  email_exists: 'email_exists',
  weak_password: 'weak_password',
  email_address_invalid: 'email_invalid',
  signup_disabled: 'signup_disabled',
  email_provider_disabled: 'signup_disabled',
}

export function classifyAuthError(error: unknown): AuthErrorKind {
  if (typeof error !== 'object' || error === null) return 'unknown'
  const { code, message, status } = error as {
    code?: unknown
    message?: unknown
    status?: unknown
  }

  if (typeof code === 'string' && CODE_MAP[code]) return CODE_MAP[code]

  if (typeof message === 'string') {
    if (/invalid login credentials/i.test(message)) return 'invalid_credentials'
    if (/email not confirmed/i.test(message)) return 'email_not_confirmed'
    if (/already registered/i.test(message)) return 'email_exists'
    if (/signups? not allowed/i.test(message)) return 'signup_disabled'
    if (/signups? (are )?disabled/i.test(message)) return 'signup_disabled'
    if (/rate limit/i.test(message)) return 'rate_limited'
  }

  if (status === 429) return 'rate_limited'

  return 'unknown'
}
