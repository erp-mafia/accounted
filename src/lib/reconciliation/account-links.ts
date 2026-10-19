import type { ReconciliationAccount } from './schemas'

/**
 * Where an account on the Konton list leads. The list is the one list of
 * accounts with an outside truth (founder decision 2026-10-18: Översikt and
 * Avstämning merged); a row opens the account's reconciliation, and the bare
 * /reconciliation address redirects to the list (next.config.ts).
 */

type AccountRef = Pick<ReconciliationAccount, 'account_key' | 'kind'>

/**
 * The account's reconciliation view. `autorun` carries the old bankavstämning
 * deep link (/reconciliation?autorun=1 from the transactions inbox) through
 * the list: the matcher preview runs on a bank account only, so the flag is
 * dropped for every other kind.
 */
export function reconciliationHref(account: AccountRef, opts: { autorun?: boolean } = {}): string {
  const qs = new URLSearchParams({ account: account.account_key })
  if (opts.autorun && account.kind === 'bank') qs.set('autorun', '1')
  return `/reconciliation?${qs.toString()}`
}

/**
 * A bank account's own rows: Transaktioner filtered to it. account_key is
 * 'bank:<cash_account_id>'; null for the skattekonto and the balance accounts.
 */
export function accountTransactionsHref(account: AccountRef): string | null {
  if (account.kind !== 'bank' || !account.account_key.startsWith('bank:')) return null
  return `/transactions?source=${encodeURIComponent(`acct:${account.account_key.slice('bank:'.length)}`)}`
}
