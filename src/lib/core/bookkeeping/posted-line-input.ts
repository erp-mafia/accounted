import { normalizeLineDimensions } from '@/lib/bookkeeping/dimension-resolver'
import type { CreateJournalEntryLineInput, JournalEntryLine } from '@/types'

/**
 * A posted journal line as the input for a new line with the same content:
 * account, amounts, currency facts, text, tax code and the whole dimensions
 * bag. For the paths that rebuild an entry from the one they correct
 * (recordateEntry, the reverse-charge basis fix), so no copy can drop a field
 * another one remembered.
 *
 * The bag is copied whole, with any legacy cost_center/project alias folded
 * in. Those columns only mirror SIE dimensions 1 and 6: a copy built from
 * them loses every other dimension (2, 7-9, 20+) on the corrected entry while
 * the storno side reverses them, because correctEntry mirrors the original's
 * bags.
 */
export function postedLineAsInput(line: JournalEntryLine): CreateJournalEntryLineInput {
  const dimensions = normalizeLineDimensions(line)
  return {
    account_number: line.account_number,
    debit_amount: Number(line.debit_amount) || 0,
    credit_amount: Number(line.credit_amount) || 0,
    ...(line.line_description ? { line_description: line.line_description } : {}),
    ...(line.currency ? { currency: line.currency } : {}),
    ...(line.amount_in_currency != null ? { amount_in_currency: Number(line.amount_in_currency) } : {}),
    ...(line.exchange_rate != null ? { exchange_rate: Number(line.exchange_rate) } : {}),
    ...(line.tax_code ? { tax_code: line.tax_code } : {}),
    ...(Object.keys(dimensions).length > 0 ? { dimensions } : {}),
  }
}
