/**
 * Same-bank connection warning: decides IF and HOW to warn before a user
 * authorizes a bank that already has live connections in their other
 * companies.
 *
 * Three tiers, strictly evidence-based (fail closed for the unknown middle):
 *
 * - Banks OBSERVED to bind one active AIS session per PSU get a hard warning
 *   on fresh connect and renewal alike: completing the authorization kills the
 *   sibling sessions bank-side.
 * - Banks VERIFIED to tolerate concurrent sessions get no dialog on renewal
 *   and a calm confirmation on fresh connect. The old generic scare dialog
 *   made a real multi-company user abandon a legitimate Handelsbanken renewal.
 * - Everything else keeps the previous hedged warning on both paths: we do
 *   not know the bank's session policy, and silence here would let a renewal
 *   silently kill a sibling company's feed at a one-session bank we have not
 *   identified yet.
 *
 * Siblings that SHARE the session being renewed are not warned about at all:
 * the renewal callback carries the new session to them (fanOutSessionRenewal
 * in session-sharing.ts), so they keep syncing whatever the bank's policy is.
 *
 * Pure module (no React, no fetch) so the decision table is unit-testable.
 */

/**
 * Banks where prod evidence shows one active AIS session per PSU: authorizing
 * company B kills company A's session bank-side. Matched against the Enable
 * Banking ASPSP name stored in bank_connections.bank_name.
 */
export const ONE_SESSION_BANKS = ['SEB']

/**
 * Banks VERIFIED to tolerate several concurrent AIS sessions for one PSU.
 * Evidence bar: distinct session_ids observed syncing concurrently in prod.
 * Handelsbanken verified 2026-08-28: three users with 2-4 concurrent business
 * connections each, all on DISTINCT session_ids, all syncing daily.
 * Extend only with the same standard of evidence; connection count alone is
 * not enough, since several connections can share one session.
 */
export const VERIFIED_MULTI_SESSION_BANKS = ['Handelsbanken']

function matches(list: readonly string[], bankName: string | null | undefined): boolean {
  const normalized = (bankName ?? '').trim().toUpperCase()
  if (!normalized) return false
  return list.some(known => normalized === known.toUpperCase())
}

export function isOneSessionBank(bankName: string | null | undefined): boolean {
  return matches(ONE_SESSION_BANKS, bankName)
}

export function isVerifiedMultiSessionBank(bankName: string | null | undefined): boolean {
  return matches(VERIFIED_MULTI_SESSION_BANKS, bankName)
}

/** One clashing connection in another of the user's companies. */
export interface SameBankClash {
  companyName: string | null
  sessionId: string | null
}

export interface SameBankWarningInput {
  bankName: string | null | undefined
  /** The user's OTHER companies' live connections to this bank. */
  clashes: SameBankClash[]
  /** True when renewing an existing connection, false for a fresh connect. */
  isReconnect: boolean
  /** session_id of the connection being renewed, to exempt shared-session
   *  siblings (the renewal is fanned out to them, they never break). */
  currentSessionId?: string | null
}

export interface SameBankWarning {
  title: string
  description: string
  confirmLabel: string
  variant: 'warning'
}

/** The dialog to show before proceeding, or null to proceed silently. */
export function sameBankWarning(input: SameBankWarningInput): SameBankWarning | null {
  const { bankName, clashes, isReconnect, currentSessionId } = input

  // Siblings on the session being renewed ride along on the renewal
  // (fanOutSessionRenewal): they are not at risk and must not inflate the
  // warning. A null session on either side proves nothing, so it never exempts.
  const atRisk = currentSessionId
    ? clashes.filter(c => c.sessionId !== currentSessionId)
    : clashes
  if (atRisk.length === 0) return null

  const bank = (bankName ?? '').trim() || 'Banken'
  const names = [...new Set(atRisk.map(c => c.companyName).filter((n): n is string => !!n))]
  const companyList = names.length > 0 ? ` (${names.join(', ')})` : ''
  // Phrase by companies when known, else by connection count: one company can
  // legitimately hold two connections (privat + företag) to the same bank.
  const companyCount = names.length > 0 ? names.length : atRisk.length
  const inOtherCompanies = companyCount === 1 ? 'ett annat bolag' : 'andra bolag'
  const count = atRisk.length

  if (isOneSessionBank(bank)) {
    return {
      title: `Du har redan ${count} ${count === 1 ? 'anslutning' : 'anslutningar'} till ${bank}`,
      description:
        `${bank} är sedan tidigare ansluten i ${inOtherCompanies}${companyList}. ` +
        `${bank} tillåter bara en aktiv anslutning per inloggning: när du slutför den här slutar ` +
        'de andra att synka och behöver förnyas.',
      confirmLabel: 'Fortsätt ändå',
      variant: 'warning',
    }
  }

  if (isVerifiedMultiSessionBank(bank)) {
    if (isReconnect) return null
    return {
      title: `${bank} är redan ansluten i ${inOtherCompanies}`,
      description:
        `${bank} är sedan tidigare ansluten i ${inOtherCompanies}${companyList}. ` +
        'Du kan ansluta banken även för det här bolaget; bolagen får varsin koppling. ' +
        'Om du i stället ville förnya en befintlig koppling gör du det från bolaget som äger den.',
      confirmLabel: 'Anslut',
      variant: 'warning',
    }
  }

  // Unknown session policy: keep the previous hedged warning on BOTH paths.
  return {
    title: `Du har redan ${count} ${count === 1 ? 'anslutning' : 'anslutningar'} till ${bank}`,
    description:
      `${bank} är sedan tidigare ansluten i ${inOtherCompanies}${companyList}. ` +
      'Vissa banker tillåter bara en aktiv anslutning per inloggning: när du slutför den här kan de andra sluta synka ' +
      'och behöva förnyas. Fortsätt om du vet att din bank tillåter flera.',
    confirmLabel: 'Fortsätt',
    variant: 'warning',
  }
}
