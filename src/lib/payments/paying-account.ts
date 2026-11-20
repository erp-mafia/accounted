/**
 * The company account a payment file pays from (pain.001 DbtrAcct and
 * DbtrAgt): one rule for the salary file, the supplier payment batch and the
 * Skatteverket tax file (crm#1483).
 *
 * Which account. The one the salary verifikat credits the net pay on: for a
 * booked run the bank account on its posted salary entry (the caller passes
 * it, postedNetPayAccount), otherwise the company's primary bank account by
 * resolvePrimaryBankAccountRow, the resolution the booking itself uses, so
 * the books and the file cannot name different accounts. Before this, every
 * file read company_settings.iban, a mirror of the SEK customer-invoice
 * payee: a company whose invoices printed its savings account paid its
 * salaries from savings while the verifikat credited 1930.
 *
 * IBAN. A connected account (bank_connection_id) pays from the IBAN its bank
 * reports (iban), a manual one from the IBAN entered for it (payee_iban);
 * each falls back to the other. An account with neither borrows
 * company_settings.iban only where that cannot be another account's IBAN:
 * the account is the company's only enabled SEK bank account, or the company
 * has no bank accounts at all (the setup from before cash accounts, where the
 * IBAN lived in settings alone). Otherwise the file is refused, naming the
 * account. A company card (kind 'card') never pays a file and is never
 * counted here.
 *
 * BIC. The BIC saved on the account, else the one its bank connection names,
 * else looked up from the IBAN's bank code, the account's clearing number or
 * its bank name (bic_derived: a lookup can be wrong, so the salary file warns
 * about it). An IBAN borrowed from company_settings brings the BIC saved
 * beside it there first, as it always has; company_settings.bic never pairs
 * with an account's own IBAN.
 *
 * Out of scope here: a Bankgirot LB file is sent from company_settings
 * .bankgiro, and Swedbank's SignerID and Corporate Pay id stay company-level
 * (lib/payments/swedbank.ts). The bank-API payments resolve their own debtor
 * from the account the person picks (lib/payments/orders/debtor.ts), whose
 * BIC pieces this reuses.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { resolvePrimaryBankAccountRow } from '@/lib/bookkeeping/settlement-account'
import { normalizeIban } from '@/lib/cash-accounts/ledger-slots'
import { lookupBicByBankName, lookupBicByClearing, normalizeBankNumber } from '@/lib/payments/bank-account'
import { bicFromSwedishIban, connectionBic, type DebtorConnectionSource } from '@/lib/payments/orders/debtor'

/** The paying account as a person recognises it, without its IBAN beyond the last four characters. */
export interface PayingAccountSummary {
  /** cash_accounts.id; null when no cash account row answers (a company without cash accounts). */
  cash_account_id: string | null
  name: string | null
  ledger_account: string
  /** The last four characters of the IBAN the file pays from; null when there is none. */
  iban_last4: string | null
}

export interface PayingAccount extends PayingAccountSummary {
  iban: string
  bic: string
  /** The BIC was looked up (IBAN bank code, clearing number, bank name), not saved or named by the bank connection. */
  bic_derived: boolean
}

/** What a payment file cannot be made without on the paying account. */
export type PayingAccountMissing = 'iban' | 'bic'

export type PayingAccountResolution =
  | { ok: true; account: PayingAccount }
  | { ok: false; missing: PayingAccountMissing; account: PayingAccountSummary }

/** The legacy payer columns of company_settings, borrowed only as described above. */
export interface PayingAccountSettings {
  iban?: string | null
  bic?: string | null
}

export interface ResolvePayingAccountOptions {
  settings: PayingAccountSettings | null
  /**
   * The ledger account a booked salary run's verifikat credits the net pay on
   * (postedNetPayAccount). Omitted or null: the primary bank account, which
   * is what the booking will credit.
   */
  bookedLedgerAccount?: string | null
}

interface CashAccountRow {
  id: string
  name: string | null
  ledger_account: string
  currency: string | null
  enabled: boolean
  iban: string | null
  payee_iban: string | null
  bic: string | null
  clearing_number: string | null
  bank_name: string | null
  bank_connection_id: string | null
  bank_connection: DebtorConnectionSource | null
}

/** A BIC as a file carries it: no whitespace, upper case; null when empty. */
function normalizeBic(raw: string | null | undefined): string | null {
  const bic = (raw ?? '').replace(/\s/g, '').toUpperCase()
  return bic || null
}

/** The account's own IBAN: the bank's for a connected account, the entered one for a manual account, each falling back to the other. */
function ownIban(row: CashAccountRow): string | null {
  const reported = normalizeIban(row.iban)
  const entered = normalizeIban(row.payee_iban)
  return row.bank_connection_id ? (reported ?? entered) : (entered ?? reported)
}

