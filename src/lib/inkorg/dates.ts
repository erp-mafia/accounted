/**
 * The one way the Inkorg writes a date a person reads: short, "3 okt.", with
 * the year only when it is not this year ("3 okt. 2025"); in English "Oct 3"
 * and "Oct 3, 2025". A moment (an arrival) adds its time, "3 okt. 14:31".
 * Data in the field panel keeps its own form (yyyy-MM-dd).
 *
 * A calendar date (yyyy-MM-dd: a bank row, a due date) is that day wherever
 * the browser is; a moment is read in Stockholm, where the company keeps its
 * books. Pure: `now` decides what "this year" is.
 */
const TIME_ZONE = 'Europe/Stockholm'
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

function intlLocale(locale: string): string {
  return locale === 'en' ? 'en-US' : 'sv-SE'
}

/** The instant to print and the zone to print it in, or null for something that is not a date. */
function parse(value: string): { at: Date; timeZone: string; dateOnly: boolean } | null {
  const day = DATE_ONLY.exec(value)
  if (day) {
    const at = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])))
    return Number.isNaN(at.getTime()) ? null : { at, timeZone: 'UTC', dateOnly: true }
  }
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : { at, timeZone: TIME_ZONE, dateOnly: false }
}

function yearIn(at: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone }).format(at))
}

/** "3 okt." (this year), "3 okt. 2025" (another); "Oct 3", "Oct 3, 2025" in English. */
export function shortDate(value: string, locale: string, now: Date = new Date()): string {
  const parsed = parse(value)
  if (!parsed) return value
  const otherYear = yearIn(parsed.at, parsed.timeZone) !== yearIn(now, TIME_ZONE)
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    ...(otherYear ? { year: 'numeric' as const } : {}),
    timeZone: parsed.timeZone,
  }).format(parsed.at)
}

/** "3 okt. 14:31": a moment, with its time in Stockholm. A bare calendar date has no time and prints as shortDate. */
export function shortDateTime(value: string, locale: string, now: Date = new Date()): string {
  const parsed = parse(value)
  if (!parsed) return value
  const date = shortDate(value, locale, now)
  if (parsed.dateOnly) return date
  const time = new Intl.DateTimeFormat(intlLocale(locale), { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE }).format(parsed.at)
  return `${date} ${time}`
}
