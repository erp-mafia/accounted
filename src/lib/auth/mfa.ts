/**
 * MFA (Multi-Factor Authentication) helpers.
 *
 * On hosted, anyone with a verified factor is stepped up to AAL2; forcing
 * enrolment on users without one is what NEXT_PUBLIC_REQUIRE_MFA controls.
 * Self-hosted deployments have no MFA gates. Enforcement is application-side
 * (middleware + API routes), not RLS.
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
 * Whether a user stands outside every MFA gate: BankID-linked users (BankID
 * is inherently 2FA) and a live, time-boxed exemption (isMfaExemptionActive).
 */
export function isMfaExempt(user: { app_metadata?: Record<string, unknown> }): boolean {
  if (user.app_metadata?.bankid_linked) return true
  return isMfaExemptionActive(user)
}

/**
 * Whether a session below AAL2 must be stepped up, given that the user has a
 * verified factor to step up with (callers check the factor server-side).
 *
 * Independent of NEXT_PUBLIC_REQUIRE_MFA on purpose. Someone who enrolled an
 * authenticator has asked for it, and their password alone must not open the
 * account. Production ran with the flag's value unreadable ("true\n", never
 * equal to "true"), and because the step-up used to hang on the flag, every
 * enrolled user was let in at AAL1 by anyone holding the password. The flag
 * now only decides whether users WITHOUT a factor must enrol one
 * (shouldEnforceMfa). Self-hosted keeps its own policy: no MFA gates.
 */
export function mfaStepUpApplies(user: { app_metadata?: Record<string, unknown> }): boolean {
  if (isSelfHosted()) return false
  return !isMfaExempt(user)
}

/**
 * Whether a user WITHOUT a verified factor must enrol one before using the
 * app: hosted with NEXT_PUBLIC_REQUIRE_MFA on, and not exempt. A user who has
 * a factor is stepped up whatever this says (mfaStepUpApplies).
 */
export function shouldEnforceMfa(user: { app_metadata?: Record<string, unknown> }): boolean {
  if (!isMfaRequired()) return false
  return !isMfaExempt(user)
}