export async function resolvePayingAccount(
  supabase: SupabaseClient,
  companyId: string,
  log: Logger,
  options: ResolvePayingAccountOptions,
): Promise<PayingAccountResolution> {
  const target = options.bookedLedgerAccount
    ? { id: null, ledger_account: options.bookedLedgerAccount }
    : await resolvePrimaryBankAccountRow(supabase, companyId, log)

  // A literal select, so the phantom-column guard (tests/schema) checks every column.
  const { data, error } = await supabase
    .from('cash_accounts')
    .select(
      'id, name, ledger_account, currency, enabled, iban, payee_iban, bic, clearing_number, bank_name, bank_connection_id, bank_connection:bank_connections(bank_name, bic)',
    )
    .eq('company_id', companyId)
    // Banks only: a company card pays no file, and counting one would stop
    // the only bank account borrowing the settings IBAN the day a card is added.
    .eq('kind', 'bank')
  if (error) throw new BookkeepingDatabaseError('resolve_paying_account', error.message)
  const rows = (data ?? []) as unknown as CashAccountRow[]

  // ledger_account is unique per company, so a ledger names at most one row.
  const row = rows.find((r) => (target.id ? r.id === target.id : r.ledger_account === target.ledger_account)) ?? null

  const own = row ? ownIban(row) : null
  const enabledSek = rows.filter((r) => r.enabled && isKronorCurrency(r.currency))
  const mayBorrow = rows.length === 0 || (row !== null && enabledSek.length === 1 && enabledSek[0].id === row.id)
  const borrowed = !own && mayBorrow ? normalizeIban(options.settings?.iban) : null
  const iban = own ?? borrowed

  const summary: PayingAccountSummary = {
    cash_account_id: row?.id ?? null,
    name: row?.name?.trim() || null,
    ledger_account: row?.ledger_account ?? target.ledger_account,
    iban_last4: iban ? iban.slice(-4) : null,
  }
  if (!iban) return { ok: false, missing: 'iban', account: summary }

  const settingsBic = borrowed ? normalizeBic(options.settings?.bic) : null
  const named = settingsBic ?? normalizeBic(row?.bic) ?? connectionBic(row?.bank_connection ?? null)
  const derived = named
    ? null
    : (bicFromSwedishIban(iban) ??
      lookupBicByClearing(normalizeBankNumber(row?.clearing_number)) ??
      lookupBicByBankName(row?.bank_name ?? row?.bank_connection?.bank_name ?? null))
  const bic = named ?? derived
  if (!bic) return { ok: false, missing: 'bic', account: summary }

  return {
    ok: true,
    account: { ...summary, iban, bic, bic_derived: named === null },
  }
}

/** The account as the Swedish file messages name it: "Företagskonto (1930)", or "konto 1930" without a name. */
export function payingAccountLabelSv(account: Pick<PayingAccountSummary, 'name' | 'ledger_account'>): string {
  return account.name ? `${account.name} (${account.ledger_account})` : `konto ${account.ledger_account}`
}

/** Where the paying account's IBAN and BIC are entered, for the Swedish file messages. */
export const PAYING_ACCOUNT_SETTINGS_PATH_SV = 'Inställningar → Fakturor, Bankkonton för kundfakturor'

/**
 * Why no file can be made from the paying account, in Swedish, naming the
 * account and where to fix it. A ledger account no bank account answers for
 * (a verifikat on 1930 in a company whose bank accounts sit elsewhere) is
 * fixed by adding the account: a new SEK account takes 1930 when it is free.
 */
export function payingAccountMissingSv(missing: PayingAccountMissing, account: PayingAccountSummary): string {
  const label = payingAccountLabelSv(account)
  if (missing === 'iban' && account.cash_account_id === null) {
    return (
      `Betalfilen betalar från ${label}, men inget bankkonto med IBAN hör till det. ` +
      `Lägg till bankkontot och dess IBAN under ${PAYING_ACCOUNT_SETTINGS_PATH_SV}.`
    )
  }
  return missing === 'iban'
    ? `Betalfilen betalar från ${label}, men kontot saknar IBAN. Fyll i kontots IBAN under ${PAYING_ACCOUNT_SETTINGS_PATH_SV}.`
    : `Betalfilen betalar från ${label}, men kontots bank (BIC) kunde inte avgöras. Fyll i kontots BIC under ${PAYING_ACCOUNT_SETTINGS_PATH_SV}.`
}

/** payingAccountMissingSv in English, for the doors that answer both languages. */
export function payingAccountMissingEn(missing: PayingAccountMissing, account: PayingAccountSummary): string {
  const label = account.name ? `${account.name} (${account.ledger_account})` : `account ${account.ledger_account}`
  const where = 'Settings → Invoices, Bank accounts for customer invoices'
  if (missing === 'iban' && account.cash_account_id === null) {
    return `The payment file pays from ${label}, but no bank account with an IBAN belongs to it. Add the bank account and its IBAN under ${where}.`
  }
  return missing === 'iban'
    ? `The payment file pays from ${label}, but the account has no IBAN. Fill in its IBAN under ${where}.`
    : `The payment file pays from ${label}, but the account's bank (BIC) could not be determined. Fill in its BIC under ${where}.`
}

/** The non-blocking note a file carries when its BIC was looked up rather than saved. */
export function derivedBicWarningSv(account: Pick<PayingAccount, 'bic' | 'name' | 'ledger_account'>): string {
  return (
    `BIC (${account.bic}) för ${payingAccountLabelSv(account)} härleddes från kontots IBAN, clearingnummer eller banknamn. ` +
    `Spara BIC under ${PAYING_ACCOUNT_SETTINGS_PATH_SV} om banken avvisar filen.`
  )
}

/** The account a caller may show: the summary, without the full IBAN. */
export function payingAccountSummary(account: PayingAccountSummary): PayingAccountSummary {
  return {
    cash_account_id: account.cash_account_id,
    name: account.name,
    ledger_account: account.ledger_account,
    iban_last4: account.iban_last4,
  }
}
