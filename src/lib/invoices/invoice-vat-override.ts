/**
 * The vocabulary of a per-invoice VAT treatment (#2906). Dependency-free so
 * the request schemas can share it without pulling in the VAT rules; the
 * rules themselves are resolveInvoiceVatRules in ./vat-rules.
 *
 * The names are the invoice header's own vat_treatment vocabulary (and the
 * supplier-invoice one), plus 'standard' for "Swedish VAT at the rates on
 * the lines". Domestic reverse charge (construction, ML 16 kap. 13 §) is a
 * fact about the buyer's business, not about one delivery, and is not
 * offered here.
 */
export const INVOICE_VAT_TREATMENT_OVERRIDES = ['standard', 'export', 'reverse_charge'] as const
export type InvoiceVatTreatmentOverride = (typeof INVOICE_VAT_TREATMENT_OVERRIDES)[number]

/** What an invoice says about its own supply. Both null = the customer decides. */
export interface InvoiceVatOverride {
  vat_treatment: InvoiceVatTreatmentOverride | null
  /** ISO 3166-1 alpha-2 country the GOODS are transported to. */
  delivery_country: string | null
}
