import { normalizeOcrReference } from '@/lib/invariants/reference-number'

/**
 * The supplier invoice list's search (app/(dashboard)/supplier-invoices):
 * which rows a term finds, and whether a row was found by its payment
 * reference alone, which the list has no column for.
 *
 * The supplier's name, the invoice number, the Fortnox number and the
 * ankomstnummer are found as typed, ignoring case. The payment reference (the
 * OCR) is found as typed too, and on its digits when the term holds only
 * digits, spaces and dashes: "1234 5678" finds an OCR stored as "12345678" or
 * "1234-5678", compared on the digits normalizeOcrReference keeps, as the
 * bank matching does. A term with a letter in it is never cut down to its
 * digits, so "ab12" does not find every reference with 12 in it.
 *
 * A filter as you type finds a part of a number: typing five of an OCR's ten
 * digits must not empty the list. That is not the rule for whether a bank
 * text names a document, where only a whole number counts
 * (descriptionMentionsReference).
 */

/** The fields of a list row the search reads (GET /api/supplier-invoices). */
export interface SupplierInvoiceSearchRow {
  supplier?: { name?: string | null } | null
  supplier_invoice_number?: string | null
  fortnox_number?: string | null
  arrival_number?: number | null
  payment_reference?: string | null
}

/**
 * How a term finds a row: 'row' through the supplier's name, the invoice
 * number, the Fortnox number or the ankomstnummer (an empty term finds every
 * row so), 'reference' through its payment reference alone.
 */
export type SupplierInvoiceSearchHit = 'row' | 'reference'

/** A term a person types for a number: digits, grouped by spaces or dashes. */
const DIGITS_ONLY_TERM = /^[\d\s-]+$/

/** What `term` finds `invoice` by, or null when the search leaves it out. */
export function supplierInvoiceMatchesSearch(
  invoice: SupplierInvoiceSearchRow,
  term: string,
): SupplierInvoiceSearchHit | null {
  const query = term.trim().toLowerCase()
  if (
    !query ||
    (invoice.supplier?.name ?? '').toLowerCase().includes(query) ||
    (invoice.supplier_invoice_number ?? '').toLowerCase().includes(query) ||
    (invoice.fortnox_number ?? '').toLowerCase().includes(query) ||
    String(invoice.arrival_number ?? '').includes(query)
  ) {
    return 'row'
  }

  const reference = invoice.payment_reference ?? ''
  if (!reference) return null
  if (reference.toLowerCase().includes(query)) return 'reference'
  if (!DIGITS_ONLY_TERM.test(query)) return null
  const termDigits = normalizeOcrReference(query)
  const referenceDigits = normalizeOcrReference(reference)
  return termDigits !== '' && referenceDigits.includes(termDigits) ? 'reference' : null
}
