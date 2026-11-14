import { roundOre } from '@/lib/money'
import type { VatTreatment } from '@/types'

const BASIS_POINTS = 10000
/** Above float noise on rate * 10000, below any rate a document states. */
const FINER_THAN_A_BASIS_POINT = 1e-6

/**
 * How far a stated VAT may sit from its rate of the net and still be that
 * rate, in kronor: the per-line öre rounding of a long invoice and an
 * öresavrundning on 3740 stay well inside it. Beyond it part of the sale
 * carries no VAT or another rate's, and one treatment cannot book it.
 */
const STATED_VAT_TOLERANCE_SEK = 1

/** Whether a stated VAT is this rate of the net, within rounding (STATED_VAT_TOLERANCE_SEK). */
export function statedVatFitsRate(statedVat: number, net: number, rate: number): boolean {
  return roundOre(Math.abs(statedVat - netVat(net, rate))) <= STATED_VAT_TOLERANCE_SEK
}

/**
 * The VAT on a net amount, a beskattningsunderlag: the one VAT-on-net rule
 * every invoice line, import, reverse-charge purchase and prefill uses.
 * `rate` is a fraction (0.25).
 *
 *   vat = net × rate, to the nearest öre, an exact half öre up
 *
 * The arithmetic is in whole öre and basis points, so the rounding decides on
 * the exact amount. In floating point 2,75 kr at 6 % is 0,16499… instead of
 * 16,5 öre, and 0,58 kr at 25 % comes back from `× 100` below 14,5 öre: the
 * copies this replaced answered roundOre(net * rate) or
 * Math.round(net * rate * 100) / 100 and booked those amounts 1 öre apart
 * depending on the path.
 *
 * The net is taken to the öre first. A negative net rounds as roundOre does,
 * half toward plus infinity (-0,50 kr at 25 % is -0,12 kr), the rule every
 * rabatt row has been stored by. A rate of 0 or less has no VAT. A rate finer
 * than a basis point (a foreign seller's 9,975 %) has no whole-number form
 * here and stays on the float product: rounding it to 9,98 % would move the
 * VAT by far more than an öre.
 */
export function netVat(net: number, rate: number): number {
  const netOre = Math.round(roundOre(net) * 100)
  const bp = Math.round(rate * BASIS_POINTS)
  if (!(bp > 0) || netOre === 0) return 0
  if (Math.abs(rate * BASIS_POINTS - bp) > FINER_THAN_A_BASIS_POINT) return roundOre((netOre / 100) * rate)
  // round(net × bp / 10000), half up, in integers (net × bp stays far below 2^53).
  return Math.floor((netOre * bp + BASIS_POINTS / 2) / BASIS_POINTS) / 100
}

/**
 * The VAT inside a VAT-inclusive amount, and the net beside it: the one
 * gross split every booking path and every prefill uses.
 *
 *   vat = gross × rate / (1 + rate), to the nearest öre, an exact half öre up
 *   net = gross − vat (so net + vat is the gross exactly)
 *
 * The arithmetic is in whole öre and basis points, so the rounding decides on
 * the exact amount. In floating point, 0,42 kr at 12 % is 0,04499… instead of
 * 4,5 öre and rounded down; the generators did that with
 * Math.round(x * 100) / 100 or roundOre and could book a 12 % sale 1 öre
 * apart depending on the path. Only 12 % has exact half-öre splits (gross ×
 * 3/28): at 25 % (gross / 5) and 6 % (gross × 3/53) none exist, so those
 * rates book exactly as before.
 *
 * VAT first, net as what is left: rounding the net instead (gross / (1 + rate))
 * lands 1 öre on the other side of the VAT on those same 12 % halves, 1,26 kr
 * as 1,13 + 0,13 instead of 1,12 + 0,14.
 *
 * The gross is taken to the öre first. A negative gross splits as the mirror
 * image of the positive one, so a refund takes back exactly the VAT of its
 * sale. A rate of 0 or less has no VAT.
 */
export function splitGrossVat(gross: number, rate: number): { vat: number; net: number } {
  const grossOre = Math.round(roundOre(gross) * 100)
  const bp = Math.round(rate * BASIS_POINTS)
  if (!(bp > 0) || grossOre === 0) return { vat: 0, net: grossOre / 100 + 0 }
  const sign = grossOre < 0 ? -1 : 1
  const g = Math.abs(grossOre)
  const den = BASIS_POINTS + bp
  // round(g × bp / den), half up, in integers (g × bp stays far below 2^53).
  const vatOre = Math.floor((2 * g * bp + den) / (2 * den))
  return { vat: (sign * vatOre) / 100 + 0, net: (sign * (g - vatOre)) / 100 + 0 }
}

/** The VAT inside a VAT-inclusive amount (splitGrossVat's vat). */
export function grossVat(gross: number, rate: number): number {
  return splitGrossVat(gross, rate).vat
}

/** The highest Swedish VAT rate (ML 2023:200 9 kap. 2 §): no document states more of its gross as moms. */
export const HIGHEST_VAT_RATE = 0.25

/**
 * The most moms a VAT-inclusive amount can hold: its share at the highest
 * rate (HIGHEST_VAT_RATE), which is 25 % of the net. A mixed-rate document
 * holds less, never more.
 */
export function maxVatInGross(gross: number): number {
  return grossVat(Math.abs(gross), HIGHEST_VAT_RATE)
}

/**
 * Whether a document's stated moms can be the moms inside this gross: at most
 * maxVatInGross, both taken to the öre. The one ceiling for booking "moms
 * enligt underlag": the booking refuses a figure above it, and a client asks
 * here before it sends one, so the two never disagree. A higher figure is a
 * misread, or a document that covers more than this payment. Both amounts
 * are in the same currency.
 */
export function vatWithinGrossCeiling(vat: number, gross: number): boolean {
  return roundOre(vat) <= maxVatInGross(gross)
}

/**
 * The domestic VAT treatment for a decimal rate (0.25, 0.12, 0.06), or null
 * for any other rate.
 */
export function treatmentForRate(rate: number): Extract<VatTreatment, 'standard_25' | 'reduced_12' | 'reduced_6'> | null {
  if (rate === 0.25) return 'standard_25'
  if (rate === 0.12) return 'reduced_12'
  if (rate === 0.06) return 'reduced_6'
  return null
}
