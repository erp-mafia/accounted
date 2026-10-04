/**
 * The paying side of a bank payment: the company's own account and its bank.
 *
 * A payment API addresses the bank by BIC (Open Payments' X-BicFi). A Swedish
 * IBAN carries a three-digit bank code right after the check digits, and that
 * code is the start of the bank's clearing series, so the clearing table the
 * salary payment file already trusts (lookupBicByClearing) resolves it; the
 * bank name of the connection is the fallback for banks outside that table.
 * An account whose bank cannot be named confidently is refused, never guessed.
 */

import { normalizeIban } from '@/lib/cash-accounts/service'
import { isValidIban } from '@/lib/supplier-invoices/payment-details-backfill'
import { lookupBicByBankName, lookupBicByClearing } from '@/lib/salary/payment/bank-account'

export interface DebtorAccountSource {
  iban: string | null
  currency: string
  name: string | null
  enabled: boolean
}

export interface DebtorSnapshot {
  iban: string
  bban: string | null
  bic: string
  name: string | null
  currency: string
  bank_name: string | null
}

export type DebtorResolution =
  | { ok: true; debtor: DebtorSnapshot }
  | { ok: false; reason: 'account_disabled' | 'not_sek' | 'iban_missing' | 'bank_unknown' }

/** BIC for a Swedish IBAN from its bank code, or null when the code is not confidently known. */
export function bicFromSwedishIban(iban: string): string | null {
  const normalized = normalizeIban(iban)
  if (!normalized?.startsWith('SE') || normalized.length !== 24) return null
  const bankCode = normalized.slice(4, 7)
  return lookupBicByClearing(`${bankCode}0`)
}

export function resolveDebtor(account: DebtorAccountSource, bankName: string | null): DebtorResolution {
  if (!account.enabled) return { ok: false, reason: 'account_disabled' }
  if ((account.currency ?? '').toUpperCase() !== 'SEK') return { ok: false, reason: 'not_sek' }
  if (!account.iban || !isValidIban(account.iban)) return { ok: false, reason: 'iban_missing' }
  const iban = normalizeIban(account.iban) as string
  const bic = bicFromSwedishIban(iban) ?? lookupBicByBankName(bankName)
  if (!bic) return { ok: false, reason: 'bank_unknown' }
  return {
    ok: true,
    debtor: { iban, bban: null, bic, name: account.name, currency: 'SEK', bank_name: bankName },
  }
}
