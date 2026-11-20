import { ORE_ROUNDING_ACCOUNT, roundOre } from '@/lib/money'

/** Scope the new VAT-base exclusion to the adjustment the SEK editor creates. */
export function isSupplierInvoiceRoundingItem(
  item: { account_number: string; vat_rate: number },
  amount: number,
  currency: string,
): boolean {
  // Nearest-krona rounding can change a total by at most half a krona.
  // This identifies supported adjustment rows, not a general tax tolerance.
  return currency === 'SEK' && item.account_number === ORE_ROUNDING_ACCOUNT &&
    item.vat_rate === 0 && Math.abs(amount) <= 0.5
}

export interface SupplierInvoiceRoundingItem {
  description: string
  account_number: string
  amount: number
  vat_rate: number
}

/**
 * The zero-VAT 3740 item that carries a supplier invoice's rounding so the
 * booked debt matches the billed total (crm#110). `delta` is the billed total
 * minus the lines incl. moms: positive when the supplier rounded up (a debit
 * on 3740), negative when down. Null when there is no öre to carry or the
 * item would fall outside isSupplierInvoiceRoundingItem (SEK, at most half a
 * krona). The editor passes its whole-krona delta, the inbox tool the gap
 * between the document total and its extracted lines.
 */
export function supplierInvoiceRoundingItem(
  delta: number,
  currency: string,
): SupplierInvoiceRoundingItem | null {
  const amount = roundOre(delta)
  if (amount === 0) return null
  const item = { description: 'Öresavrundning', account_number: ORE_ROUNDING_ACCOUNT, amount, vat_rate: 0 }
  return isSupplierInvoiceRoundingItem(item, amount, currency) ? item : null
}
