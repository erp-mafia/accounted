/**
 * Invoice-list search predicate. Extracted from the page filter so the
 * matching rules are testable and documented in one place.
 *
 * Matches, in order of what users actually paste into the box:
 *   - invoice number / external (self-billed) number, substring
 *   - customer name, substring
 *   - an amount, against BOTH the net (subtotal) and gross (total): a user
 *     checking an avtalad avgift knows the net ("14 000"); the list shows
 *     the gross ("17 500 kr"). Amount terms accept Swedish formatting:
 *     spaces (incl. NBSP/thin NBSP) as thousand separators, comma or dot
 *     decimals. Exact-amount semantics with an öre tolerance; substring
 *     digit matching would drown "1400" in false hits.
 */

export interface SearchableInvoice {
  invoice_number?: string | null
  external_invoice_number?: string | null
  customer?: { name?: string | null } | null
  subtotal?: number | string | null
  total?: number | string | null
}

/**
 * Parse "14 000", "17 500,50", "17500.50", "-17500" → magnitude (absolute
 * value); null when not an amount. \s covers NBSP/thin-NBSP thousand
 * separators from sv-SE formatting. Sign is discarded: credit notes store
 * negative totals, and a user searching a belopp thinks in magnitudes.
 */
export function parseAmountTerm(term: string): number | null {
  const compact = term.replace(/\s/g, '').replace(',', '.')
  if (!/^-?\d+(\.\d{1,2})?$/.test(compact)) return null
  const value = Number(compact)
  return Number.isFinite(value) ? Math.abs(value) : null
}

const amountEquals = (candidate: number | string | null | undefined, target: number): boolean => {
  if (candidate == null || candidate === '') return false
  const value = Number(candidate)
  // Magnitude comparison so 17500 finds the -17500 kreditfaktura row too.
  return Number.isFinite(value) && Math.abs(Math.abs(value) - target) < 0.005
}

export function matchesInvoiceSearch(invoice: SearchableInvoice, rawTerm: string): boolean {
  const term = rawTerm.trim().toLocaleLowerCase('sv-SE')
  if (!term) return true

  if (
    (invoice.invoice_number ?? '').toLocaleLowerCase('sv-SE').includes(term) ||
    (invoice.external_invoice_number ?? '').toLocaleLowerCase('sv-SE').includes(term) ||
    (invoice.customer?.name ?? '').toLocaleLowerCase('sv-SE').includes(term)
  ) {
    return true
  }

  const amount = parseAmountTerm(rawTerm)
  if (amount === null) return false
  return amountEquals(invoice.subtotal, amount) || amountEquals(invoice.total, amount)
}
