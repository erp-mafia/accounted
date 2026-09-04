import type { Invoice, InvoiceItem, Customer } from '@/types'

/**
 * Invoice row joined with its customer and line items, as loaded by the
 * invoice detail / credit pages and passed to the invoice dialogs.
 */
export interface InvoiceWithRelations extends Invoice {
  customer: Customer
  items: InvoiceItem[]
  // Optional reference to the issuance verifikation. Populated by the
  // backend when the invoice flow auto-books an entry on send; absent on
  // older invoices, on kontantmetoden invoices that recognise revenue at
  // payment, and on companies where issuance is not auto-booked.
  journal_entry_id?: string | null
}
