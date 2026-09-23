import { ORE_ROUNDING_ACCOUNT } from '@/lib/money'

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
