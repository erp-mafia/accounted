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
 */
export function buildSupplierDescription(
  prefix: string,
  invoiceNumber: string,
  supplierName?: string,
  suffix?: string,
): string {
  const base = supplierName
    ? `${prefix} ${invoiceNumber}, ${supplierName}`
    : `${prefix} ${invoiceNumber}`
  return suffix ? `${base} ${suffix}` : base
}
