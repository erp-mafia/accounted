/**
 * Whether an invoice row positively has no customer (crm#263).
 *
 * invoices.customer_id is ON DELETE SET NULL, so a customer deleted while an
 * invoice pointed at it leaves customer_id null and the customer join null.
 * Such an invoice has no buyer to number, issue, send or render the invoice
 * for (ML 17 kap 24 § names the buyer on every invoice), so each of those
 * paths refuses it with INVOICE_CUSTOMER_MISSING instead of crashing on
 * `customer.name`.
 *
 * Only null counts. An undefined field means the caller did not select it,
 * which says nothing about the row.
 */
export function invoiceLacksCustomer(invoice: {
  customer_id?: string | null
  customer?: unknown
}): boolean {
  return invoice.customer_id === null || invoice.customer === null
}
