/**
 * The bank accounts a connection syncs, as the rows under its settings row
 * show them, and the 19xx accounts each may move to (crm#1387). Pure, so the
 * rule is tested without React.
 */

import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import type { ChartBankAccount } from './account-selection'

/** The fields of a cash_accounts row (with its connection) read here. */
export interface CashAccountRowLike {
  id: string
  bank_connection_id: string | null
  external_uid: string | null
  enabled: boolean
  name: string | null
  iban: string | null
  currency: string
  ledger_account: string
  bank_connection?: { status?: string | null } | null
}

export interface SyncedBankAccount {
  cashAccountId: string
  uid: string
  name: string | null
  ibanLast4: string | null
  currency: string
  ledger: string
}

function last4(iban: string | null): string | null {
  const normalized = (iban ?? '').replace(/\s+/g, '').toUpperCase()
  return normalized ? normalized.slice(-4) : null
}

/** The accounts the connection syncs into the books, in ledger order. */
export function syncedAccountsOf(connectionId: string, cashAccounts: readonly CashAccountRowLike[]): SyncedBankAccount[] {
  return cashAccounts
    .filter((row) => row.bank_connection_id === connectionId && row.enabled && row.external_uid)
    .map((row) => ({
      cashAccountId: row.id,
      uid: row.external_uid as string,
      name: row.name?.trim() || null,
      ibanLast4: last4(row.iban),
      currency: row.currency,
      ledger: row.ledger_account,
    }))
    .sort((a, b) => a.ledger.localeCompare(b.ledger))
}

/**
 * Ledger accounts another live bank connection syncs onto: the database
 * refuses a move there, so the rows do not offer them. A row of this
 * connection is not among them (moving onto a sibling's account trades
 * places), and neither is a manual row (the save takes it over when it is
 * the same bank account, and names it when it is not).
 */
export function ledgersHeldElsewhere(connectionId: string, cashAccounts: readonly CashAccountRowLike[]): Set<string> {
  return new Set(
    cashAccounts
      .filter(
        (row) =>
          row.enabled &&
          row.bank_connection_id !== null &&
          row.bank_connection_id !== connectionId &&
          row.bank_connection?.status !== 'revoked',
      )
      .map((row) => row.ledger_account),
  )
}

/**
 * The 19xx accounts one bank account may book on: the chart's bank accounts
 * (as in the bank pickers: one the chart lacks is added under Kontoplan
 * first) and the current one, minus those another connection holds. Sorted
 * by number.
 */
export function ledgerChoices(
  current: string,
  chart: readonly ChartBankAccount[],
  heldElsewhere: ReadonlySet<string>,
  fallbackName: (ledger: string) => string,
): ChartBankAccount[] {
  const byNumber = new Map<string, ChartBankAccount>()
  for (const account of chart) {
    if (isCashLedger(account.account_number)) byNumber.set(account.account_number, account)
  }
  if (!byNumber.has(current)) byNumber.set(current, { account_number: current, account_name: fallbackName(current) })
  return [...byNumber.values()]
    .filter((account) => account.account_number === current || !heldElsewhere.has(account.account_number))
    .sort((a, b) => a.account_number.localeCompare(b.account_number))
}
