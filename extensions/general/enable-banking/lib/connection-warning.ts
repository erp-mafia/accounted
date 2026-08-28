/**
 * Same-bank connection warning: decides IF and HOW to warn before a user
 * authorizes a bank that already has live connections in their other
 * companies.
 *
 * The scary "your other connections may stop syncing" dialog used to fire for
 * every bank. That is only true for banks that bind one active AIS session per
 * PSU; at banks that allow several (verified for Handelsbanken in prod
 * 2026-08-28: one user runs four concurrent business connections that all sync
 * daily), the warning scared users away from perfectly safe renewals.
 *
 * Pure module (no React, no fetch) so the decision table is unit-testable.
 */

/**
 * Banks where prod evidence shows one active AIS session per PSU: authorizing
 * company B kills company A's session bank-side. Matched against the Enable
 * Banking ASPSP name stored in bank_connections.bank_name. Extend only with
 * observed evidence, not suspicion: a wrong entry here re-introduces the
 * false alarm this module exists to remove.
 */
export const ONE_SESSION_BANKS = ['SEB']

export function isOneSessionBank(bankName: string): boolean {
  const normalized = bankName.trim().toUpperCase()
  return ONE_SESSION_BANKS.some(known => normalized === known.toUpperCase())
}

export interface SameBankWarningInput {
  bankName: string
  /** Names of the user's OTHER companies holding a connection to this bank. */
  clashCompanyNames: string[]
  /** Number of clashing connections (company names may be fewer if unknown). */
  clashCount: number
  /** True when renewing an existing connection, false for a fresh connect. */
  isReconnect: boolean
}

export interface SameBankWarning {
  title: string
  description: string
  confirmLabel: string
  variant: 'warning'
}

/**
 * The dialog to show before proceeding, or null to proceed silently.
 *
 * Decision table:
 * - No clash: null (nothing to warn about).
 * - One-session bank: the hard warning, on fresh connect AND reconnect
 *   (either one mints a new authorization that revokes the sibling session).
 * - Other banks, reconnect: null. The connection being renewed already
 *   coexisted with the siblings; warning here blocks legitimate renewals
 *   (a real user abandoned an expired-connection renewal at this dialog).
 * - Other banks, fresh connect: a calm confirmation, so a user who meant to
 *   renew notices they are about to create a second connection instead.
 */
export function sameBankWarning(input: SameBankWarningInput): SameBankWarning | null {
  const { bankName, clashCompanyNames, clashCount, isReconnect } = input
  if (clashCount <= 0) return null

  const companyList = clashCompanyNames.length > 0 ? ` (${clashCompanyNames.join(', ')})` : ''
  const inOtherCompanies = clashCount === 1 ? 'ett annat bolag' : 'andra bolag'

  if (isOneSessionBank(bankName)) {
    return {
      title: `Du har redan ${clashCount} ${clashCount === 1 ? 'anslutning' : 'anslutningar'} till ${bankName}`,
      description:
        `${bankName} är sedan tidigare ansluten i ${inOtherCompanies}${companyList}. ` +
        `${bankName} tillåter bara en aktiv anslutning per inloggning: när du slutför den här slutar ` +
        'de andra att synka och behöver förnyas.',
      confirmLabel: 'Fortsätt ändå',
      variant: 'warning',
    }
  }

  if (isReconnect) return null

  return {
    title: `${bankName} är redan ansluten i ${inOtherCompanies}`,
    description:
      `${bankName} är sedan tidigare ansluten i ${inOtherCompanies}${companyList}. ` +
      'Du kan ansluta banken även för det här bolaget; bolagen får varsin koppling. ' +
      'Om du i stället ville förnya en befintlig koppling gör du det från bolaget som äger den.',
    confirmLabel: 'Anslut',
    variant: 'warning',
  }
}
