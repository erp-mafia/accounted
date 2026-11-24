import { PINNED_JURISDICTION, resolveAccountRole } from './account-roles'

/**
 * The receivables and payables ledgers: the account groups of the
 * company's kundfordringar and leverantörsskulder roles (151x and 244x in
 * BAS). An invoice's clearing, never a counterpart's habit.
 */
const CLEARING_GROUPS = [
  resolveAccountRole(PINNED_JURISDICTION, 'accounts_receivable'),
  resolveAccountRole(PINNED_JURISDICTION, 'accounts_payable'),
].map((account) => account.slice(0, 3))

/** An account in the receivables or the payables group. */
export function isClearingAccount(account: string): boolean {
  return account.length === 4 && CLEARING_GROUPS.some((group) => account.startsWith(group))
}

/**
 * Whether a verifikat clears a receivable or a payable at all: one line on
 * such an account is enough. Its other side is an invoice's, so it says how
 * a debt was settled, not how the counterparty is booked. Replayed for the
 * next bank row it would be a clearing with no invoice behind it.
 *
 * One answer for everything that reads a counterparty's habit off a posted
 * verifikat: the bank-link learner teaches nothing from one
 * (lib/transactions/link-learning.ts, 'clearing_account'), and no earlier
 * booking of this kind is a precedent (lib/transactions/booking-precedent.ts).
 */
export function clearsAnInvoice(accounts: readonly string[]): boolean {
  return accounts.some(isClearingAccount)
}
