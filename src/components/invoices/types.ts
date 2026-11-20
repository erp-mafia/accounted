import type { Invoice, InvoiceItem, Customer } from '@/types'

/**
 * Invoice row joined with its customer and line items, as loaded by the
 * invoice detail / credit pages and passed to the invoice dialogs.
 */
export interface InvoiceWithRelations extends Omit<Invoice, 'customer'> {
  /**
   * Null when the invoice has no customer: invoices.customer_id is ON DELETE
   * SET NULL, so a customer deleted before the guard (crm#263) or a legacy
   * import leaves the join empty. Every reader must handle it.
   */
  customer: Customer | null
  items: InvoiceItem[]
  // Optional reference to the issuance verifikation. Populated by the
  // backend when the invoice flow auto-books an entry on send; absent on
  // older invoices, on kontantmetoden invoices that recognise revenue at
  // payment, and on companies where issuance is not auto-booked.
  journal_entry_id?: string | null
}
