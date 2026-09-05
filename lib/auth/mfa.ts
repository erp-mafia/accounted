/**
 * MFA (Multi-Factor Authentication) helpers.
 *
 * MFA is only required on the hosted version, never for self-hosted deployments.
 * Enforcement is application-side (middleware + API routes), not RLS.
 */

import { flagEnabled, isSelfHosted } from '@/lib/env/public-flags'

export function isMfaRequired(): boolean {
  if (isSelfHosted()) return false
  return flagEnabled(process.env.NEXT_PUBLIC_REQUIRE_MFA)
}

/**
 * A time-boxed exemption: `app_metadata.mfa_exempt_until` holds an ISO
 * timestamp, and the gate is skipped only while that instant is in the
 * future. app_metadata is written only through the service role (never from a
 * browser session), so this is an operator switch for the one kind of account
 * that must be usable by someone who cannot enrol an authenticator: Google's
 * OAuth verification reviewers, who log in with credentials we hand them and
 * treat any second factor as an "authentication blocker".
 *
 * Time-boxed rather than a boolean so a forgotten flag cannot outlive the
 * review: the exemption dies on its own. Anything malformed enforces MFA.
 */
export function isMfaExemptionActive(
  user: { app_metadata?: Record<string, unknown> },
  now: Date = new Date(),
): boolean {
  const until = user.app_metadata?.mfa_exempt_until
  if (typeof until !== 'string') return false
  const expires = Date.parse(until)
  if (Number.isNaN(expires)) return false
  return expires > now.getTime()
}

/**
 * Check if MFA should be enforced for a specific user.
 * BankID-linked users skip TOTP because BankID is inherently 2FA. So does a
 * BankID signup whose address is still unproven (bankid_pending): the person
 * is just as verified, only the mailbox is not, and such an account has no
 * password of its own (has_password: false) so it could not even enrol TOTP.
 * A live, time-boxed exemption (see isMfaExemptionActive) also skips it.
 */
export function shouldEnforceMfa(user: { app_metadata?: Record<string, unknown> }): boolean {
  if (!isMfaRequired()) return false
  if (user.app_metadata?.bankid_linked) return false
  if (user.app_metadata?.bankid_pending === true) return false
  if (isMfaExemptionActive(user)) return false
  return true
}
