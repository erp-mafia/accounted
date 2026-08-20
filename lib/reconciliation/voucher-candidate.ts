/**
 * "Could this bank row be settled by one of these vouchers?"
 *
 * Split out of the reconciliation view so it can be unit-tested and so the
 * component never has to import `lib/reconciliation/bank-reconciliation`, which
 * pulls in the event bus and the match log and must not reach the client
 * bundle. Only `ledgerLineAmountIn` is needed, and that module is pure.
 *
 * This is the coarse first pass the server matcher opens with, not the matcher
 * itself: it answers whether the reconciliation surface has anything to offer
 * for a row at all. A row it says no to is not reconciliation work, it is an
 * unbooked affärshändelse, and the UI sends it to the bookkeeping surface
 * instead of a picker that holds nothing for it.
 */
import { ledgerLineAmountIn, type LedgerLineAmount } from '@/lib/bookkeeping/ledger-line-amount'

/** The minimum a ledger line has to expose to be considered here. */
export type CandidateLine = LedgerLineAmount

/**
 * True when at least one line could settle `amount` on an account reconciled in
 * `currency`.
 *
 * Two rules, both the server matcher's:
 * - **Direction.** Money in (`amount > 0`) is settled by a debit on the bank
 *   account; money out by a credit. `ledgerLineAmountIn` already returns the
 *   line signed like a bank movement, so this is a sign comparison.
 * - **Amount.** Equal to the öre. Compared as integer öre rather than with a
 *   float epsilon, the same way every other money comparison in this codebase
 *   settles the question.
 *
 * Lines that carry no amount in `currency` (a foreign account, whose candidate
 * rows hold no FX figure) can never be shown to settle anything: there is no
 * honest comparison to make, and claiming one would offer a 1 150 SEK ledger
 * leg as the settlement for a 1 150 EUR bank line.
 *
 * Deliberately strict, because the two errors are not symmetric. A false
 * NEGATIVE offers "Bokför" on a row that could also have been paired, and
 * booking it is a legitimate outcome. A false POSITIVE sends the user into a
 * picker with nothing in it, which is the state the whole page was in before.
 */
export function hasVoucherCandidate(
  amount: number,
  lines: readonly CandidateLine[],
  currency: string,
): boolean {
  if (!Number.isFinite(amount) || amount === 0) return false
  const targetOre = Math.round(Math.abs(amount) * 100)
  return lines.some((line) => {
    const lineAmount = ledgerLineAmountIn(line, currency)
    if (lineAmount === null) return false
    // Opposite sign, or zero: cannot settle this row.
    if (amount > 0 ? lineAmount <= 0 : lineAmount >= 0) return false
    return Math.round(Math.abs(lineAmount) * 100) === targetOre
  })
}
