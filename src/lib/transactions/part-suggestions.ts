/**
 * A Bankgirot split as the bank side reads it: what one suggestion per part
 * looks like, when the split explains the whole row, and the marker such a
 * row carries.
 *
 * A bankgiro deposit is one row on the statement; with Open Payments'
 * enrichment it arrives with its split: one part per payer with name,
 * organisationsnummer, OCR reference, invoice numbers and amount (a payout
 * likewise per payee). Which open invoice each part pays is the invoice
 * blocks' answer (lib/invoices/part-invoice-suggestions.ts), asked through
 * the bank side's open-invoice plug-in point (lib/transactions/open-invoices.ts).
 * Suggestion only: a part's suggestion books nothing.
 */
import type { MatchableInvoice } from '@/lib/invoices/invoice-matching'
import { amountToOre } from '@/lib/transactions/external-id'
import type { BankTransactionPartInput, BankTransactionPartSuggestionReason, SupplierInvoice } from '@/types'

/** potential_match_method of a row whose parts all resolved and sum to it. */
export const BANKGIRO_SPLIT_METHOD = 'bankgiro_split'
/** potential_match_confidence that goes with BANKGIRO_SPLIT_METHOD. */
export const BANKGIRO_SPLIT_CONFIDENCE = 0.95

export interface PartSuggestion {
  /** The part's position, from 1 (bank_transaction_parts.seq). */
  seq: number
  suggested_invoice_id: string | null
  suggested_supplier_invoice_id: string | null
  suggestion_reason: BankTransactionPartSuggestionReason | null
}

export interface PartSuggestionInput {
  /** transactions.amount of the row the parts belong to: its sign picks the side. */
  parentAmount: number
  parts: readonly BankTransactionPartInput[]
  /** The company's open customer invoices with their customer (loadInvoiceMatchPool). */
  customerInvoices: readonly MatchableInvoice[]
  /** The company's open supplier invoices with their supplier. */
  supplierInvoices: readonly SupplierInvoice[]
  /** Invoices another row of the same batch already claims: never offered again. */
  excludeInvoiceIds?: ReadonlySet<string>
}

/**
 * True when the split explains the whole row: two or more parts, every part
 * with a suggestion, and the parts summing to the row's amount. That is when
 * the row gets potential_match_method = 'bankgiro_split' and its batch
 * allocation can be prefilled; a single part keeps the single-invoice path.
 */
export function splitIsComplete(
  parentAmount: number,
  parts: readonly Pick<BankTransactionPartInput, 'amount'>[],
  suggestions: readonly PartSuggestion[],
): boolean {
  if (parts.length < 2 || suggestions.length !== parts.length) return false
  if (!suggestions.every((s) => s.suggested_invoice_id || s.suggested_supplier_invoice_id)) return false
  const sum = parts.reduce((total, part) => total + amountToOre(part.amount), 0)
  return sum === amountToOre(parentAmount)
}
