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
 */
export function shouldEnforceMfa(user: { app_metadata?: Record<string, unknown> }): boolean {
  if (!isMfaRequired()) return false
  if (user.app_metadata?.bankid_linked) return false
  return true
}
