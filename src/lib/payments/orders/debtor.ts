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

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeIban } from '@/lib/cash-accounts/ledger-slots'
import { isValidIban } from '@/lib/payments/payment-details'
import { lookupBicByBankName, lookupBicByClearing } from '@/lib/payments/bank-account'

export interface DebtorAccountSource {
  iban: string | null
  currency: string
  name: string | null
  enabled: boolean
}

/** What the paying account's bank connection knows about the bank behind it; null for an account with no connection. */
export interface DebtorConnectionSource {
  bank_name: string | null
  /** The sparbank (or Ölands Bank) behind a shared BIC, as the Open Payments connection stores it; null elsewhere. */
  affiliated_aspsp_id?: string | null
  /** 'business' or 'personal': the account context chosen when the bank was connected. */
  psu_type?: string | null
}

export interface DebtorSnapshot {
  iban: string
  bban: string | null
  bic: string
  name: string | null
  currency: string
  bank_name: string | null
  /** Sent as X-AffiliatedASPSP-ID on every payment call; absent on snapshots taken before 2026-10-14. */
  affiliated_aspsp_id?: string | null
  /** Decides the account context of every payment call (personal: private, else corporate); absent on older snapshots. */
  psu_type?: string | null
}

/**
 * The account context of a payment call from the connection's psu_type: an
 * enskild firma whose bank agreement is the owner's private one connected as
 * 'personal' pays as 'private'; everything else, unknown included, as
 * 'corporate'. Mirrors accountContextOf in lib/bank-feed/party.ts so a
 * payment and the reads of the same account tell the bank the same thing.
 */
export function paymentAccountContext(psuType: string | null | undefined): 'corporate' | 'private' {
  return psuType === 'personal' ? 'private' : 'corporate'
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

export function resolveDebtor(account: DebtorAccountSource, connection: DebtorConnectionSource | null): DebtorResolution {
  if (!account.enabled) return { ok: false, reason: 'account_disabled' }
  if ((account.currency ?? '').toUpperCase() !== 'SEK') return { ok: false, reason: 'not_sek' }
  if (!account.iban || !isValidIban(account.iban)) return { ok: false, reason: 'iban_missing' }
  const iban = normalizeIban(account.iban) as string
  const bankName = connection?.bank_name ?? null
  const bic = bicFromSwedishIban(iban) ?? lookupBicByBankName(bankName)
  if (!bic) return { ok: false, reason: 'bank_unknown' }
  return {
    ok: true,
    debtor: {
      iban,
      bban: null,
      bic,
      name: account.name,
      currency: 'SEK',
      bank_name: bankName,
      // Enable Banking connections store no affiliate: null, nothing is derived.
      affiliated_aspsp_id: connection?.affiliated_aspsp_id ?? null,
      psu_type: connection?.psu_type ?? null,
    },
  }
}

/**
 * The company's account a payment leaves from, as the debtor snapshot an
 * order carries: the cash account and the bank connection behind it, through
 * resolveDebtor. 'not_found' for an account the company does not have. Every
 * prepare reads it here (supplier invoices, the skattekonto), so they pay
 * from an account by one rule.
 */
export async function loadDebtor(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
): Promise<DebtorResolution | { ok: false; reason: 'not_found' }> {
  const { data: account } = await supabase
    .from('cash_accounts')
    .select('id, iban, currency, name, enabled, bank_connection:bank_connections(bank_name, affiliated_aspsp_id, psu_type)')
    .eq('id', cashAccountId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!account) return { ok: false, reason: 'not_found' }
  const acct = account as unknown as DebtorAccountSource & { bank_connection: DebtorConnectionSource | null }
  return resolveDebtor(acct, acct.bank_connection)
}
