/**
 * Invoice statuses Kreditera is offered in.
 *
 * The customer credit service refuses every other status
 * (creditNoteRefusal, lib/invoices/credit-invoice.ts), and the invoice pages
 * and the voucher owner (lib/core/bookkeeping/voucher-owner.ts) offer
 * Kreditera on exactly these, so no surface sends someone to a credit the
 * invoice will not take. In the ledger kernel beside the other invoice
 * booking rules (booking-mode.ts), so the kernel reads it without reaching
 * into the invoicing block.
 *
 * Dependency-free on purpose: client components import this too.
 */
export const CREDITABLE_INVOICE_STATUSES = ['sent', 'paid', 'overdue'] as const

/**
 * A supplier invoice is credited from its page once it has passed attest and
 * nothing of it is paid yet: a part-paid invoice is settled with the
 * supplier first.
 */
export const CREDITABLE_SUPPLIER_INVOICE_STATUSES = ['approved', 'overdue'] as const

export function isCreditableInvoiceStatus(status: string | null | undefined): boolean {
  return (CREDITABLE_INVOICE_STATUSES as readonly string[]).includes(status ?? '')
}

export function isCreditableSupplierInvoiceStatus(status: string | null | undefined): boolean {
  return (CREDITABLE_SUPPLIER_INVOICE_STATUSES as readonly string[]).includes(status ?? '')
}
