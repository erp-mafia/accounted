import type { Invoice, InvoiceDocumentType } from '@/types'

/**
 * Which invoices may be handed to the customer as a betalningsbekräftelse
 * (#1693): a real faktura whose status is `paid`. Credit notes settle against
 * their original and proformas are not payment requests, so neither has a
 * "betald" state worth confirming. `partially_paid` is excluded on purpose:
 * the customer still owes money, and a document stamped BETALD would say
 * otherwise.
 *
 * Shared by the PDF route (`?variant=paid`), the send-confirmation route and
 * the detail page, so the three can never disagree on who gets the button.
 */
export function isPaymentConfirmationEligible(
  invoice: Pick<Invoice, 'status' | 'credited_invoice_id'> & { document_type?: InvoiceDocumentType | null },
): boolean {
  if (invoice.credited_invoice_id) return false
  const docType = invoice.document_type || 'invoice'
  if (docType !== 'invoice') return false
  return invoice.status === 'paid'
}
