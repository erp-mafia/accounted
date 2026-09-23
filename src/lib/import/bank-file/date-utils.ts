/**
 * Date normalization for bank file imports.
 *
 * Converts common Swedish/European date formats to canonical YYYY-MM-DD.
 * Used by all bank-specific parsers and the generic CSV fallback.
 */

/**
 * Normalize a date string to YYYY-MM-DD.
 *
 * Supported formats:
 * - YYYY-MM-DD (pass-through)
 * - YYYY/MM/DD
 * - YYYYMMDD
 * - DD.MM.YYYY / D.M.YYYY
 * - DD/MM/YYYY / D/M/YYYY
 *
 * The `hint` parameter disambiguates DD/MM vs MM/DD when using slash separators.
 * Default assumption is DD/MM (European convention) since this is a Swedish app.
 *
 * Returns the canonical YYYY-MM-DD string, or null if unparseable.
 */
export function normalizeDate(raw: string | undefined | null, hint?: string): string | null {
  if (!raw) return null
  const s = raw.trim()
  if (!s) return null

  let year: number
  let month: number
  let day: number

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number)
    year = y; month = m; day = d

  // YYYY/MM/DD
  } else if (/^\d{4}\/\d{2}\/\d{2}$/.test(s)) {
    const [y, m, d] = s.split('/').map(Number)
    year = y; month = m; day = d

  // YYYYMMDD
  } else if (/^\d{8}$/.test(s)) {
    year = parseInt(s.substring(0, 4), 10)
    month = parseInt(s.substring(4, 6), 10)
    day = parseInt(s.substring(6, 8), 10)

  // DD.MM.YYYY or D.M.YYYY
  } else if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) {
    const parts = s.split('.').map(Number)
    day = parts[0]; month = parts[1]; year = parts[2]

  // DD/MM/YYYY or D/M/YYYY (or MM/DD/YYYY based on hint)
  } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const parts = s.split('/').map(Number)
    if (hint === 'MM/DD/YYYY') {
      month = parts[0]; day = parts[1]; year = parts[2]
    } else {
      // Default: DD/MM/YYYY (European)
      day = parts[0]; month = parts[1]; year = parts[2]
    }

  } else {
    return null
  }

  // Validate ranges
  if (year < 1900 || year > 2100) return null
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null

  // Check day is valid for the given month
  const maxDay = new Date(year, month, 0).getDate()
  if (day > maxDay) return null

  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}
