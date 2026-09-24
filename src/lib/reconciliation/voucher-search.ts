import { parseAmountTerm } from '@/lib/invoices/invoice-search'
import { equalOre } from '@/lib/money'

/**
 * Search predicate for the manual bank-match voucher picker
 * (MatchVerifikationPicker). Client-safe: pure, no server-only imports.
 *
 * Text fields (voucher number, date, descriptions) match as a substring, so
 * "A6" or "2026-07" behave as before. The amount does NOT: a term that parses
 * as an amount ("25000", "25 000", "25000,00", "-25000") matches the line's
 * magnitude exactly, to the öre. Substring digit matching made "25000" hit a
 * 250 000 kr verifikat while nothing marked it as a different amount.
 */
export interface SearchableVoucherLine {
  debit_amount: number
  credit_amount: number
  entry_date: string
  entry_description?: string | null
  line_description?: string | null
  /** Pre-formatted voucher label, e.g. "A6". */
  voucher: string
}

export function matchesVoucherSearch(line: SearchableVoucherLine, rawTerm: string): boolean {
  const term = rawTerm.trim().toLocaleLowerCase('sv-SE')
  if (!term) return true

  if (
    line.voucher.toLocaleLowerCase('sv-SE').includes(term) ||
    line.entry_date.toLocaleLowerCase('sv-SE').includes(term) ||
    (line.entry_description ?? '').toLocaleLowerCase('sv-SE').includes(term) ||
    (line.line_description ?? '').toLocaleLowerCase('sv-SE').includes(term)
  ) {
    return true
  }

  const amount = parseAmountTerm(rawTerm)
  if (amount === null) return false
  // Magnitude on both sides: the picker shows a credit as negative, but a user
  // searching a belopp thinks in magnitudes (same rule as the invoice search).
  const lineAmount = Math.abs(Number(line.debit_amount) > 0 ? Number(line.debit_amount) : Number(line.credit_amount))
  return Number.isFinite(lineAmount) && equalOre(lineAmount, amount)
}
