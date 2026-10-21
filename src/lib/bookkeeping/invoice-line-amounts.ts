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
 *   vat      = roundOre(net * vat_rate / 100)        (computeLineVat)
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

/**
 * The VAT of one invoice line, what invoice_items.vat_amount stores: the net
 * line total times the rate in percent, rounded to the öre once.
 *
 * This is the one per-line VAT rule. The invoice builder stores it, the
 * previews, the editor and the invoice page show it, ROT/RUT bases its
 * deduction on it, and the Peppol readiness check (LINE_VAT_MISMATCH)
 * compares the stored value against it, so none of them can disagree.
 *
 * Peppol BIS Billing 3.0 (section 9, Rounding) rounds amounts to two
 * decimals; the tie-break is roundOre's (half away from zero on a positive
 * amount). The hand-rolled form this replaces (scale by 100, Math.round,
 * scale back) rounded some exact half-öre values down: 571,30 kr at 25 % is
 * exactly 142,825 kr, but 571.3 * 25 is 14282.499999999998 in binary
 * floating point, so the line stored 142,82 while the check expected 142,83
 * and refused the invoice (crm#1343).
 */
export function computeLineVat(net: number, vatRatePercent: number): number {
  return roundOre((net * vatRatePercent) / 100)
}
