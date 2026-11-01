import { truncateToWholeKronor } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'

/**
 * Field formatters shared by the SRU generators (INK2 and NE-bilaga). SRU is a
 * Skatteverket line format: dates are YYYYMMDD, times HHMMSS, amounts are hela
 * kronor with the öre truncated and no separators.
 */

/** Format a Date as YYYYMMDD, the Swedish calendar day: the files are stamped on the user's clock. */
export function sruDate(date: Date): string {
  return todayIsoStockholm(date).replace(/-/g, '')
}

const SWEDISH_TIME = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Format a Date as HHMMSS, on the same clock as sruDate. */
export function sruTime(date: Date): string {
  return SWEDISH_TIME.format(date).replace(/:/g, '')
}

/** Format an integer amount: hela kronor, no decimals/thousands separators, öre truncated. */
export function sruAmount(amount: number): string {
  return truncateToWholeKronor(amount).toString()
}
