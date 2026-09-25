/**
 * Which bank a cash account belongs to, for the Konto cell on /transactions
 * and the brand marks on the agents pages.
 *
 * The bank is the connection's bank_name (what the person picked in the
 * connect flow), read through cash_accounts.bank_connection_id; an account
 * without a connection (bank-file import, manual) falls back to its own name.
 *
 * Never the payee columns. cash_accounts.bank_name and account_number are
 * what the company PRINTS on customer invoices (CashAccountPayeeFields); the
 * 20260904010000 backfill, and an admin in settings, may put those details on
 * any bank account of the company. The backfill did land a Northmill payee on
 * a Revolut SEK account, and every Revolut row then read "Northmill" on
 * /transactions.
 *
 * Pure: no Supabase, no logger, safe in the client bundle.
 */

import type { CashAccount } from '@/types'
import { bankLogoUrl } from '@/lib/reconciliation/bank-logos'

/**
 * A cash_accounts row with its connection's bank name embedded:
 * `select('*, bank_connection:bank_connections(bank_name)')`. The reference
 * list (lib/reference-data/fetchers.ts) and the dashboard layout's seed both
 * select exactly that, as literals so the phantom-column scanner
 * (tests/schema) checks the embed.
 */
export type CashAccountWithBank = CashAccount & {
  bank_connection: { bank_name: string | null } | null
}

/** The bank the account belongs to, or null when nothing names it. */
export function cashAccountBankName(account: CashAccountWithBank): string | null {
  return account.bank_connection?.bank_name || account.name || null
}

/**
 * Konto cell text: the bank plus the account's last digits (from its bank
 * IBAN, the identity every sync writes), or its ledger account when the
 * account has no IBAN.
 */
export function cashAccountKontoLabel(account: CashAccountWithBank): string {
  const bank = cashAccountBankName(account) ?? ''
  const iban = account.iban?.replace(/\s/g, '') ?? ''
  const tail = iban ? `••${iban.slice(-4)}` : account.ledger_account
  return `${bank} ${tail}`.trim()
}

/**
 * The brand mark for the account: matched on the connection's bank name
 * first, then the account's own name (a Sparbank connects through Swedbank
 * and may only be recognisable by its account name).
 */
export function cashAccountLogoUrl(account: CashAccountWithBank): string | null {
  return bankLogoUrl(account.bank_connection?.bank_name, account.name)
}
