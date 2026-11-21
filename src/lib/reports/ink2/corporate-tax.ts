/**
 * Bolagsskatt on a taxable result (IL 65 kap. 10 §), the one computation the
 * bokslut books (lib/bokslut/tax-provision/bolagsskatt-calculator) and the
 * INK2 declaration checks the booked tax against.
 */

/** 20,6 % since beskattningsår starting 2021-01-01. */
export const BOLAGSSKATT_RATE = 0.206

/**
 * The taxable result rounded down to a whole 10 SEK before the rate is
 * applied (IL 1 kap. 7 §); a loss or zero result is 0.
 */
export function taxableResultInWholeTens(taxableResult: number): number {
  return Math.floor(Math.max(0, taxableResult) / 10) * 10
}

/** Bolagsskatt in whole kronor on a taxable result. */
export function bolagsskattOn(taxableResult: number): number {
  return Math.round(taxableResultInWholeTens(taxableResult) * BOLAGSSKATT_RATE)
}
