/**
 * ISO 8601 weeks on `YYYY-MM-DD` strings, in pure UTC like lib/dates/iso.ts:
 * accounting dates have no wall-clock part, so no DST edge can move a day.
 */
import { addDaysIso } from '@/lib/dates/iso'

/** 1 = Monday ... 7 = Sunday. */
export function isoWeekday(iso: string): number {
  const day = new Date(iso + 'T00:00:00Z').getUTCDay()
  return day === 0 ? 7 : day
}

/** The Monday of the ISO week `iso` falls in. */
export function startOfIsoWeek(iso: string): string {
  return addDaysIso(iso, 1 - isoWeekday(iso))
}

/** The ISO week label, e.g. 2026-W44: the week belongs to the year its Thursday falls in. */
export function isoWeekLabel(iso: string): string {
  const thursday = addDaysIso(iso, 4 - isoWeekday(iso))
  const year = Number(thursday.slice(0, 4))
  const jan1 = Date.UTC(year, 0, 1)
  const ordinal = Math.round((new Date(thursday + 'T00:00:00Z').getTime() - jan1) / 86_400_000)
  const week = Math.floor(ordinal / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** The last day of a forecast of `weeks` ISO weeks, the current week counted first. */
export function forecastEnd(today: string, weeks: number): string {
  return addDaysIso(startOfIsoWeek(today), 7 * weeks - 1)
}

/** `YYYY-MM` of a date. */
export function monthOf(iso: string): string {
  return iso.slice(0, 7)
}

/** The day `day` (clamped to the month's length) of month `YYYY-MM`. */
export function dayInMonth(month: string, day: number): string {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`
}

/** `YYYY-MM` shifted by `delta` months. */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const index = y * 12 + (m - 1) + delta
  const year = Math.floor(index / 12)
  return `${year}-${String(index - year * 12 + 1).padStart(2, '0')}`
}

/** Every `YYYY-MM` from `from` through `to`, inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m)
  return out
}
