/**
 * Sign-based balance sheet reclassification.
 *
 * Tax settlement and VAT accounts routinely carry the opposite economic
 * balance from their BAS class: a skattekonto (1630) with a credit balance is
 * money owed to Skatteverket, and a momsavräkningskonto (2641) with a debit
 * balance is money owed back by Skatteverket. ÅRL 3 kap. and K2 present a post
 * by the substance of its balance, so a negative asset is shown as a liability
 * and vice versa. A static BAS-range mapping cannot see that on its own.
 *
 * These rules are the single source of truth for every statutory report that
 * presents a balance sheet: the K2 iXBRL årsredovisning (lib/bokslut/ixbrl/
 * k2-mapper.ts) and the INK2R räkenskapsschema (lib/reports/ink2/ink2-engine
 * .ts). Only the rule table is shared. Each consumer applies it with its own
 * arithmetic, because the iXBRL path sums in exact öre while INK2R works in
 * kronor and truncates per SFL 22 kap. 1 §.
 *
 * Labels and warnings stay Swedish: these surface on Skatteverket and
 * Bolagsverket forms (see .claude/rules/i18n.md).
 */

export type SignReclassificationId =
  | 'tax_account_credit_to_liability'
  | 'tax_liability_debit_to_receivable'
  | 'vat_liability_debit_to_receivable'

export interface AccountRange {
  start: string
  end: string
}

export type SignReclassificationMode = 'net' | 'deviating_rows'

export interface SignReclassificationRule {
  id: SignReclassificationId
  /** Orientation the source post is normally presented in. */
  balance: 'debit' | 'credit'
  ranges: AccountRange[]
  /**
   * `net`: the accounts in range settle as one unit against Skatteverket, so
   * reclassify only when their combined balance deviates.
   *
   * `deviating_rows`: the accounts are economically independent (a
   * momsfordran must not net away a skattekontoskuld), so each deviating
   * account is reclassified on its own.
   */
  mode: SignReclassificationMode
  warning: string
}

const r = (start: string, end: string): AccountRange => ({ start, end })

export const SIGN_RECLASSIFICATION_RULES: SignReclassificationRule[] = [
  {
    id: 'tax_account_credit_to_liability',
    balance: 'debit',
    ranges: [r('1630', '1659')],
    mode: 'deviating_rows',
    warning:
      'Skatte- och momsfordringskonton 1630-1659 har ett nettokreditsaldo och har därför redovisats som skatteskuld.',
  },
  {
    id: 'tax_liability_debit_to_receivable',
    balance: 'credit',
    ranges: [r('2500', '2599')],
    mode: 'net',
    warning:
      'Skatteskuldkonton 2500-2599 har ett nettodebetsaldo och har därför redovisats som övrig fordran.',
  },
  {
    id: 'vat_liability_debit_to_receivable',
    balance: 'credit',
    ranges: [r('2610', '2659')],
    mode: 'net',
    warning:
      'Momsavräkningskonton 2610-2659 har ett nettodebetsaldo och har därför redovisats som övrig fordran.',
  },
]

/** Account numbers are strings and compare lexicographically within a class. */
export function isInRanges(accountNumber: string, ranges: AccountRange[]): boolean {
  return ranges.some((range) => accountNumber >= range.start && accountNumber <= range.end)
}

/** Half an öre: below this a balance is float noise, not a real deviation. */
const DEVIATION_THRESHOLD = 0.005

/**
 * Accounts whose balances must move from the rule's source post to its target
 * post, given debit-positive raw ledger balances (debit − credit).
 *
 * Returns the accounts rather than an amount so a caller can relocate whole
 * rows and keep its per-account breakdown consistent with the post totals. For
 * `net` this is exact: the moved rows sum to the deviating net by definition,
 * because every account in range moves together.
 */
export function selectReclassifiedAccounts(
  rule: SignReclassificationRule,
  balances: ReadonlyMap<string, number>,
): string[] {
  const orient = (balance: number) => (rule.balance === 'debit' ? balance : -balance)

  const inRange: Array<{ accountNumber: string; oriented: number }> = []
  for (const [accountNumber, balance] of balances) {
    if (isInRanges(accountNumber, rule.ranges)) {
      inRange.push({ accountNumber, oriented: orient(balance) })
    }
  }

  if (rule.mode === 'deviating_rows') {
    return inRange
      .filter((row) => row.oriented < -DEVIATION_THRESHOLD)
      .map((row) => row.accountNumber)
  }

  const net = inRange.reduce((sum, row) => sum + row.oriented, 0)
  if (net >= -DEVIATION_THRESHOLD) return []
  return inRange
    .filter((row) => Math.abs(row.oriented) > DEVIATION_THRESHOLD)
    .map((row) => row.accountNumber)
}
