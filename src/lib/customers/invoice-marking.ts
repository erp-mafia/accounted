/**
 * Märkning on the customer card (crm#1477): the marking a buyer wants on
 * every invoice, typically the purchase order number of a framework order or
 * a project, kept as customers.invoice_marking.
 *
 * It lands on the invoice as Märkning (invoices.invoice_marking), which the
 * PDF prints and the Peppol e-invoice sends as BT-13 OrderReference. Like the
 * Fakturareferens (lib/customers/invoice-reference.ts) it is COPIED when a new
 * invoice is written, never read at print or send time, so an issued invoice
 * keeps the marking it was issued with after the card changes.
 *
 * The same doors apply it as the Fakturareferens: v1 create and bulk-create,
 * the agent's create_invoice, recurring schedules, quote and proforma
 * conversion, order to invoice, and webshop orders. The web editor prefills
 * the field in front of the user instead, so a marking the user clears there
 * stays cleared.
 */

type CustomerWithMarking = { invoice_marking?: string | null } | null | undefined

/** The customer card's Märkning, trimmed; null when it has none. */
export function customerInvoiceMarking(customer: CustomerWithMarking): string | null {
  return customer?.invoice_marking?.trim() || null
}

/**
 * Märkning for a new invoice: what the caller or the source document states,
 * else the customer card's Märkning. Blank (absent, null or whitespace)
 * states nothing, as for the Fakturareferens.
 */
export function invoiceMarkingForNewInvoice(
  stated: string | null | undefined,
  customer: CustomerWithMarking,
): string | null {
  if (stated && stated.trim() !== '') return stated
  return customerInvoiceMarking(customer)
}
