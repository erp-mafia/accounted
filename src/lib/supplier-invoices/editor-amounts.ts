import { roundOre } from '@/lib/money'
import { supplierInvoiceDisplayFigures } from './display-figures'
import { isSupplierInvoiceRoundingItem } from './rounding-item'

interface AmountItem {
  amount: number
  account_number: string
  vat_rate: number
  vat_amount?: number
  reverse_charge_rate?: number
}

/** Derive the editor's totals and the invoice adjustment saved with its items. */
export function supplierInvoiceEditorAmounts(
  items: AmountItem[],
  currency: string,
  reverseCharge: boolean,
  oreRounding: boolean,
) {
  const itemTotals = items.map((item) => {
    // Match the create endpoints' per-line normalization before totaling.
    const amount = Math.round((item.amount || 0) * 100) / 100
    // Rounding is outside the self-assessed VAT base too.
    const rate = reverseCharge
      ? (isSupplierInvoiceRoundingItem({ ...item, vat_rate: 0 }, amount, currency) ? 0 : item.reverse_charge_rate ?? 0.25)
      : item.vat_rate || 0
    const vatAmount = !reverseCharge && item.vat_amount != null
      ? Math.round(item.vat_amount * 100) / 100
      : Math.round(amount * rate * 100) / 100
    return { lineTotal: amount, vatAmount, vatRate: rate }
  })
  const subtotal = roundOre(itemTotals.reduce((sum, item) => sum + item.lineTotal, 0))
  const totalVat = roundOre(itemTotals.reduce((sum, item) => sum + item.vatAmount, 0))
  const total = roundOre(subtotal + (reverseCharge ? 0 : totalVat))
  const figures = supplierInvoiceDisplayFigures({ total, currency, ore_rounding: oreRounding })
  const roundingItem = figures.rounding.applies
    ? {
        description: 'Öresavrundning',
        account_number: '3740',
        amount: figures.rounding.roundingDelta,
        vat_rate: 0,
      }
    : null
  return { itemTotals, subtotal, totalVat, total, figures, roundingItem }
}
