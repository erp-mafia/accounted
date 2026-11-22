/**
 * What a typed amount means in the konteringsrader, before it is a line.
 *
 * A line carries one side and both sides are written as positive figures.
 * Two things followed from the form not saying so itself: a minus figure
 * stayed where it was typed, looked accepted and counted as nothing, and the
 * amount that closes the verifikat was proposed only when the person happened
 * to stand in the column it belonged to.
 */

import { formatAmountInput, parseAmountInput, parseSwedishAmount } from '@/lib/money'

export type KonteringAmountSide = 'debit_amount' | 'credit_amount'

/**
 * The line's value for what a person typed in an amount field: the figure as
 * a dot string ("100.5"), which is what the field handed over while it was a
 * number input, so every reader of the lines reads what it always read. The
 * field is text because Chrome reads a number field by the browser's own
 * language, not the page's: in an English Chrome "100,50" became 10050
 * (PH 305). The text is read by the app's language, `decimal` being its
 * decimal mark:
 * - Swedish (','): as parseAmountInput reads it, a comma or a dot decimal and
 *   space-grouped thousands, so "10,000" is ten kronor.
 * - English ('.'): a dot decimal and comma-grouped thousands, so "10,000" is
 *   ten thousand, as an English Chrome's number field read it. A comma that
 *   cannot group thousands ("100,50", "1.234,56") is a decimal comma, the
 *   only decimal key a phone set to a Swedish region offers.
 * Text that is not one amount is no figure ('').
 *
 * A minus figure is the same figure on the other side (negativeAmountMove),
 * so it is read and rounded without its sign: roundOre rounds a negative
 * half öre toward zero, and "-2,675" would move as 2.67 where "2,675" typed
 * on the other side is 2.68. The sign is a hyphen, a Unicode minus or a
 * dash lookalike, the signs parseSwedishAmount reads.
 */
export function konteringAmountValue(text: string, decimal: ',' | '.'): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const minus = /^[-−‐-—]/.test(trimmed)
  const n = readKonteringAmount(minus ? trimmed.slice(1) : trimmed, decimal)
  if (n === null || (minus && n < 0)) return ''
  return String(minus && n !== 0 ? -n : n)
}

function readKonteringAmount(text: string, decimal: ',' | '.'): number | null {
  if (decimal === ',') return parseAmountInput(text)
  return parseSwedishAmount(text, '.') ?? parseAmountInput(text)
}

/**
 * What an amount field shows for a line's value while nobody is typing in
 * it: the figure to the öre with the decimal mark of the app's language
 * ("100,50"), so a figure read another way than it was meant shows once the
 * field is left. A value that is not a plain figure is shown as it is.
 */
export function konteringAmountText(value: string, decimal: ',' | '.'): string {
  return /^-?\d+(\.\d+)?$/.test(value) ? formatAmountInput(Number(value), decimal) : value
}

function otherSide(side: KonteringAmountSide): KonteringAmountSide {
  return side === 'debit_amount' ? 'credit_amount' : 'debit_amount'
}

/**
 * A minus figure on one side is the same figure on the other side: minus 80
 * in debet is 80 in kredit. Answers where the figure goes and as what text,
 * or null when the text is not a figure below zero.
 */
export function negativeAmountMove(
  side: KonteringAmountSide,
  text: string,
): { side: KonteringAmountSide; value: string } | null {
  const trimmed = text.trim()
  if (!(parseFloat(trimmed) < 0)) return null
  return { side: otherSide(side), value: trimmed.replace(/^-\s*/, '') }
}

/**
 * Which column the closing amount is proposed in when focus enters an
 * untouched row's amount. `gap` is credit minus debit of every other row:
 * above zero the debit side is short, below zero the credit side.
 *
 * Focus lands in debet after an account is chosen, so a gap on the credit
 * side is proposed in kredit from there: the figure shows in its own column
 * and a debit typed over it clears it. Standing in kredit with the gap on
 * the debit side proposes nothing: the person chose the column.
 */
export function balancingProposalSide(
  focused: KonteringAmountSide,
  gap: number,
): KonteringAmountSide | null {
  if (gap > 0) return focused === 'debit_amount' ? 'debit_amount' : null
  if (gap < 0) return 'credit_amount'
  return null
}
