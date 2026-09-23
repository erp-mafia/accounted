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
