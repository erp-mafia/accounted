import type { Invoice, InvoiceDocumentType } from '@/types'

/**
 * Invoice statuses "Skicka igen" (crm#1339) is offered for: issued and still
 * unpaid. The copy email repeats the amount to pay, so a paid or partly paid
 * invoice would invite a second payment; a paid one has the
 * betalningsbekräftelse instead. A credited or cancelled invoice is no longer
 * a payment request at all.
 */
const RESENDABLE_STATUSES = ['sent', 'overdue'] as const

/**
 * Whether the invoice itself may be emailed again as a copy: a faktura or a
 * kreditfaktura (quotes, proformas and delivery notes have their own flows)
 * in a resendable status. The other half of the rule is the delivery history:
 * only a file Accounted emailed and archived is sent again
 * (`findArchivedInvoiceDelivery`), never a re-render.
 *
 * Shared by the resend route and the detail page, so the two can never
 * disagree on who gets the menu item.
 */
export function isInvoiceResendEligible(
  invoice: Pick<Invoice, 'status'> & { document_type?: InvoiceDocumentType | null },
): boolean {
  const docType = invoice.document_type || 'invoice'
  if (docType !== 'invoice') return false
  return (RESENDABLE_STATUSES as readonly string[]).includes(invoice.status)
}
