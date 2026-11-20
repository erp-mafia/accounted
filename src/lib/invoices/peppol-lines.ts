import type { InvoiceItem } from '@/types'

/**
 * A Peppol invoice line (BG-25) needs a quantity, a price and an amount, so a
 * text row has no line to go into: the e-invoice carries the product rows
 * (lib/invoices/peppol-bis-billing.ts), and free text reaches the buyer only
 * through the invoice note (BT-22, Anteckningar). Kept apart from the
 * generator so the send dialog can tell the user before it happens.
 */
export function isPeppolInvoiceLine(item: Pick<InvoiceItem, 'line_type'>): boolean {
  return item.line_type !== 'text'
}

/** The text rows with words in them that an e-invoice leaves out. */
export function countTextRowsLeftOutOfPeppol(
  items: ReadonlyArray<Pick<InvoiceItem, 'line_type' | 'description'>>,
): number {
  return items.filter((item) => !isPeppolInvoiceLine(item) && (item.description ?? '').trim() !== '').length
}
