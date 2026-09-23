import { roundOre } from '@/lib/money'
import { findExactCoveringSet } from './covering-set'

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

/** What the proposal needs beyond the amounts: the date, and whether the
 *  verifikat is already settled by another bank row on this account. */
export interface ProposableLine extends SettlementLine {
  entry_date: string
  linked_transaction_count?: number
}

const MS_PER_DAY = 86_400_000

function dayDistance(a: string, b: string): number {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime())
  return Number.isFinite(ms) ? Math.round(ms / MS_PER_DAY) : Number.MAX_SAFE_INTEGER
}

/**
 * Propose the split when no single verifikat explains the row: the smallest
 * set of unmatched verifikat, same direction as the row, whose nets on the
 * account sum to it to the öre (closest in date wins ties). A Bankgirot
 * day-sum against the day's inbetalningar is the case this exists for. The
 * exact sum is a deterministic signal that needs no counterparty text, which
 * bank rows like "BGGIRERING 03447786" never carry.
 *
 * Returns the verifikat ids in pick order, or null when nothing sums (or when
 * one verifikat alone does: that is the 1:1 path, ranked by the endpoint's
 * confidence, not a split).
 */
export function proposeSplitSelection(
  lines: readonly ProposableLine[],
  transactionAmount: number,
  transactionDate: string,
): string[] | null {
  if (Math.abs(transactionAmount) < TOLERANCE) return null
  const byEntry = new Map<string, { net: number; entry_date: string; matched: boolean }>()
  for (const line of lines) {
    const prev = byEntry.get(line.journal_entry_id)
    byEntry.set(line.journal_entry_id, {
      net: roundOre((prev?.net ?? 0) + settlementAmount(line)),
      entry_date: prev?.entry_date ?? line.entry_date,
      matched: (prev?.matched ?? false) || (line.linked_transaction_count ?? 0) > 0,
    })
  }
  const direction = Math.sign(transactionAmount)
  const candidates = Array.from(byEntry, ([id, e]) => ({ id, ...e }))
    .filter((e) => !e.matched && Math.sign(e.net) === direction)
    .map((e) => ({
      id: e.id,
      amount: Math.abs(e.net),
      dateDistanceDays: dayDistance(e.entry_date, transactionDate),
    }))
  const set = findExactCoveringSet(Math.abs(transactionAmount), candidates)
  if (!set || set.length < 2) return null
  return set.map((c) => c.id)
}
