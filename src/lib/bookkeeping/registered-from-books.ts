/**
 * An invoice registered from the books: issued in another system and held
 * here as a header linked to the verifikat that booked it
 * (invoices.journal_entry_id), written without lines
 * (gnubok_register_booked_invoice, crm#1094: register-booked-invoice.ts never
 * writes any). An invoice issued in Accounted has lines; one the provider
 * migration linked but could not give lines reads the same way. No provenance
 * column is needed: the state itself is the marker.
 *
 * For such a row the invoice is the original document, kept as underlag on
 * that verifikat. Accounted's own render of it is a header with totals, so
 * every surface that shows "the invoice" reads this one predicate and points
 * to the verifikat instead of presenting the render as the invoice (crm#1131).
 * The register's coverage boundary applies the same predicate in SQL
 * (get_invoice_register_coverage, read by invoice-register-coverage.ts): a
 * registration is one open item of an older history.
 *
 * Its own module with no imports: the invoice page is client code.
 */
export interface RegisteredFromBooksRow {
  journal_entry_id?: string | null
  /**
   * Set on a kreditfaktura. One that credits a registration is issued in
   * Accounted without lines (its original has none to mirror) and booked
   * here: Accounted's render IS that document, so it is not a registration.
   * A row that does not report the column is judged on its link and lines.
   */
  credited_invoice_id?: string | null
}

/**
 * True for an invoice registered from the books. `lines` are the invoice's
 * rows as the caller read them; null or undefined gets false: a row that did
 * not report its lines is not judged.
 */
export function isRegisteredFromBooks(
  invoice: RegisteredFromBooksRow,
  lines: readonly unknown[] | null | undefined,
): boolean {
  return (
    invoice.journal_entry_id != null &&
    !invoice.credited_invoice_id &&
    Array.isArray(lines) &&
    lines.length === 0
  )
}
