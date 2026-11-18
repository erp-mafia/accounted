import { isZeroOre, roundOre } from '@/lib/money'
import { splitGrossVat } from '@/lib/bookkeeping/gross-split'
import { getDisplayTotal } from '@/lib/bookkeeping/invoice-rounding'
import { supplierInvoiceEditorAmounts } from './editor-amounts'
import { statedVatFromInvoiceField } from './form-payload'

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
 * What the total-first fill writes on the single kontering row, or null to
 * leave it: the net the totals give (`net`, rowNetFromInvoiceTotals at the
 * row's sats; null without a Fakturabelopp) while the row is empty or still
 * holds what the fill last put there (`filled`). Any other amount is the
 * person's and is never overwritten.
 *
 * A row a reading made (`fromReading`) is left under reverse charge: there
 * the fill's net is the whole Fakturabelopp, which would put whatever the
 * seller charged on top of the read lines into the row without a word. The
 * fill leaves the row, and the cross-check shows what is left. A row typed
 * by hand follows the fill under reverse charge as it always has.
 */
export function totalFirstFill(input: {
  amount: number
  net: number | null
  filled: number | null
  fromReading: boolean
  reverseCharge: boolean
}): number | null {
  const { amount, net, filled } = input
  if (net == null) return null
  if (amount !== 0 && amount !== filled) return null
  if (input.fromReading && input.reverseCharge) return null
  return amount === net ? null : net
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

/**
 * Whether the invoice's own moms is booked, so the editor has a Moms field
 * for it: an icke momsregistrerad company books the gross as the cost, and
 * a reverse-charge invoice carries no moms.
 */
export function invoiceVatIsBooked(vatRegistered: boolean, reverseCharge: boolean): boolean {
  return vatRegistered && !reverseCharge
}

/**
 * The rows as the editor books and shows them beside the invoice's own
 * Fakturabelopp and Moms: the invoice's moms when the rows take it, and
 * öresavrundning when the gap to the Fakturabelopp is whole-krona rounding,
 * until the person has flipped the switch (`oreRoundingChoice`).
 */
export function rowsAgainstInvoiceTotals(input: {
  items: Parameters<typeof supplierInvoiceEditorAmounts>[0]
  currency: string
  reverseCharge: boolean
  invoiceTotal: number | null
  invoiceVat: number | null
  oreRoundingChoice?: boolean | null
}) {
  const { items, currency, reverseCharge } = input
  const statedVat = statedVatFromInvoiceField(items, input.invoiceVat, reverseCharge)
  const exact = supplierInvoiceEditorAmounts(items, currency, reverseCharge, false, statedVat)
  const oreRounding = input.oreRoundingChoice ?? isWholeKronaRoundingOf(exact.total, input.invoiceTotal, currency)
  const amounts = oreRounding ? supplierInvoiceEditorAmounts(items, currency, reverseCharge, true, statedVat) : exact
  return { statedVat, oreRounding, amounts }
}

/**
 * The editor's cross-check: how far the invoice's Fakturabelopp and Moms sit
 * from the rows' payable and moms. A figure the invoice does not state has no
 * difference; the Fakturabelopp matches only when there is one.
 */
export function invoiceTotalsCrosscheck(input: {
  invoiceTotal: number | null
  invoiceVat: number | null
  toPay: number
  totalVat: number
}) {
  const totalDiff = input.invoiceTotal == null ? null : roundOre(input.invoiceTotal - input.toPay)
  const vatDiff = input.invoiceVat == null ? null : roundOre(input.invoiceVat - input.totalVat)
  return {
    totalDiff,
    totalMatches: totalDiff != null && isZeroOre(totalDiff),
    vatDiff,
    vatMatches: vatDiff == null || isZeroOre(vatDiff),
  }
}
