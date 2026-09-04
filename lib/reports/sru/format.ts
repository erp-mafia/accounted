/**
 * Field formatters shared by the SRU generators (INK2 and NE-bilaga). SRU is a
 * Skatteverket line format: dates are YYYYMMDD, times HHMMSS, amounts are hela
 * kronor with the öre truncated and no separators.
 */

/** Format a Date as YYYYMMDD (local time, as the files are stamped on the user's clock). */
export function sruDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/** Format a Date as HHMMSS. */
export function sruTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}${m}${s}`
}

/** Format an integer amount: hela kronor, no decimals/thousands separators, öre truncated. */
export function sruAmount(amount: number): string {
  return Math.trunc(amount).toString()
}
