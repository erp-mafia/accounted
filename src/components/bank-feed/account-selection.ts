/**
 * Which of the bank's accounts go into the books and on which 19xx account.
 * The server preselects company accounts (ORGA) and leaves private ones
 * (PRIV) off; an account the company already booked keeps its ledger account
 * and cannot be moved here (the feed resumes where it stopped), a new one
 * gets the server's suggestion with the chart's bank accounts as the
 * alternatives, and the currency default follows what the person ticks
 * (followSelection). A ledger account is changed afterwards on the account's
 * own row under the connection (BankAccountLedgerRows, crm#1387).
 */

import { defaultLedgerForCurrency } from '@/lib/cash-accounts/ledger-slots'
import type { AccountSelection, PolledAccount } from './open-payments-client'

export interface AccountChoice {
  enabled: boolean
  /** The 19xx account the bank account books on; null until one is picked. */
  ledger: string | null
  /** The person chose the ledger in the picker: from then on the screen moves no ledger by itself. */
  picked?: boolean
}

export type SelectionMap = Record<string, AccountChoice>

export function isPrivateAccount(account: Pick<PolledAccount, 'usage'>): boolean {
  return account.usage === 'PRIV'
}

/** The ledger account an account arrives with: the one it had before, else the server's suggestion. */
export function initialLedger(account: Pick<PolledAccount, 'matches_existing' | 'suggested_ledger_account'>): string | null {
  return account.matches_existing ?? account.suggested_ledger_account ?? null
}

/**
 * The starting selection: what the server preselected, which is ORGA on and
 * PRIV off. A private account the server nevertheless preselected (a sole
 * trader connecting the private account used in the business) stays on.
 */
export function initialSelection(accounts: readonly PolledAccount[]): SelectionMap {
  const out: SelectionMap = {}
  for (const account of accounts) {
    out[account.uid] = { enabled: account.preselected, ledger: initialLedger(account) }
  }
  return followSelection(accounts, out)
}

export function toggleAccount(accounts: readonly PolledAccount[], selection: SelectionMap, uid: string): SelectionMap {
  const current = selection[uid]
  if (!current) return selection
  return followSelection(accounts, { ...selection, [uid]: { ...current, enabled: !current.enabled } })
}

/**
 * The person's pick. A same-currency account that held the picked number as
 * its suggestion (an unticked one: the picker leaves out what ticked accounts
 * hold) takes the picked account's old number instead, so ticking it later
 * does not put a suggestion on a number already chosen.
 */
export function setLedger(accounts: readonly PolledAccount[], selection: SelectionMap, uid: string, ledger: string): SelectionMap {
  const current = selection[uid]
  if (!current) return selection
  const next: SelectionMap = { ...selection, [uid]: { ...current, ledger, picked: true } }
  const picker = accounts.find((a) => a.uid === uid)
  const holder = accounts.find((a) => a.uid !== uid && selection[a.uid]?.ledger === ledger && movable(a, selection[a.uid]))
  if (holder && picker && sameCurrency(holder, picker)) next[holder.uid] = { ...selection[holder.uid], ledger: current.ledger }
  return next
}

/**
 * A suggestion the screen may move: one the server handed out fresh, not the
 * number the account already books on (matches_existing) or had before
 * (ledger_kept, absent read as kept), and not one the person picked.
 */
function movable(account: PolledAccount, choice: AccountChoice | undefined): boolean {
  return choice !== undefined && !choice.picked && account.matches_existing === null && account.ledger_kept === false
}

function sameCurrency(a: Pick<PolledAccount, 'currency'>, b: Pick<PolledAccount, 'currency'>): boolean {
  return a.currency.toUpperCase() === b.currency.toUpperCase()
}

/**
 * The currency default (1930 for SEK) goes to an account the person ticks.
 *
 * The server deals its suggestions before anyone has chosen, in the bank's
 * order with the preselected (ORGA) accounts first. When nothing is
 * preselected, as with a sole trader whose accounts all read PRIV, the
 * default can go to an account the person leaves unticked while the one they
 * tick gets an overflow number (1935). The default is the number that takes
 * over the company's existing row on it (the seeded 1930, or the one a bank
 * file was imported to), and only on that row does the first sync compare the
 * feed with the rows already there. On 1935 the feed brought the file's
 * movements a second time, and moving it to 1930 later showed each one twice
 * (crm#1701).
 *
 * So a fresh default on an unticked account trades numbers with the first
 * ticked account of its currency, in the bank's order. A default the server
 * gave a preselected account stays with it even unticked: that was a choice
 * (the company's own account, or the one the seeded row's payment details
 * name, crm#1498), not the listing order. Once the person picks a ledger
 * themselves, nothing moves by itself.
 */
