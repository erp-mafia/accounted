/**
 * Fakturareferens (crm#1200): the reference a buyer wants on every invoice
 * (a cost centre, a reference code, a person), kept on the customer card as
 * customers.invoice_reference.
 *
 * It lands on the invoice as Er referens (invoices.your_reference), the field
 * the PDF prints and the Peppol e-invoice sends as BT-10 BuyerReference, the
 * buyer's own routing reference. Nothing reads the card at print or send time:
 * the value is COPIED when a new invoice is written, so an issued invoice keeps
 * the reference it was issued with after the card changes.
 *
 * Every door that writes a new invoice without a person at the field applies
 * yourReferenceForNewInvoice: v1 create and bulk-create, the agent's
 * create_invoice, recurring schedules, quote and proforma conversion, and
 * order to invoice. The webshop door puts the card value ahead of the
 * buyer's name it used before. The web editor prefills the field in front of
 * the user instead (lib/invoices/editor/customer-reference.ts), so a
 * reference the user clears there stays cleared.
 */

type CustomerWithReference = { invoice_reference?: string | null } | null | undefined

/** The customer card's Fakturareferens, trimmed; null when it has none. */
export function customerInvoiceReference(customer: CustomerWithReference): string | null {
  return customer?.invoice_reference?.trim() || null
}

/**
 * Er referens for a new invoice: what the caller or the source document
 * states, else the customer card's Fakturareferens. Blank (absent, null or
 * whitespace) states nothing: a stored blank cannot tell "cleared on purpose"
 * from "never filled in", and the card's value is the buyer's standing
 * instruction for every invoice.
 */
export function yourReferenceForNewInvoice(
  stated: string | null | undefined,
  customer: CustomerWithReference,
): string | null {
  if (stated && stated.trim() !== '') return stated
  return customerInvoiceReference(customer)
}
