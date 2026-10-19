import { roundOre } from '@/lib/money'
import type { VatTreatment } from '@/types'

const BASIS_POINTS = 10000

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
