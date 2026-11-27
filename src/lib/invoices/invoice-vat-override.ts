/**
 * The vocabulary of a per-invoice VAT treatment (#2906). Dependency-free so
 * the request schemas can share it without pulling in the VAT rules; the
 * rules themselves are resolveInvoiceVatRules in ./vat-rules.
 *
 * The names are the invoice header's own vat_treatment vocabulary (and the
 * supplier-invoice one), plus 'standard' for "Swedish VAT at the rates on
 * the lines". 'reverse_charge_domestic' is omvänd betalningsskyldighet for
 * construction services (ML 16 kap. 13 §). It needs both a buyer that is a
 * construction business and a supply that is a construction service, so the
 * invoice states it: the customer record alone cannot decide it.
 * 'outside_scope' is an amount that is not a supply made in Sweden, so it
 * carries no Swedish VAT and reaches no ruta: today dröjsmålsränta on a
 * räntefaktura, compensation for a late payment and not consideration for a
 * good or a service (ML 8 kap. 2-3 §§).
 */
export const INVOICE_VAT_TREATMENT_OVERRIDES = ['standard', 'export', 'reverse_charge', 'reverse_charge_domestic', 'outside_scope'] as const
export type InvoiceVatTreatmentOverride = (typeof INVOICE_VAT_TREATMENT_OVERRIDES)[number]

/** What an invoice says about its own supply. Both null = the customer decides. */
export interface InvoiceVatOverride {
  vat_treatment: InvoiceVatTreatmentOverride | null
  /** ISO 3166-1 alpha-2 country the GOODS are transported to. */
  delivery_country: string | null
}
