/**
 * Supplier Invoice Matching: auto-match expense transactions to unpaid supplier invoices.
 *
 * 4-pass matching algorithm (ordered by confidence):
 * 1. Payment reference/OCR exact match → 0.98
 * 2. Exact amount + bankgiro/plusgiro match → 0.92
 * 3. Exact amount + payment date within [invoice_date − 5, due_date + 5] → 0.85
 * 4. Fuzzy amount (±0.01) + supplier name in description → 0.70
 *
 * Auto-match threshold: ≥0.85 → applied automatically
 * Suggestion threshold: 0.70-0.85 → stored as potential_supplier_invoice_id
 *
 * The Pass-3 window spans the whole credit period (issue → due, ±5d) so an
 * early payment: common when a bank pays a Bankgiro the day the invoice lands,
 * weeks before the due date: still auto-matches. To contain the false-positive
 * risk of the wider window, a Pass-3 hit where more than one invoice matches the
 * same amount in-window is flagged `ambiguous`; callers must downgrade an
 * ambiguous auto-match to a mere suggestion.
 *
 * Amounts are only ever compared inside one currency (passes 2-4): same
 * currency → raw magnitudes, different currencies → both sides converted to SEK
 * from STORED values, and when either side has no stored conversion the invoice
 * is not offered at all. Comparing raw magnitudes across currencies is what let
 * a 1000 EUR supplier invoice "exact match" a -1000 SEK bank debit at 0.85 on
 * every import. Pass 1 is deliberately exempt: an OCR/payment reference
 * identifies the invoice on its own, no amount is involved.
 */

import type { Transaction, SupplierInvoice } from '@/types'

export interface SupplierInvoiceMatch {
  supplierInvoice: SupplierInvoice
  confidence: number
  matchMethod: 'payment_reference' | 'amount_bankgiro' | 'amount_date' | 'fuzzy_name'
  /**
   * True when this is a Pass-3 (amount + date-window) match but more than one
   * invoice matched the same amount in-window: the date heuristic alone can't
   * disambiguate. Callers must treat an ambiguous 0.85 as a suggestion, never an
   * auto-link. Undefined/false for the unique passes (OCR, bankgiro).
   */
  ambiguous?: boolean
}

/**
 * Normalize payment reference for comparison (strip whitespace and non-digits).
 */
function normalizeReference(ref: string): string {
  return ref.replace(/\D/g, '')
}

/**
 * Currency codes compare case-insensitively, and a missing code means SEK:
 * `transactions.currency` is nullable (DEFAULT 'SEK') while
 * `supplier_invoices.currency` is NOT NULL DEFAULT 'SEK', so a legacy bank row
 * with a NULL currency must still count as kronor and keep matching.
 */
function normalizeCurrency(code: string | null | undefined): string {
  return (code || 'SEK').toUpperCase()
}

/**
 * SEK value of an amount, or null when it cannot be established.
 *
 * This is `lib/bookkeeping/currency-utils.ts#resolveSekAmount` minus its final
 * "no conversion info → return the amount as-is" branch. That branch is safe
 * for booking legacy rows but fatal here: it would hand the matcher a raw EUR
 * total dressed up as kronor, which is the exact false match this guard exists
 * to stop. A missing rate must mean "not comparable", never "assume SEK".
 */
function sekValue(
  amount: number,
  currency: string,
  amountSek: number | null | undefined,
  exchangeRate: number | null | undefined
): number | null {
  if (currency === 'SEK') return amount
  if (amountSek != null) return Math.round(amountSek * 100) / 100
  if (exchangeRate != null && exchangeRate > 0) return Math.round(amount * exchangeRate * 100) / 100
  return null
}

/**
 * The invoice's stored SEK conversion scaled down to the part that is still
 * unpaid. `total_sek` covers the whole invoice at the rate booked on
 * registration, while `remaining_amount` is in the invoice currency, so a
 * partially paid invoice needs the same proportion of the SEK total. Same
 * pro-rating as the customer-side twin in `invoice-matching.ts`.
 *
 * Returns null when there is nothing to pro-rate; the caller then falls back to
 * the invoice's stored `exchange_rate` (the same rate `match_batch_allocate`
 * books the payment with) and otherwise treats the invoice as not comparable.
 */
function remainingTotalSek(invoice: SupplierInvoice, remaining: number): number | null {
  if (invoice.total_sek == null || !invoice.total) return null
  return Math.round((remaining / invoice.total) * invoice.total_sek * 100) / 100
}

/**
 * Express the transaction amount and the invoice's remaining amount in one
 * shared unit, or return null when no such unit can be established.
 *
 * Both values come back as positive magnitudes: a bank expense row is negative
 * while an invoice total is positive. Mirrors
 * `lib/documents/core-receipt-matcher.ts#amountVarianceForMatch`.
 */
function comparableAmounts(
  transaction: Transaction,
  invoice: SupplierInvoice,
  remaining: number
): { txValue: number; invoiceValue: number } | null {
  const txCurrency = normalizeCurrency(transaction.currency)
  const invoiceCurrency = normalizeCurrency(invoice.currency)

  // Same currency → raw magnitudes. Most reliable, needs no rate, and it is the
  // only path a SEK-only company ever takes.
  if (txCurrency === invoiceCurrency) {
    return { txValue: Math.abs(transaction.amount), invoiceValue: Math.abs(remaining) }
  }

  // Different currencies → compare in SEK, but only from stored conversions.
  const txSek = sekValue(
    transaction.amount,
    txCurrency,
    transaction.amount_sek,
    transaction.exchange_rate
  )
  if (txSek === null) return null

  const invoiceSek = sekValue(
    remaining,
    invoiceCurrency,
    remainingTotalSek(invoice, remaining),
    invoice.exchange_rate
  )
  if (invoiceSek === null) return null

  return { txValue: Math.abs(txSek), invoiceValue: Math.abs(invoiceSek) }
}

