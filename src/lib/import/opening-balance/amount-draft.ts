import { formatAmountInput, parseAmountInput } from '@/lib/money'

/**
 * The amount a row carries while its debet or kredit field holds `text`.
 *
 * The field keeps the typed text as it is and commits this figure beside it,
 * so a half-typed amount ("125," on the way to "125,50", "0" on the way to
 * "0,50") is never written back over what the person is typing. Text that is
 * not one amount, and a figure below zero (an opening balance line carries one
 * positive side), commit 0: the row then counts as empty, which blocks the
 * booking until it is filled in.
 */
export function openingBalanceDraftAmount(text: string): number {
  const amount = parseAmountInput(text)
  return amount !== null && amount > 0 ? amount : 0
}

/** What an amount field shows when it is not being typed in: blank for 0, else "1234,50". */
export function openingBalanceAmountText(amount: number): string {
  return amount > 0 ? formatAmountInput(amount) : ''
}
