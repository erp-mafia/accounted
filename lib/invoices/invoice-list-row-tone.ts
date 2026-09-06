import type { Invoice } from '@/types'

/**
 * Row tone for the customer invoice list (#2215): the list must read without
 * the status column. Four tones, three of which the eye separates at a glance:
 *
 * - settled: the row is done (paid, cancelled, credited) and recedes
 * - open: a customer invoice waiting for money (sent, partially paid)
 * - overdue: an open customer invoice past its due date
 * - none: everything else (drafts, quotes, proformas, delivery notes, unpaid
 *   credit notes); the status column already marks those with a chip
 *
 * The guards mirror matchesListTab in the list page: only a real customer
 * invoice (document_type 'invoice', not a credit note) counts as open or
 * overdue, so a sent proforma or quote never reads as a receivable.
 */
export type InvoiceRowTone = 'settled' | 'open' | 'overdue' | 'none'

export type InvoiceRowToneInput = Pick<Invoice, 'status' | 'credited_invoice_id'> & {
  /** Older list rows can lack the column; the list treats a missing value as 'invoice'. */
  document_type?: Invoice['document_type'] | null
}

const SETTLED_STATUSES: ReadonlySet<Invoice['status']> = new Set(['paid', 'cancelled', 'credited'])

export function invoiceRowTone(invoice: InvoiceRowToneInput): InvoiceRowTone {
  if (SETTLED_STATUSES.has(invoice.status)) return 'settled'
  const isCustomerInvoice =
    (invoice.document_type || 'invoice') === 'invoice' && !invoice.credited_invoice_id
  if (!isCustomerInvoice) return 'none'
  if (invoice.status === 'overdue') return 'overdue'
  if (invoice.status === 'sent' || invoice.status === 'partially_paid') return 'open'
  return 'none'
}
