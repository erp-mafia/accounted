import { roundOre } from '@/lib/money'

/**
 * How far a supplier invoice's document total may sit from its lines incl.
 * VAT before it is not rounding any more: half a krona, the öresavrundning
 * bound (isSupplierInvoiceRoundingItem), plus half an öre per line, because
 * each staged line rounds its own VAT while the document computes VAT on the
 * sum per rate (120 lines of 9.98 at 25 % carry 300.00 line by line against
 * the document's 299.40). Capped at 2.00 so a long invoice never hides a real
 * error. A larger gap means the lines or the total are wrong, and registering
 * the invoice anyway leaves the reskontra (supplier_invoices.total) apart from
 * what the registration verifikat credits on 2440: the lines plus their VAT.
 */
export const SUPPLIER_INVOICE_TOTALS_TOLERANCE = 0.5
const PER_LINE_VAT_ROUNDING = 0.005
const TOLERANCE_CAP = 2

/** The tolerance for an invoice of `lineCount` lines (see SUPPLIER_INVOICE_TOTALS_TOLERANCE). */
export function supplierInvoiceTotalsTolerance(lineCount: number): number {
  const tolerance = SUPPLIER_INVOICE_TOTALS_TOLERANCE + PER_LINE_VAT_ROUNDING * Math.max(0, lineCount)
  // Three decimals: the per-line half öre, without float noise at the bound.
  return Math.min(Math.round(tolerance * 1000) / 1000, TOLERANCE_CAP)
}

/** The two figures of a supplier invoice line the 2440 credit is built from. */
export interface SupplierInvoiceLineAmounts {
  line_total: number
  vat_amount: number
}

/** The lines plus their VAT, to the öre: what the registration credits 2440. */
export function supplierInvoiceLinesInclVat(lines: readonly SupplierInvoiceLineAmounts[]): number {
  return roundOre(lines.reduce((sum, line) => sum + line.line_total + line.vat_amount, 0))
}

/** The document total minus the lines incl. VAT. Positive when the lines fall short. */
export function supplierInvoiceTotalsGap(
  total: number,
  lines: readonly SupplierInvoiceLineAmounts[],
): number {
  return roundOre(roundOre(total) - supplierInvoiceLinesInclVat(lines))
}

/** True when a gap is larger than rounding can explain for an invoice of `lineCount` lines. */
export function exceedsSupplierInvoiceTotalsTolerance(gap: number, lineCount: number): boolean {
  return Math.abs(roundOre(gap)) > supplierInvoiceTotalsTolerance(lineCount)
}

/** A priced line as the inbox staging path builds it. */
export interface GrossReadableLine extends SupplierInvoiceLineAmounts {
  unit_price: number
}

/** A line as the document prints it, for reading it as gross. */
export interface PrintedLineAmount {
  /** The extracted line amount (lineTotal) as printed. */
  amount: number
  /** The VAT rate the document applies to the line, as a decimal fraction; 0 for none. */
  rate: number
  /**
   * True for a Swedish rate (deductible ingående moms on 2641); false for VAT
   * at a foreign rate, which is not deductible here and stays in the cost.
   */
  deductible: boolean
}

export interface LinesReadAsGross<T> {
  lines: T[]
  /** The extracted line amounts as printed, i.e. incl. VAT. */
  grossSum: number
  /** The VAT inside them, line by line, deductible or not. */
  vatSum: number
}

/**
 * Read extracted line amounts as INCLUDING VAT (feedback seq 983757).
 *
 * An extraction is meant to carry each line excluding VAT, but a document that
 * only prints gross line amounts (a utility bill whose line reads "inkl.
 * moms") came through with the gross in lineTotal, and staging added the rate
 * on top again: 25 % moms on an amount that already held it, booked on 2641
 * and in the 2440 credit. This reading is taken only when the document itself
 * says so: the printed amounts sum to the document total AND the VAT inside
 * them, line by line at each line's own rate, matches the document's VAT, both
 * within the rounding tolerance. A line at a Swedish rate then becomes net =
 * amount - VAT with VAT = amount x rate / (1 + rate) rounded to the öre, so net
 * + VAT is the printed amount exactly; a line at a foreign rate keeps the whole
 * printed amount as cost. Null when either test fails or there is no VAT to
 * split out: the caller refuses instead of guessing.
 *
 * `printed[i]` describes `lines[i]`; the other fields of each line are kept,
 * and its unit price scales with the line.
 */
export function readSupplierInvoiceLinesAsGross<T extends GrossReadableLine>(
  lines: readonly T[],
  printed: readonly PrintedLineAmount[],
  total: number,
  documentVat: number,
): LinesReadAsGross<T> | null {
  if (printed.length !== lines.length) return null
  const vatsInside = printed.map((line) =>
    line.rate > 0 ? roundOre((line.amount * line.rate) / (1 + line.rate)) : 0,
  )
  const grossSum = roundOre(printed.reduce((sum, line) => sum + line.amount, 0))
  const vatSum = roundOre(vatsInside.reduce((sum, vat) => sum + vat, 0))
  if (vatSum <= 0) return null
  if (exceedsSupplierInvoiceTotalsTolerance(roundOre(total) - grossSum, lines.length)) return null
  if (exceedsSupplierInvoiceTotalsTolerance(vatSum - roundOre(documentVat), lines.length)) return null
  const read = lines.map((line, idx) => {
    const { amount, deductible } = printed[idx]
    const vat = deductible ? vatsInside[idx] : 0
    const lineTotal = roundOre(amount - vat)
    const unitPrice = line.line_total === 0
      ? line.unit_price
      : roundOre(line.unit_price * (lineTotal / line.line_total))
    return { ...line, line_total: lineTotal, unit_price: unitPrice, vat_amount: vat }
  })
  return { lines: read, grossSum, vatSum }
}
