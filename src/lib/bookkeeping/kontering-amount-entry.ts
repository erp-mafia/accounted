/**
 * What a typed amount means in the konteringsrader, before it is a line.
 *
 * A line carries one side and both sides are written as positive figures.
 * Two things followed from the form not saying so itself: a minus figure
 * stayed where it was typed, looked accepted and counted as nothing, and the
 * amount that closes the verifikat was proposed only when the person happened
 * to stand in the column it belonged to.
 */

export type KonteringAmountSide = 'debit_amount' | 'credit_amount'

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
