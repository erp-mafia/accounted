/**
 * Signed amount → one-sided journal line amounts.
 *
 * A journal line carries exactly one side: `debit_amount` OR `credit_amount`,
 * both non-negative (enforced by `journal_entry_lines_amounts_non_negative`
 * and by the engine before any write). Producers that aggregate user rows
 * (supplier-invoice items, invoice items) can legitimately net below zero: a
 * rabatt row, an öresavrundning row on 3740, a negative correction row. That
 * sign must flip the SIDE of the line, never the sign of the amount: a
 * `debit_amount: -0.25` balances arithmetically, so no trigger fires, but
 * every reader (verifikat page, SIE export, kontoutdrag) hides or misreads it
 * (issue: "Kto 3740 visar noll, och Debit/Kredit summerar inte").
 */

export interface LineSides {
  debit_amount: number
  credit_amount: number
}

function roundOre(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Natural-debit amount (expense, asset, receivable): positive books as debit,
 * negative books as credit of the absolute value.
 */
export function debitNatural(amount: number): LineSides {
  const rounded = roundOre(amount)
  if (rounded < 0) return { debit_amount: 0, credit_amount: -rounded }
  return { debit_amount: rounded, credit_amount: 0 }
}

/**
 * Natural-credit amount (revenue, liability, output VAT): positive books as
 * credit, negative books as debit of the absolute value.
 */
export function creditNatural(amount: number): LineSides {
  const rounded = roundOre(amount)
  if (rounded < 0) return { debit_amount: -rounded, credit_amount: 0 }
  return { debit_amount: 0, credit_amount: rounded }
}

/** What a storno reads of a posted line (numeric columns may arrive as strings). */
export interface StornoSourceLine {
  debit_amount: number | string | null
  credit_amount: number | string | null
  amount_in_currency?: number | string | null
}

/**
 * The storno of each posted line: the same amount on the opposite side, for
 * reverseEntry and correctEntry alike (each adds its own texts and columns).
 * The swap runs on the line's NET (creditNatural of debit minus credit), so a
 * legacy negative-side line (debit -0.25, booked before the non-negative
 * CHECK, journal_entry_lines_amounts_non_negative) reverses to a well-formed
 * positive line on the opposite side instead of copying the bad sign into the
 * storno, which the CHECK refuses. amount_in_currency is negated.
 */
export function buildStornoLines<L extends StornoSourceLine>(
  lines: readonly L[],
): Array<{ line: L; debit_amount: number; credit_amount: number; amount_in_currency: number | null }> {
  return lines.map((line) => ({
    line,
    ...creditNatural((Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)),
    amount_in_currency: line.amount_in_currency ? -Number(line.amount_in_currency) : null,
  }))
}
