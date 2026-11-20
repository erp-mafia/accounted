/**
 * Which cash account a bank FILE belongs to (crm#1204).
 *
 * A bank file names its own account (see BankFileAccountIdentity). The import
 * used to drop that and bind the rows to whatever ledger the user picked from
 * the chart: a chart imported from SIE names 1930 after the bank account
 * ("Företagskonto 8105-..."), so a statement of the account already synced on
 * 1931 landed on 1930. The dedup account guard (sameCashAccount) then saw two
 * accounts, rightly, and every row the bank feed already held came in again.
 *
 * The fix is to put the file on the cash account that already IS its bank
 * account, so the existing guard compares like with like; not a second,
 * IBAN-keyed duplicate check beside it. This module is the one rule for "this
 * file is that cash account":
 *   - both sides carry an IBAN: equal IBANs, nothing else;
 *   - otherwise the Swedish domestic number: the 17-digit account part of a
 *     Swedish IBAN, the BBAN a bank feed stores, or the clearing and account
 *     number typed in for invoices, against the clearing and account number
 *     the file prints.
 * A match must account for every digit the file prints, in order, with only
 * zero padding between them (banks pad differently), so two different
 * accounts never match. A bank the rule cannot read simply does not match,
 * and the import works as before.
 *
 * Client-safe: no server imports, so the wizard and the routes share it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeIban } from '@/lib/cash-accounts/ledger-slots'
import type { BankFileAccountIdentity } from '@/lib/import/bank-file/types'

/** The cash_accounts columns the rule reads. */
export interface FileAccountCandidate {
  ledger_account: string
  iban: string | null
  bban: string | null
  clearing_number: string | null
  account_number: string | null
  currency: string | null
  enabled: boolean
  is_primary: boolean
  bank_connection_id: string | null
}

export interface FileAccountMatch {
  /** Where the import settles: the bank-fed, enabled row first when several match. */
  ledger_account: string
  /** Every ledger whose cash account is the file's bank account (twins after a reconnect). */
  ledger_accounts: string[]
}

/** Fewest digits an account number alone must carry to stand for an account. */
const MIN_ACCOUNT_DIGITS = 7

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

function stripLeadingZeros(value: string): string {
  return value.replace(/^0+/, '')
}

/** The 17-digit account part of a Swedish IBAN (SEkk + bank code + 17), else null. */
function swedishAccountPart(iban: string | null): string | null {
  return iban && /^SE\d{22}$/.test(iban) ? iban.slice(7) : null
}

/**
 * Whether a printed (clearing, account number) pair is the domestic number
 * `domestic`. Each reading must use every printed digit: clearing then
 * account with zero padding around them, or the account number alone (some
 * banks keep the clearing number out of the IBAN). When no clearing column
 * exists, the first four (or, for Swedbank's 8xxx-x, five) printed digits
 * are tried as the clearing number.
 */
function printedMatchesDomestic(
  printed: { clearing: string | null; account: string | null },
  domestic: string,
): boolean {
  const account = digits(printed.account)
  if (!account || !/^\d+$/.test(domestic)) return false
  const clearing = digits(printed.clearing)
  const readings: Array<[string, string]> = clearing
    ? [[clearing, account]]
    : [['', account], [account.slice(0, 4), account.slice(4)], [account.slice(0, 5), account.slice(5)]]
  for (const [c, a] of readings) {
    const rest = stripLeadingZeros(a)
    if (!rest) continue
    if (c) {
      // A Swedbank clearing printed without its fifth (check) digit.
      const checkDigit = c.length === 4 && c.startsWith('8') ? '\\d?' : ''
      if (new RegExp(`^0*${c}${checkDigit}0*${rest}$`).test(domestic)) return true
    }
    if (rest.length >= MIN_ACCOUNT_DIGITS && new RegExp(`^0*${rest}$`).test(domestic)) return true
  }
  return false
}

/** The domestic numbers a cash account is known by. */
function domesticNumbersOf(row: FileAccountCandidate): string[] {
  const numbers: string[] = []
  const ibanPart = swedishAccountPart(normalizeIban(row.iban))
  if (ibanPart) numbers.push(ibanPart)
  const bban = digits(row.bban)
  if (bban.length >= MIN_ACCOUNT_DIGITS) numbers.push(bban)
  const typed = digits(row.clearing_number) + digits(row.account_number)
  if (digits(row.account_number) && typed.length >= MIN_ACCOUNT_DIGITS) numbers.push(typed)
  return numbers
}

/** Whether the file's identity is this cash account's bank account. */
export function isFileAccount(identity: BankFileAccountIdentity, row: FileAccountCandidate): boolean {
  const fileIban = normalizeIban(identity.iban)
  const rowIban = normalizeIban(row.iban)
  if (fileIban && rowIban) return fileIban === rowIban

  const printed = fileIban
    ? { clearing: null, account: swedishAccountPart(fileIban) }
    : { clearing: identity.clearing, account: identity.account_number }
  if (!printed.account) return false
  return domesticNumbersOf(row).some((domestic) => printedMatchesDomestic(printed, domestic))
}

/** Bank-fed enabled rows first, then enabled, then primary, then by ledger. */
function preference(row: FileAccountCandidate): number {
  return (row.enabled && row.bank_connection_id ? 0 : row.enabled ? 2 : 4) + (row.is_primary ? 0 : 1)
}

/**
 * The cash account(s) a file belongs to, or null when none is its bank
 * account. `currency` (the file's) keeps a multi-currency account's other
 * pockets out: they share the IBAN but are other cash accounts.
 */
export function matchFileAccount(
  identity: BankFileAccountIdentity | null | undefined,
  rows: FileAccountCandidate[],
  currency?: string | null,
): FileAccountMatch | null {
  if (!identity) return null
  const wantedCurrency = currency?.toUpperCase() || null
  const matches = rows
    .filter((row) => !wantedCurrency || !row.currency || row.currency.toUpperCase() === wantedCurrency)
    .filter((row) => isFileAccount(identity, row))
    .sort((a, b) => preference(a) - preference(b) || a.ledger_account.localeCompare(b.ledger_account))
  if (matches.length === 0) return null
  return {
    ledger_account: matches[0].ledger_account,
    ledger_accounts: [...new Set(matches.map((row) => row.ledger_account))],
  }
}

/** The file's account as the bank prints it, for the wizard. */
export function fileAccountLabel(identity: BankFileAccountIdentity): string {
  if (identity.iban) return identity.iban.replace(/(.{4})(?=.)/g, '$1 ')
  return [identity.clearing, identity.account_number].filter(Boolean).join(', ')
}

/**
 * Read the company's cash accounts and match the file to them. Throws on a
 * failed read: the caller decides whether the match is advisory (the parse
 * preview) or a guard (execute).
 */
export async function loadFileAccountMatch(
  supabase: SupabaseClient,
  companyId: string,
  identity: BankFileAccountIdentity | null | undefined,
  currency?: string | null,
): Promise<FileAccountMatch | null> {
  if (!identity) return null
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('ledger_account, iban, bban, clearing_number, account_number, currency, enabled, is_primary, bank_connection_id')
    .eq('company_id', companyId)
  if (error) throw new Error(`cash account lookup failed: ${error.message}`)
  return matchFileAccount(identity, (data ?? []) as FileAccountCandidate[], currency)
}
