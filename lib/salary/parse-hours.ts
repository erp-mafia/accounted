/**
 * Parse a worked-hours input that is either a plain number or a clock-time
 * range, returning hours as a decimal rounded to 2 dp (or null when it can't
 * be parsed).
 *
 * Accepted forms:
 *   - Plain number: "8", "6.5", "6,5" (Swedish decimal comma)
 *   - Time range:   "1740-2240", "17:40-22:40", "9-17", "0800–1630" (en dash)
 *
 * Overnight ranges wrap: when the end is at or before the start it is treated
 * as the next day, so "1740-0030" reads 00:30 as 24:30 → 6.83 h. The result is
 * always < 24 h, matching the DB cap on salary_worked_days.hours.
 */
export function parseHoursInput(raw: string): number | null {
  if (raw == null) return null
  const s = String(raw).trim().replace(',', '.')
  if (!s) return null

  // A separator that isn't the leading char signals range intent ("1740-2240").
  // A leading "-" is a negative number, not a range. Once we treat it as a
  // range we never fall back to a plain number — a half-typed "1740-" is null,
  // not 1740.
  const sepIndex = s.search(/[-–—]/)
  if (sepIndex > 0) {
    const parts = s.split(/\s*[-–—]\s*/)
    if (parts.length !== 2) return null
    const start = parseClockToken(parts[0])
    let end = parseClockToken(parts[1])
    if (start == null || end == null) return null
    if (end < start) end += 24 * 60 // overnight wrap
    const minutes = end - start
    if (minutes <= 0) return null
    return Math.round((minutes / 60) * 100) / 100
  }

  const n = parseFloat(s)
  if (!isFinite(n)) return null
  return Math.round(n * 100) / 100
}

/** Parse a clock time to minutes-since-midnight. Returns null if invalid. */
function parseClockToken(token: string): number | null {
  const t = token.trim()
  let h: number
  let m: number

  if (t.includes(':')) {
    const [hh, mm = '0'] = t.split(':')
    h = parseInt(hh, 10)
    m = parseInt(mm, 10)
  } else if (/^\d{3,4}$/.test(t)) {
    // "930" → 09:30, "1740" → 17:40
    const padded = t.padStart(4, '0')
    h = parseInt(padded.slice(0, 2), 10)
    m = parseInt(padded.slice(2), 10)
  } else if (/^\d{1,2}$/.test(t)) {
    h = parseInt(t, 10)
    m = 0
  } else {
    return null
  }

  if (!isFinite(h) || !isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null
  return h * 60 + m
}
