/**
 * Skatteverket's skattekonto in BAS terms (SE pack territory, see
 * scripts/checks/jurisdiction-welds.mjs): the data the booking guard's
 * skattekonto half (./skattekonto-tax-double.ts) judges a kontering with.
 *
 * A payment to Skatteverket is not earmarked (SFL 62 kap. 11 §): the bank
 * line touches only the skattekonto account and the liabilities below are
 * cleared from the skattekontoutdrag (.claude/skills/swedish-daily-bookkeeping/
 * references/skattekonto-and-owner.md §1.1, §1.3).
 */

/**
 * The accounts a skattekonto debit or credit clears that a bank line must
 * never clear itself: skatteskulder and betald F-skatt (2510-2518), the
 * momsredovisning (2650), personalskatt and the social avgifter (2710,
 * 2730-2732). F-skatt in an enskild firma (2013) and a momsfordran (1650)
 * are left out: owner withdrawals and other receivables move them for
 * reasons of their own.
 */
export const SKATTEKONTO_TAX_ACCOUNTS: ReadonlySet<string> = new Set([
  '2510',
  '2512',
  '2514',
  '2518',
  '2650',
  '2710',
  '2730',
  '2731',
  '2732',
])

/**
 * The accounts that hold the same skattekonto event, for a guard that looks
 * for the event on its counter account. An aktiebolag's debiterad
 * preliminärskatt was proposed on 2510 Skatteskulder until migration
 * 20261120150000 and on 2518 Betald F-skatt since, so a verifikat holds the
 * event on either, and books made before and after the change must still
 * find each other.
 */
const SAME_TAX_EVENT_ACCOUNTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '2510': ['2510', '2518'],
  '2518': ['2510', '2518'],
})

/** The accounts that hold the same skattekonto event as `account` (itself included). */
export function sameTaxEventAccounts(account: string): readonly string[] {
  return SAME_TAX_EVENT_ACCOUNTS[account] ?? [account]
}

/**
 * The accounts the skattekonto may run on: SKATTEKONTO_LEDGER_ACCOUNTS in
 * lib/skatteverket/skattekonto-account.ts (a test pins the two equal), held
 * here as data so the transactions module does not import the skatteverket
 * one. A booking with a line on either goes through the skattekonto,
 * whichever the company chose.
 */
export const SKATTEKONTO_LEDGER_ACCOUNT_SET: ReadonlySet<string> = new Set(['1630', '2012'])