/**
 * Find the best matching supplier invoice for an expense transaction.
 * Expects invoices to have the `supplier` relation populated (for name/bankgiro matching).
 * Only matches against invoices with status 'registered' or 'approved'
 * and with remaining_amount > 0.
 */
export function findSupplierInvoiceMatch(
  transaction: Transaction,
  unpaidInvoices: SupplierInvoice[]
): SupplierInvoiceMatch | null {
  if (unpaidInvoices.length === 0) return null

  // Only match expense transactions
  const txAmount = Math.abs(transaction.amount)
  if (txAmount === 0) return null

  let bestMatch: SupplierInvoiceMatch | null = null
  // How many invoices matched the exact amount within their date window. >1
  // makes a Pass-3 (amount_date) winner ambiguous: the date can't pick between
  // same-amount invoices, so the caller must not auto-link it.
  let amountDateMatchCount = 0

  for (const invoice of unpaidInvoices) {
    // Only match against registered/approved invoices with remaining amount
    if (!['registered', 'approved'].includes(invoice.status)) continue
    const remaining = invoice.remaining_amount ?? invoice.total
    if (remaining <= 0) continue

    // Pass 1: Payment reference/OCR exact match → 0.98
    if (transaction.reference && invoice.payment_reference) {
      const txRef = normalizeReference(transaction.reference)
      const invRef = normalizeReference(invoice.payment_reference)
      if (txRef && invRef && txRef === invRef) {
        return {
          supplierInvoice: invoice,
          confidence: 0.98,
          matchMethod: 'payment_reference',
        }
      }
    }

    // Passes 2-4 all compare amounts, so they need a common unit. No common
    // unit → this invoice is not a candidate at all: a foreign invoice with no
    // stored rate must never be offered as a confident match on the strength of
    // a raw number that happens to line up.
    const comparison = comparableAmounts(transaction, invoice, remaining)
    if (!comparison) continue
    const { txValue, invoiceValue } = comparison

    // Pass 2: Exact amount + bankgiro/plusgiro match → 0.92
    const amountMatch = Math.abs(txValue - invoiceValue) < 0.005
    if (amountMatch) {
      const txDesc = (transaction.description || '').toLowerCase()
      const supplierBg = invoice.supplier?.bankgiro
      const supplierPg = invoice.supplier?.plusgiro
      const bgMatch = supplierBg && txDesc.includes(normalizeReference(supplierBg))
      const pgMatch = supplierPg && txDesc.includes(normalizeReference(supplierPg))

      if (bgMatch || pgMatch) {
        return {
          supplierInvoice: invoice,
          confidence: 0.92,
          matchMethod: 'amount_bankgiro',
        }
      }
    }

    // Pass 3: Exact amount + payment date within the credit period → 0.85.
    // Window = [invoice_date − 5, due_date + 5]; when only one date is known,
    // span ~30 days on the missing side (typical net terms). This catches early
    // payments (paid near the invoice date, weeks before due) that a due-date-
    // only window missed.
    if (amountMatch && (invoice.invoice_date || invoice.due_date)) {
      const DAY = 24 * 60 * 60 * 1000
      const txMs = new Date(transaction.date).getTime()
      const invoiceMs = invoice.invoice_date ? new Date(invoice.invoice_date).getTime() : null
      const dueMs = invoice.due_date ? new Date(invoice.due_date).getTime() : null
      const startMs = invoiceMs !== null ? invoiceMs - 5 * DAY : (dueMs as number) - 35 * DAY
      const endMs = dueMs !== null ? dueMs + 5 * DAY : (invoiceMs as number) + 35 * DAY

      if (txMs >= startMs && txMs <= endMs) {
        amountDateMatchCount++
        const confidence = 0.85
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = {
            supplierInvoice: invoice,
            confidence,
            matchMethod: 'amount_date',
          }
        }
      }
    }

    // Pass 4: Fuzzy amount (±5) + supplier name in description → 0.70
    // Tolerance covers öresavrundning and minor fee differences. It is expressed
    // in whatever unit `comparableAmounts` settled on: SEK for the usual case
    // and for anything cross-currency, the shared currency when both sides
    // already agree on one.
    const fuzzyAmountMatch = Math.abs(txValue - invoiceValue) <= 5.00
    const supplierName = invoice.supplier?.name
    if (fuzzyAmountMatch && supplierName) {
      const txDesc = (transaction.description || '').toLowerCase()
      const normalizedName = supplierName.toLowerCase()

      // Check if any significant word from the supplier name appears in the description
      const nameWords = normalizedName
        .replace(/[^\w\såäöé]/g, '')
        .split(/\s+/)
        .filter((w) => w.length >= 3)

      const nameInDesc = nameWords.some((word) => txDesc.includes(word))

      if (nameInDesc) {
        const confidence = 0.70
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = {
            supplierInvoice: invoice,
            confidence,
            matchMethod: 'fuzzy_name',
          }
        }
      }
    }
  }

  // A Pass-3 winner is only trustworthy enough to auto-link when its amount was
  // unique in-window. If several invoices shared the amount, the date can't
  // disambiguate: flag it so the caller demotes it to a suggestion.
  if (bestMatch && bestMatch.matchMethod === 'amount_date' && amountDateMatchCount > 1) {
    bestMatch.ambiguous = true
  }

  return bestMatch
}
