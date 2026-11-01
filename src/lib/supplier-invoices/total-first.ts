import { roundOre } from '@/lib/money'
import { splitGrossVat } from '@/lib/bookkeeping/gross-split'
import { getDisplayTotal } from '@/lib/bookkeeping/invoice-rounding'

/**
 * Total-first entry on the supplier-invoice form: the person types what the
 * invoice says (Fakturabelopp, and its Moms when it shows one) and a single
 * kontering row gets its net from them, instead of the person working the net
 * out and checking the total at the bottom afterwards.
 *
 * The invoice's own moms decides the net when it is given: moms / sats
 * reproduces that moms to the öre at 25, 12 and 6 % (the rounded net is at
 * most 0.005 kr off, which moves the recomputed moms by at most 0.0006 kr),
 * so whatever is left between the rows and the Fakturabelopp is
 * the supplier's öresavrundning, not a skewed moms. Without a moms the total
 * is split by the sats. Reverse charge and a 0 % row carry no moms: the
 * whole invoice is the net.
 */
export function rowNetFromInvoiceTotals(input: {
  total: number
  vat: number | null
  rate: number
  reverseCharge: boolean
}): number {
  const { total, vat, rate, reverseCharge } = input
  if (reverseCharge || !(rate > 0) || vat === 0) return total
  if (vat != null) return roundOre(vat / rate)
  return splitGrossVat(total, rate).net
}

/**
 * Whether the invoice's total is the rows' exact total rounded to whole
 * kronor (SEK only): the case öresavrundning exists for. Same rule as the
 * rounding the invoice is booked and displayed with (getDisplayTotal), so
 * switching öresavrundning on makes the payable equal the invoice total.
 */
export function isWholeKronaRoundingOf(
  exactTotal: number,
  invoiceTotal: number | null,
  currency: string,
): boolean {
  if (invoiceTotal == null) return false
  const rounded = getDisplayTotal({ total: exactTotal, currency, ore_rounding: true }, null)
  return rounded.applies && rounded.displayed === invoiceTotal
}
