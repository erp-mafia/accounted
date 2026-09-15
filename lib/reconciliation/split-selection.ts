import { roundOre } from '@/lib/money'

/**
 * A posted line on the settlement account, as the unmatched-entries endpoint
 * returns it (one row per line, so one verifikat can contribute several).
 */
export interface SettlementLine {
  journal_entry_id: string
  debit_amount: number
  credit_amount: number
}

/**
 * The line's movement in the bank's sign convention: a debit on 19xx is money
 * in (positive), a credit is money out (negative). Same convention as
 * transactions.amount, so the two sides compare directly.
 */
export function settlementAmount(line: SettlementLine): number {
  return roundOre(line.debit_amount > 0 ? line.debit_amount : -line.credit_amount)
}

export interface SplitSelection {
  /** One slice per picked verifikat, in pick order: its net on the account. */
  allocations: { journal_entry_id: string; amount: number }[]
  /** Sum of the slices. */
  sum: number
  /** transactionAmount - sum: what the picked verifikat leave unexplained. */
  difference: number
  /** The slices explain the whole bank row (öre tolerance). */
  balanced: boolean
}

// Half an öre: the same tolerance the engine (linkTransactionToVouchers) and
// the reconciliation worksheet apply.
const TOLERANCE = 0.005

/**
 * The arithmetic of a 1:N pick: one bank row explained by several verifikat.
 * Nets every picked verifikat's lines on the account (a verifikat with two
 * lines on 1930 is one slice, as the engine sees it) and reports whether the
 * slices sum to the row. Pure, so the dialog and its tests share it.
 */
export function buildSplitSelection(
  lines: readonly SettlementLine[],
  selectedIds: readonly string[],
  transactionAmount: number,
): SplitSelection {
  const netByEntry = new Map<string, number>()
  for (const line of lines) {
    netByEntry.set(
      line.journal_entry_id,
      roundOre((netByEntry.get(line.journal_entry_id) ?? 0) + settlementAmount(line)),
    )
  }
  const allocations = selectedIds
    .filter((id) => netByEntry.has(id))
    .map((id) => ({ journal_entry_id: id, amount: netByEntry.get(id) as number }))
  const sum = roundOre(allocations.reduce((acc, a) => acc + a.amount, 0))
  const difference = roundOre(transactionAmount - sum)
  return { allocations, sum, difference, balanced: Math.abs(difference) < TOLERANCE }
}
