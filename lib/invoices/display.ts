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

/**
 * The number a user must type to confirm crediting an invoice. Regular
 * invoices confirm with their own `invoice_number`; self-billed invoices have
 * `invoice_number` null by design, so the counterparty's
 * `external_invoice_number` (the number shown everywhere in the UI) is the
 * one to type. Null when the invoice carries no number at all: the credit
 * flow must stay disabled then.
 */
export function creditConfirmNumber(invoice: {
  invoice_number?: string | null
  external_invoice_number?: string | null
}): string | null {
  return invoice.invoice_number ?? invoice.external_invoice_number ?? null
}

/**
 * True when an invoice line should render as a pure text row: description
 * only, no quantity/unit/price/amount columns. Explicit text rows
 * (line_type 'text') always qualify; so do product rows carrying no amounts
 * at all (quantity and unit price both zero/absent). Users write free-text
 * lines via the article picker's "Egen rad (fri text)" and leave antal/pris
 * at zero; printing "0 / 0,00 SEK / 0,00 SEK" on those is noise (issue #1053).
 */
export function isTextLikeLine(item: {
  line_type?: 'product' | 'text' | null
  quantity?: number | null
  unit_price?: number | null
}): boolean {
  return item.line_type === 'text' || (!item.quantity && !item.unit_price)
}
