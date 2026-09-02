/**
 * Pure UTC arithmetic on `YYYY-MM-DD` strings.
 *
 * Every helper here is deliberately UTC: accounting dates are calendar dates
 * with no wall-clock component, and doing the arithmetic at `T00:00:00Z`
 * means no DST edge can shift a day. None of these is a substitute for
 * `getSwedishLocalDate()` / `swedishToday()` (Europe/Stockholm), which differ
 * from `todayIsoUtc()` around midnight Swedish time.
 */

/** Add `days` to a `YYYY-MM-DD` string in pure UTC and return `YYYY-MM-DD`. */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`); negative when `to` is earlier. */
export function daysBetweenIso(from: string, to: string): number {
  const ms = new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime()
  return Math.round(ms / 86_400_000)
}

/** The UTC calendar date of `d` as `YYYY-MM-DD`. */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Today's UTC calendar date as `YYYY-MM-DD`. */
export function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10)
}
