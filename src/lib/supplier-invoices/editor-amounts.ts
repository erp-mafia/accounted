import { netVat } from '@/lib/bookkeeping/gross-split'
import { roundOre } from '@/lib/money'
import { supplierInvoiceDisplayFigures } from '@/lib/bookkeeping/supplier-invoice-display-figures'
import { isSupplierInvoiceRoundingItem, supplierInvoiceRoundingItem } from '@/lib/bookkeeping/supplier-invoice-rounding-item'
import { allocateDocumentVat, type DocumentVatLine, type StatedRateVat } from '@/lib/vat/document-vat'
import { reverseChargeRateOf } from './reverse-charge-rate'

interface AmountItem {
  amount: number
  account_number: string
  vat_rate: number
  vat_amount?: number
  reverse_charge_rate?: number
}

/**
 * Derive the editor's totals and the invoice adjustment saved with its items.
 *
 * The VAT is what the create endpoints book (lib/vat/document-vat.ts): per
 * rate on the summed base, or the invoice's own VAT (`statedVat`) when it is
 * within the per-line rounding of that, spread over the lines. Reverse
 * charge self-assesses on the summed base per rate, as the registration
 * verifikat does. `statedVatAccepted` says whether the stated figure is the
 * one shown; a figure that does not fit falls back to the summed base, and
 * the endpoint would refuse it with the reason.
 */
export function supplierInvoiceEditorAmounts(
  items: AmountItem[],
  currency: string,
  reverseCharge: boolean,
  oreRounding: boolean,
  statedVat?: ReadonlyArray<StatedRateVat> | null,
) {
  const lines: DocumentVatLine[] = items.map((item) => {
    // Match the create endpoints' per-line normalization before totaling.
    const amount = roundOre(item.amount || 0)
    // Rounding is outside the self-assessed VAT base too.
    const rate = reverseCharge
      ? (isSupplierInvoiceRoundingItem({ ...item, vat_rate: 0 }, amount, currency) ? 0 : reverseChargeRateOf(item))
      : item.vat_rate || 0
    const overrideVat = !reverseCharge && item.vat_amount != null ? roundOre(item.vat_amount) : null
    return { lineTotal: amount, rate, overrideVat }
  })
  const stated = reverseCharge ? null : statedVat ?? null
  const withStated = stated ? allocateDocumentVat(lines, stated) : null
  const statedVatAccepted = withStated?.ok === true
  const lineVat = withStated?.ok ? withStated.lineVat : summedBaseVat(lines)

  const itemTotals = lines.map((line, index) => ({ lineTotal: line.lineTotal, vatAmount: lineVat[index], vatRate: line.rate }))
  const subtotal = roundOre(itemTotals.reduce((sum, item) => sum + item.lineTotal, 0))
  const totalVat = roundOre(itemTotals.reduce((sum, item) => sum + item.vatAmount, 0))
  const total = roundOre(subtotal + (reverseCharge ? 0 : totalVat))
  const figures = supplierInvoiceDisplayFigures({ total, currency, ore_rounding: oreRounding })
  const roundingItem = figures.rounding.applies
    ? supplierInvoiceRoundingItem(figures.rounding.roundingDelta, currency)
    : null
  return { itemTotals, subtotal, totalVat, total, figures, roundingItem, statedVatAccepted }
}

/** The VAT on the summed base per rate; without a stated figure it is never refused. */
function summedBaseVat(lines: DocumentVatLine[]): number[] {
  const result = allocateDocumentVat(lines)
  return result.ok ? result.lineVat : lines.map((line) => line.overrideVat ?? netVat(line.lineTotal, line.rate))
}
