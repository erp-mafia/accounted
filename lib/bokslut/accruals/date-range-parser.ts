/**
 * Parses Swedish (and a few mixed Swedish/English) date-range patterns out
 * of free-text invoice descriptions / line items so the periodisering wizard
 * can auto-detect supplier invoices and customer invoices whose service
 * window crosses the fiscal-period boundary.
 *
 * The function is intentionally conservative: it only returns a parse when
 * BOTH a recognizable start and end date are present. Single dates, "från
 * 2026-01-01" with no end, and malformed strings all return null. The auto-
 * detect step later sets `confidence: 'low'` when the parser only caught a
 * partial pattern (currently always "high" since partials return null,
 * kept as a knob so the wizard UI can downgrade future heuristics without
 * touching this file).
 *
 * Patterns supported (case-insensitive):
 *   1. ISO   : "period: 2026-01-01 till 2027-12-31"
 *   2. ISO   : "perioden 2026-01-01 - 2026-12-31"
 *   3. Swede : "period: 1 jan 2026 - 31 dec 2026"
 *   4. Swede : "jan 2026 till dec 2026"  (whole-month range, expanded to 1st / last)
 *   5. yyyy-mm: "2026-01 till 2027-12"  (expanded to 1st of start / last of end)
 *   6. Free  : "giltig från 2026-01-01 till 2027-12-31"
 *
 * All return ISO `yyyy-mm-dd`. The function does no fiscal logic: it just
 * reports the parsed window. The caller decides whether endDate > period_end.
 */

const SWEDISH_MONTHS: Record<string, number> = {
  jan: 0,
  januari: 0,
  feb: 1,
  februari: 1,
  mar: 2,
  mars: 2,
  apr: 3,
  april: 3,
  maj: 4,
  jun: 5,
  juni: 5,
  jul: 6,
  juli: 6,
  aug: 7,
  augusti: 7,
  sep: 8,
  september: 8,
  okt: 9,
  oktober: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
}

const MONTH_NAMES_PATTERN = Object.keys(SWEDISH_MONTHS).join('|')

/** Separator tokens between the two dates: " till ", " - ", "–", "—". */
const SEP = '(?:\\s*[-–—]\\s*|\\s+till\\s+|\\s+t\\.?\\s*o\\.?\\s*m\\.?\\s+)'

/** ISO date `yyyy-mm-dd`. */
const ISO = '(\\d{4}-\\d{2}-\\d{2})'

/** yyyy-mm without day. */
const YM = '(\\d{4}-\\d{2})'

/** Swedish long form "1 jan 2026": day optional. */
const SWE_LONG = `(?:(\\d{1,2})\\s+)?(${MONTH_NAMES_PATTERN})\\s+(\\d{4})`

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Number of days in a (1-based) month/year, honoring leap years. */
function daysInMonth(year: number, monthZeroBased: number): number {
  return new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate()
}

function isoFromYMD(year: number, monthZeroBased: number, day: number): string {
  return `${year}-${pad2(monthZeroBased + 1)}-${pad2(day)}`
}

/** "2026-01" → "2026-01-01"; "2026-02" with `lastDay=true` → "2026-02-28". */
function expandYearMonth(ym: string, lastDay: boolean): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym)
  if (!m) return null
  const year = parseInt(m[1], 10)
  const monthZero = parseInt(m[2], 10) - 1
  if (monthZero < 0 || monthZero > 11) return null
  const day = lastDay ? daysInMonth(year, monthZero) : 1
  return isoFromYMD(year, monthZero, day)
}

/** Swedish long form ("1 jan 2026" or "jan 2026") → ISO. When the day is
 *  missing, anchor to the 1st (start side) or the last day of the month
 *  (end side). */
function expandSwedishLong(
  day: string | undefined,
  monthName: string,
  year: string,
  endSide: boolean,
): string | null {
  const monthZero = SWEDISH_MONTHS[monthName.toLowerCase()]
  if (monthZero === undefined) return null
  const y = parseInt(year, 10)
  if (Number.isNaN(y)) return null
  if (day) {
    const d = parseInt(day, 10)
    if (d < 1 || d > daysInMonth(y, monthZero)) return null
    return isoFromYMD(y, monthZero, d)
  }
  return isoFromYMD(y, monthZero, endSide ? daysInMonth(y, monthZero) : 1)
}

function validateRange(startDate: string, endDate: string): boolean {
  // endDate must be strictly after startDate. A single date repeated isn't
  // a range, just a point: the caller should treat that as "no range".
  return endDate > startDate
}

export interface ParsedDateRange {
  startDate: string // ISO yyyy-mm-dd
  endDate: string // ISO yyyy-mm-dd
}

/**
 * Attempt to extract a date range from a free-text description. Returns
 * null if nothing recognizable is found.
 */
export function parseInvoiceDateRange(description: string | null | undefined): ParsedDateRange | null {
  if (!description) return null
  const text = description.toLowerCase()

  // 1. ISO-ISO: "2026-01-01 till 2027-12-31", "2026-01-01 - 2027-12-31"
  const isoRe = new RegExp(`${ISO}${SEP}${ISO}`, 'i')
  const isoMatch = isoRe.exec(text)
  if (isoMatch) {
    const start = isoMatch[1]
    const end = isoMatch[2]
    if (isValidIso(start) && isValidIso(end) && validateRange(start, end)) {
      return { startDate: start, endDate: end }
    }
  }

  // 2. Swedish long form on both sides: "1 jan 2026 - 31 dec 2026"
  const sweRe = new RegExp(`${SWE_LONG}${SEP}${SWE_LONG}`, 'i')
  const sweMatch = sweRe.exec(text)
  if (sweMatch) {
    const startDate = expandSwedishLong(sweMatch[1], sweMatch[2], sweMatch[3], false)
    const endDate = expandSwedishLong(sweMatch[4], sweMatch[5], sweMatch[6], true)
    if (startDate && endDate && validateRange(startDate, endDate)) {
      return { startDate, endDate }
    }
  }

  // 3. yyyy-mm on both sides: "2026-01 till 2027-12"
  // Guarded: don't allow a full ISO date here, anchor to space / start.
  const ymRe = new RegExp(`(?:^|[^\\d-])${YM}${SEP}${YM}(?![\\d-])`, 'i')
  const ymMatch = ymRe.exec(text)
  if (ymMatch) {
    const startDate = expandYearMonth(ymMatch[1], false)
    const endDate = expandYearMonth(ymMatch[2], true)
    if (startDate && endDate && validateRange(startDate, endDate)) {
      return { startDate, endDate }
    }
  }

  return null
}

function isValidIso(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [yStr, mStr, dStr] = s.split('-')
  const year = parseInt(yStr, 10)
  const monthZero = parseInt(mStr, 10) - 1
  const day = parseInt(dStr, 10)
  if (monthZero < 0 || monthZero > 11) return false
  if (day < 1 || day > daysInMonth(year, monthZero)) return false
  return true
}
