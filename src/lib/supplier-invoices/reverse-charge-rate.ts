/**
 * The reverse-charge sats of a supplier-invoice row in the editor
 * (components/supplier-invoices/NewSupplierInvoiceForm.tsx): the Swedish sats
 * the buyer self-assesses at under omvänd betalningsskyldighet (ruta 30, 31
 * or 32).
 */

import { isLegalVatRate } from '@/lib/vat/supplier-invoice-line-checks'

/** The sats a reverse-charge purchase is self-assessed at when nothing else is known: the standard rate. */
const STANDARD_RATE = 0.25

/** Whether a rate is one a reverse-charge purchase can be self-assessed at: 6, 12 or 25 %. */
export function isReverseChargeRate(rate: number | null | undefined): rate is number {
  return typeof rate === 'number' && rate > 0 && isLegalVatRate(rate)
}

/**
 * The reverse-charge sats a row starts with when nobody has chosen one: its
 * own moms sats when that is a Swedish sats a reverse-charge purchase can
 * carry (6, 12 or 25 %), else 25 %. Never 0: a row read at 0 % or at a
 * foreign rate self-assesses at 25 %.
 *
 * The one definition the editor sets a row's reverse-charge sats by, on every
 * way a row gets one: a row added under reverse charge, the rows on screen
 * when reverse charge is switched on, and a reading's rows put under reverse
 * charge. So a row gives the same sats whichever came first.
 */
export function reverseChargeRateDefault(vatRate: number | null | undefined): number {
  return isReverseChargeRate(vatRate) ? vatRate : STANDARD_RATE
}

/**
 * The reverse-charge sats a row is self-assessed at: the one it holds when it
 * is a sats a reverse-charge purchase can carry, else its default
 * (reverseChargeRateDefault).
 */
export function reverseChargeRateOf(row: { vat_rate?: number | null; reverse_charge_rate?: number | null }): number {
  return isReverseChargeRate(row.reverse_charge_rate) ? row.reverse_charge_rate : reverseChargeRateDefault(row.vat_rate)
}