function followSelection(accounts: readonly PolledAccount[], selection: SelectionMap): SelectionMap {
  if (Object.values(selection).some((choice) => choice.picked)) return selection
  const defaults = accounts.flatMap((a) =>
    a.suggested_ledger_account !== null && a.suggested_ledger_account === defaultLedgerForCurrency(a.currency) && movable(a, selection[a.uid])
      ? [{ ledger: a.suggested_ledger_account, currency: a.currency.toUpperCase() }]
      : [],
  )
  let next = selection
  for (const { ledger, currency } of defaults) {
    if (accounts.some((a) => next[a.uid]?.enabled && next[a.uid]?.ledger === ledger)) continue
    const holder = accounts.find((a) => next[a.uid]?.ledger === ledger)
    if (!holder || holder.preselected || !movable(holder, next[holder.uid])) continue
    const target = accounts.find((a) => a.currency.toUpperCase() === currency && next[a.uid]?.enabled && movable(a, next[a.uid]))
    if (!target) continue
    next = {
      ...next,
      [target.uid]: { ...next[target.uid], ledger },
      [holder.uid]: { ...next[holder.uid], ledger: next[target.uid].ledger },
    }
  }
  return next
}

/** An account that already books somewhere keeps that ledger: no picker. */
export function ledgerLocked(account: Pick<PolledAccount, 'matches_existing'>): boolean {
  return account.matches_existing !== null
}

/** The enabled accounts, in the bank's order. */
export function enabledAccounts(accounts: readonly PolledAccount[], selection: SelectionMap): PolledAccount[] {
  return accounts.filter((a) => selection[a.uid]?.enabled)
}

/**
 * Why the selection cannot be activated yet, or null when it can.
 * `no_accounts`: the bank signed the consent but listed no account (crm#1445),
 * so there is nothing to choose and Välj minst ett konto would be a dead end.
 */
export function selectionBlocker(accounts: readonly PolledAccount[], selection: SelectionMap): 'no_accounts' | 'none_enabled' | 'ledger_missing' | null {
  if (accounts.length === 0) return 'no_accounts'
  const enabled = enabledAccounts(accounts, selection)
  if (enabled.length === 0) return 'none_enabled'
  if (enabled.some((a) => !selection[a.uid]?.ledger)) return 'ledger_missing'
  return null
}

/** The body of POST .../select: every account, on or off, with its ledger when on. */
export function selectionPayload(accounts: readonly PolledAccount[], selection: SelectionMap): AccountSelection[] {
  return accounts.map((a) => {
    const choice = selection[a.uid]
    const enabled = Boolean(choice?.enabled)
    return { uid: a.uid, enabled, ledger_account: enabled ? (choice?.ledger ?? null) : null }
  })
}

/** A chart account as the picker needs it. */
export interface ChartBankAccount {
  account_number: string
  account_name: string
}

/**
 * The 19xx accounts to choose from for one bank account: the chart's bank
 * accounts (1900-1999), with the current choice first when the chart lacks it
 * (a suggestion the server made for an account the company has not created
 * yet; the server creates it on activation). Accounts another enabled bank
 * account in this selection already took are left out.
 */
export function ledgerOptionsFor(
  uid: string,
  chart: readonly ChartBankAccount[],
  selection: SelectionMap,
  fallbackName: (ledger: string) => string,
): ChartBankAccount[] {
  const takenByOthers = new Set(
    Object.entries(selection)
      .filter(([other, choice]) => other !== uid && choice.enabled && choice.ledger)
      .map(([, choice]) => choice.ledger as string),
  )
  const current = selection[uid]?.ledger ?? null
  const bankAccounts = chart
    .filter((a) => /^19\d{2}$/.test(a.account_number))
    .filter((a) => a.account_number === current || !takenByOthers.has(a.account_number))
    .sort((a, b) => a.account_number.localeCompare(b.account_number))
  if (current && !bankAccounts.some((a) => a.account_number === current)) {
    return [{ account_number: current, account_name: fallbackName(current) }, ...bankAccounts]
  }
  return bankAccounts
}

/** "1930 Företagskonto": the ledger account as the rows name it. */
export function ledgerLabel(ledger: string, chart: readonly ChartBankAccount[], fallbackName: (ledger: string) => string): string {
  const match = chart.find((a) => a.account_number === ledger)
  return `${ledger} ${match?.account_name ?? fallbackName(ledger)}`
}

/** What the row calls the account: its name, else its IBAN, else its BBAN, else the generic word. */
export function accountDisplayName(account: Pick<PolledAccount, 'name' | 'iban' | 'bban'>, generic: string): string {
  return account.name?.trim() || account.iban || account.bban || generic
}
