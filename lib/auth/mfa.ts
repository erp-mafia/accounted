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
 * Check if MFA should be enforced for a specific user.
 * BankID-linked users skip TOTP because BankID is inherently 2FA.
 *
 * `app_metadata.mfa_exempt === true` also skips it. app_metadata is written
 * only through the service role (never from a browser session), so this is an
 * operator switch for the handful of accounts that must be usable by someone
 * who cannot enrol an authenticator: Google's OAuth verification reviewers,
 * who log in with credentials we hand them and treat any second factor as an
 * "authentication blocker". Set it per account, on demo data only, and clear
 * it when the review ends.
 */
export function shouldEnforceMfa(user: { app_metadata?: Record<string, unknown> }): boolean {
  if (!isMfaRequired()) return false
  if (user.app_metadata?.bankid_linked) return false
  if (user.app_metadata?.mfa_exempt === true) return false
  return true
}
