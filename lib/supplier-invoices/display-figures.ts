import { getDisplayTotal, type DisplayTotal } from '@/lib/invoices/rounding'

/**
 * Supplier invoices never had a company-wide öresavrundning setting: only an
 * explicit per-invoice `true` rounds, and a null flag resolves to off. The
 * fallback is pinned here so no caller has to remember to pass
 * `{ ore_rounding: false }` as the company argument.
 */
const SUPPLIER_INVOICE_ROUNDING_FALLBACK = { ore_rounding: false } as const

export interface SupplierInvoiceDisplayInput {
  /** Total incl. VAT, before any additional display rounding. */
  total: number
  currency: string
  /** Per-invoice öresavrundning flag. null/undefined resolves to off. */
  ore_rounding?: boolean | null
}

export interface SupplierInvoiceDisplayFigures {
  /** The supplied total to the öre. */
  exactTotal: number
  /** Öresavrundning outcome on that total (SEK only, flag on, öre to round). */
  rounding: DisplayTotal
  /**
   * What the user is told to pay: whole kronor when rounding applies, else
   * the exact total. The bank row of a Bankgiro/Swish payment carries this
   * figure. New editor submissions save the adjustment as an invoice item;
   * legacy display-only rounding is handled when the payment is matched.
   */
  toPay: number
}

/**
 * One source of truth for the figures every supplier-invoice surface shows
 * in the editor summary, review, detail page and list. This helper only
 * presents amounts; editor-amounts derives the item saved on new invoices.
 */
export function supplierInvoiceDisplayFigures(
  invoice: SupplierInvoiceDisplayInput,
): SupplierInvoiceDisplayFigures {
  const rounding = getDisplayTotal(invoice, SUPPLIER_INVOICE_ROUNDING_FALLBACK)
  return { exactTotal: invoice.total, rounding, toPay: rounding.displayed }
}
