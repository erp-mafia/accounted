/**
 * Pure date helpers for recurring invoice schedules that are safe to import
 * from client components (no Supabase, PDF or email imports). The cron-side
 * service (recurring-schedule-service.ts) builds on the same primitives so
 * the dialog, the routes and the cron agree on what "the schedule's grid"
 * means: every run date has day = min(day_of_month, last day of that month),
 * and the month phase is fixed by the first run date.
 */

import { ISO_DATE_RE } from '@/lib/invariants'

/** Last day of the month (1-indexed result, 0-indexed month). */
export function lastDayOfMonth(year: number, monthIndex0: number): number {
  // Day 0 of next month = last day of this month.
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate()
}

export function isoFromParts(year: number, monthIndex0: number, day: number): string {
  const yyyy = year.toString().padStart(4, '0')
  const mm = (monthIndex0 + 1).toString().padStart(2, '0')
  const dd = day.toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** Calendar-validated parts of a yyyy-mm-dd string, or null. */
export function parseIsoDate(iso: string): { year: number; month0: number; day: number } | null {
  if (!ISO_DATE_RE.test(iso)) return null
  const year = Number(iso.slice(0, 4))
  const month0 = Number(iso.slice(5, 7)) - 1
  const day = Number(iso.slice(8, 10))
  if (month0 < 0 || month0 > 11 || day < 1 || day > lastDayOfMonth(year, month0)) return null
  return { year, month0, day }
}

/**
 * True when `iso` is a calendar-valid date whose day is exactly where the
 * schedule's day_of_month lands in that month (31 -> 28/29/30 in shorter
 * months). A run date off the grid would make the cron's "advance one
 * interval from the due date" step drift to day_of_month on the next run,
 * so both write paths refuse it instead of silently normalizing.
 */
export function runDateMatchesDayOfMonth(iso: string, dayOfMonth: number): boolean {
  const parsed = parseIsoDate(iso)
  if (!parsed) return false
  return parsed.day === Math.min(dayOfMonth, lastDayOfMonth(parsed.year, parsed.month0))
}

/**
 * Same year-month as `iso`, day moved onto the schedule grid for
 * day_of_month. Used by the dialog to keep the date field in step when the
 * user edits the day. Returns `iso` unchanged when it is not parseable.
 */
export function alignRunDateToDay(iso: string, dayOfMonth: number): string {
  const parsed = parseIsoDate(iso)
  if (!parsed) return iso
  return isoFromParts(
    parsed.year,
    parsed.month0,
    Math.min(dayOfMonth, lastDayOfMonth(parsed.year, parsed.month0)),
  )
}

/**
 * The first `count` run dates starting at `firstIso` and stepping
 * interval_months on the grid. Preview only (the cron computes each next
 * date from the actual due date); returns [] for an unparseable first date.
 */
export function projectRunDates(
  firstIso: string,
  dayOfMonth: number,
  intervalMonths: number,
  count: number,
): string[] {
  const parsed = parseIsoDate(firstIso)
  if (!parsed || count <= 0) return []
  const out: string[] = [firstIso]
  let { year, month0 } = parsed
  while (out.length < count) {
    const m = month0 + intervalMonths
    year += Math.floor(m / 12)
    month0 = m % 12
    out.push(isoFromParts(year, month0, Math.min(dayOfMonth, lastDayOfMonth(year, month0))))
  }
  return out
}

/**
 * Resolve the calendar date (yyyy-mm-dd) and hour (0-23) in Europe/Stockholm
 * for a given instant. The recurring cron runs in UTC on Vercel and the
 * dialog runs in whatever zone the browser is in, but users pick dates and a
 * send hour in Swedish local time, so every surface asks "what day and hour
 * is it in Sweden right now" through this one function. Uses Intl (DST-aware,
 * no extra dependency); en-CA + hourCycle 'h23' guarantees zero-padded
 * ISO-shaped parts and a 0-23 hour.
 */
export function getStockholmDateHour(instant: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
  }
}
