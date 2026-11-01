/**
 * Which customer documents a bank row can settle: one definition behind the
 * single match (bookCustomerBankMatch), the batch allocation, a bank row linked
 * to a verifikat with an invoice, and the suggestion pool, so a door cannot
 * book against what the pool never offers.
 *
 * Only a faktura carries a receivable: a proforma, quote or delivery note has
 * no VAT obligation and no binding payment (ML 17 kap 24 §), and a credit note
 * is no payment target. An original with an active credit note is on its way
 * to being cancelled: its receivable is the credit note's business now.
 */

interface CreditNoteRow {
  status: string
  creation_complete?: boolean | null
}

export interface InvoiceDocumentFields {
  document_type?: string | null
  credited_invoice_id?: string | null
  /**
   * The read's embed `credit_notes:invoices!credited_invoice_id(id, status,
   * creation_complete)`. A read without it sees no credit note.
   */
  credit_notes?: CreditNoteRow[] | null
}

/** A credit note against this invoice that is not cancelled and not half-created. */
export function hasActiveCreditNote(invoice: Pick<InvoiceDocumentFields, 'credit_notes'>): boolean {
  return (invoice.credit_notes ?? []).some(
    (creditNote) => creditNote.status !== 'cancelled' && creditNote.creation_complete !== false,
  )
}

export type InvoiceDocumentRefusal =
  | { code: 'MATCH_INVOICE_NOT_INVOICE_TYPE'; details: { documentType: string } }
  | { code: 'MATCH_INVOICE_CREDIT_NOTE'; details?: { reason: 'active_credit_note' } }

/** Why a bank row cannot settle this document, or null when it can. */
export function invoiceDocumentRefusal(invoice: InvoiceDocumentFields): InvoiceDocumentRefusal | null {
  const documentType = invoice.document_type ?? 'invoice'
  if (documentType !== 'invoice') return { code: 'MATCH_INVOICE_NOT_INVOICE_TYPE', details: { documentType } }
  if (invoice.credited_invoice_id) return { code: 'MATCH_INVOICE_CREDIT_NOTE' }
  if (hasActiveCreditNote(invoice)) {
    return { code: 'MATCH_INVOICE_CREDIT_NOTE', details: { reason: 'active_credit_note' } }
  }
  return null
}
