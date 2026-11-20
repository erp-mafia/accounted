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

import { roundOre } from '@/lib/money'
import { isKronorCurrency } from './currency-utils'

export interface LineSides {
  debit_amount: number
  credit_amount: number
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

/**
 * The `amount_in_currency` a journal line keeps, before any rounding, or null
 * when it keeps none.
 *
 * 0 is an amount, not a missing one: a revaluation leg on a foreign cash
 * account moves kronor and no currency, so its line is `USD, 0`. Storing that
 * as null made the line unconvertible, and every reconciliation of the
 * account in its own currency answered gl_lines_missing_currency_amount
 * (#3517). So a 0 is kept on a line labelled with a foreign currency. On a
 * SEK or unlabelled line it stays null, as before: there the column carries
 * nothing (SEK readers use debit and credit), and keeping null leaves every
 * SEK line byte-identical. Empty and non-numeric input is null, as before.
 */
export function amountInCurrencyToStore(
  currency: string | null | undefined,
  amount: number | string | null | undefined,
): number | null {
  if (amount == null || amount === '') return null
  const value = Number(amount)
  if (!Number.isFinite(value)) return null
  if (value !== 0) return value
  return isKronorCurrency(currency?.trim()) ? null : 0
}

/** What a storno reads of a posted line (numeric columns may arrive as strings). */
export interface StornoSourceLine {
  debit_amount: number | string | null
  credit_amount: number | string | null
  currency?: string | null
  amount_in_currency?: number | string | null
}

/**
 * The storno of each posted line: the same amount on the opposite side, for
 * reverseEntry and correctEntry alike (each adds its own texts and columns).
 * The swap runs on the line's NET (creditNatural of debit minus credit), so a
 * legacy negative-side line (debit -0.25, booked before the non-negative
 * CHECK, journal_entry_lines_amounts_non_negative) reverses to a well-formed
 * positive line on the opposite side instead of copying the bad sign into the
 * storno, which the CHECK refuses. amount_in_currency is negated (see
 * amountInCurrencyToStore for which lines keep one; a kept 0 stays 0).
 */
export function buildStornoLines<L extends StornoSourceLine>(
  lines: readonly L[],
): Array<{ line: L; debit_amount: number; credit_amount: number; amount_in_currency: number | null }> {
  return lines.map((line) => {
    const foreign = amountInCurrencyToStore(line.currency, line.amount_in_currency)
    return {
      line,
      ...creditNatural((Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)),
      // 0 - x, not -x: a kept 0 must not become -0.
      amount_in_currency: foreign === null ? null : 0 - foreign,
    }
  })
}
