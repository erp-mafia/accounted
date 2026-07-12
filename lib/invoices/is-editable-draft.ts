/**
 * A draft invoice (or proforma / delivery note) is editable in place: header
 * fields AND line items: only while it has no committed verifikat. A journal
 * entry is created when the invoice is sent (mark-sent / send) or, for
 * kontantmetoden, at payment; once one exists, BFL immutability applies and the
 * invoice must be corrected with a credit note instead. A self-billed invoice we
 * received is the counterparty's document: never editable here.
 *
 * This is the single source of truth for that predicate. The PATCH route
 * (app/api/invoices/[id]/route.ts) enforces it server-side; the detail and edit
 * pages call it only to avoid opening a dead form: they are UX hints, not the
 * trust boundary. Keeping all three on one function stops the rule from drifting.
 */
export function isEditableInvoiceDraft(invoice: {
  status: string
  journal_entry_id?: string | null
  is_self_billed?: boolean | null
}): boolean {
  return invoice.status === 'draft' && !invoice.journal_entry_id && !invoice.is_self_billed
}
