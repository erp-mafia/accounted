import { roundOre } from '@/lib/money'

/**
 * Shared per-line amount math for invoice items with an optional percentage
 * discount (rabatt i procent per artikelrad).
 *
 * The formula set is deliberately exact in öre so every surface (editor
 * preview, build-invoice-write, staged-operation commit, PDF, Peppol BG-27
 * line allowance) agrees to the öre:
 *
 *   gross    = roundOre(quantity * unit_price)
 *   discount = roundOre(gross * discount_percent / 100)
 *   net      = roundOre(gross - discount)
 *
 * `net` is what is stored as invoice_items.line_total and what VAT is
 * computed on (the discount reduces the beskattningsunderlag, ML 8 kap 13 §).
 * Because `discount` is rounded before the subtraction, gross - discount is
 * exact 2-decimal arithmetic and the UBL line check
 * LineExtensionAmount = base - allowance holds without a tolerance.
 *
 * A line with no discount is rounded to öre the same way: net =
 * roundOre(quantity * unit_price). It used to keep the raw product, so a
 * three-decimal unit price stored a line_total with a third decimal and a
 * header total a fraction of an öre off, which no payment could match
 * (agent feedback seq 965009). The Peppol LINE_TOTAL_MISMATCH check compares öre-rounded values,
 * so lines stored either way still pass it.
 */
export interface LineAmounts {
  /** Line amount before discount, rounded to öre. */
  gross: number
  /** Discount amount in invoice currency (0 when no discount). */
  discount: number
  /** Line amount after discount: what line_total stores and VAT applies to. */
  net: number
}

/** True when the value is a discount that actually changes the line. */
export function hasLineDiscount(discountPercent: number | null | undefined): boolean {
  return typeof discountPercent === 'number' && discountPercent > 0
}

export function computeLineAmounts(
  quantity: number,
  unitPrice: number,
  discountPercent?: number | null,
): LineAmounts {
  const gross = roundOre((quantity || 0) * (unitPrice || 0))
  if (!hasLineDiscount(discountPercent)) {
    return { gross, discount: 0, net: gross }
  }
  const discount = roundOre((gross * (discountPercent as number)) / 100)
  return { gross, discount, net: roundOre(gross - discount) }
}

/** Convenience: the net line total (what invoice_items.line_total stores). */
export function computeLineNet(
  quantity: number,
  unitPrice: number,
  discountPercent?: number | null,
): number {
  return computeLineAmounts(quantity, unitPrice, discountPercent).net
}
