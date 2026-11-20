/**
 * Verifikation description for supplier-invoice vouchers: event type,
 * counterparty and an identifying suffix (BFL 5 kap 7 §).
 *
 * Deliberately dependency-free and in its own module: the pre-save preview in
 * components/suppliers/SupplierInvoiceReviewContent.tsx is a client component
 * and must render the exact string the engine will post. Importing it from
 * supplier-invoice-entries.ts would drag the journal engine (and its Supabase
 * server client) into the browser bundle, so the text lives here and both
 * sides call it.
 *
 * An invoice without the supplier's number (NULL, crm#1039) leaves the number
 * out instead of printing a placeholder into the verifikat:
 * "Leverantörsfaktura, Leverantör AB (ankomstnr 12)". A number is printed
 * exactly as stored.
 */
export function buildSupplierDescription(
  prefix: string,
  invoiceNumber: string | null | undefined,
  supplierName?: string,
  suffix?: string,
): string {
  const head = invoiceNumber?.trim() ? `${prefix} ${invoiceNumber}` : prefix
  const base = supplierName ? `${head}, ${supplierName}` : head
  return suffix ? `${base} ${suffix}` : base
}

/**
 * How a Swedish text names one supplier invoice: the supplier's own number,
 * or, for an invoice without one, its ankomstnummer (the company's löpnummer
 * for it in the leverantörsreskontra), so the text still says which invoice
 * it is about. Empty only when neither is known.
 */
export function supplierInvoiceReference(
  invoiceNumber: string | null | undefined,
  arrivalNumber: number | null | undefined,
): string {
  if (invoiceNumber?.trim()) return invoiceNumber
  return arrivalNumber != null ? `ankomstnr ${arrivalNumber}` : ''
}
