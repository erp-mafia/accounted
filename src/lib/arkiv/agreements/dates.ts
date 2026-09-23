/** Calendar arithmetic on ISO dates (YYYY-MM-DD), in UTC so no local timezone shifts a day. */

const DAY_MS = 86_400_000

export function parseIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function toIso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function todayIso(now: Date = new Date()): string {
  return toIso(now)
}

export function addDays(iso: string, days: number): string {
  return toIso(new Date(parseIso(iso).getTime() + days * DAY_MS))
}

/** Same day of month `months` later, clamped to the last day of the target month (Jan 31 + 1 month = Feb 28). */
export function addMonths(iso: string, months: number): string {
  const start = parseIso(iso)
  const day = start.getUTCDate()
  const firstOfTarget = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1))
  const lastDay = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0)).getUTCDate()
  firstOfTarget.setUTCDate(Math.min(day, lastDay))
  return toIso(firstOfTarget)
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseIso(b).getTime() - parseIso(a).getTime()) / DAY_MS)
}

/** Dates `stepMonths` apart from `anchor` onwards, inside [from, to] and never after `end`, at most `limit`. */
export function monthlySeries(anchor: string, stepMonths: number, window: { from: string; to: string; end?: string | null }, limit = 120): string[] {
  const last = window.end && window.end < window.to ? window.end : window.to
  const dates: string[] = []
  for (let k = 0; k < limit; k++) {
    const date = addMonths(anchor, k * stepMonths)
    if (date > last) break
    if (date >= window.from) dates.push(date)
  }
  return dates
}
