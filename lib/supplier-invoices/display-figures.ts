import { getDisplayTotal, type DisplayTotal } from '@/lib/invoices/rounding'

/**
 * Supplier invoices never had a company-wide öresavrundning setting: only an
 * explicit per-invoice `true` rounds, and a null flag resolves to off. The
 * fallback is pinned here so no caller has to remember to pass
 * `{ ore_rounding: false }` as the company argument.
 */
const SUPPLIER_INVOICE_ROUNDING_FALLBACK = { ore_rounding: false } as const

export interface SupplierInvoiceDisplayInput {
  /** Exact total incl. VAT: what gets registered and credited on 2440. */
  total: number
  currency: string
  /** Per-invoice öresavrundning flag. null/undefined resolves to off. */
  ore_rounding?: boolean | null
}

export interface SupplierInvoiceDisplayFigures {
  /** The registered total to the öre: the 2440 credit in the verifikat. */
  exactTotal: number
  /** Öresavrundning outcome on that total (SEK only, flag on, öre to round). */
  rounding: DisplayTotal
  /**
   * What the user is told to pay: whole kronor when rounding applies, else
   * the exact total. The bank row of a Bankgiro/Swish payment carries this
   * figure; the difference to `exactTotal` is settled against 3740 when the
   * payment is matched (lib/bookkeeping/supplier-payment-lines.ts).
   */
  toPay: number
}

/**
 * One source of truth for the figures every supplier-invoice surface shows
 * after the form: the editor summary, the review step, the detail page and
 * the list. The registered amount and the booked verifikat keep the exact
 * öre; only the presentation rounds.
 */
export function supplierInvoiceDisplayFigures(
  invoice: SupplierInvoiceDisplayInput,
): SupplierInvoiceDisplayFigures {
  const rounding = getDisplayTotal(invoice, SUPPLIER_INVOICE_ROUNDING_FALLBACK)
  return { exactTotal: invoice.total, rounding, toPay: rounding.displayed }
}
