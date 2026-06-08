export const INVOICE_NUMBER_DRAFT_LABEL = '(Utkast)'

export function invoiceNumberDisplay(value: string | null | undefined): string {
  return value ?? INVOICE_NUMBER_DRAFT_LABEL
}

/**
 * The number to show for an invoice. Self-billing invoices we received carry
 * the counterparty's number in `external_invoice_number` (our own
 * `invoice_number` is null by design), so fall back to it before the draft
 * label.
 */
export function invoiceDisplayNumber(invoice: {
  invoice_number?: string | null
  external_invoice_number?: string | null
}): string {
  return invoice.invoice_number ?? invoice.external_invoice_number ?? INVOICE_NUMBER_DRAFT_LABEL
}
