import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'

/**
 * When a point-of-sale business day can be read.
 *
 * A restaurant's business day runs past midnight, so day D is read the next
 * morning, from READY_HOUR Swedish time on D + 1, when the venue has closed
 * and the provider has finished its report. Before that hour the latest
 * closed day is D - 2.
 */
export const READY_HOUR = 6

/** Minutes past READY_HOUR the morning run aims for, off the round hour every cron uses. */
const READY_MINUTE = 15

function stockholmHour(now: Date): number {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', hour12: false }).format(now)
  return Number(hour) % 24
}

/** The latest business day that is closed at `now`. */
export function latestClosedBusinessDay(now: Date = new Date()): string {
  const today = todayIsoStockholm(now)
  return addDaysIso(today, stockholmHour(now) >= READY_HOUR ? -1 : -2)
}

/** The UTC instant of HH:MM Swedish time on a Swedish calendar date. */
function stockholmInstant(date: string, hour: number, minute: number): Date {
  // Try both offsets Sweden uses and keep the one that reads back right.
  for (const offset of ['+02:00', '+01:00']) {
    const candidate = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offset}`)
    if (todayIsoStockholm(candidate) === date && stockholmHour(candidate) === hour) return candidate
  }
  return new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+01:00`)
}

/** The next morning run after `now`: READY_HOUR:READY_MINUTE Swedish time, today or tomorrow. */
export function nextMorningRun(now: Date = new Date()): Date {
  const today = todayIsoStockholm(now)
  const todayRun = stockholmInstant(today, READY_HOUR, READY_MINUTE)
  return todayRun > now ? todayRun : stockholmInstant(addDaysIso(today, 1), READY_HOUR, READY_MINUTE)
}

/** Every date from `from` to `to`, both included, ascending; empty when `from` is after `to`. */
export function datesBetween(from: string, to: string, limit = 366): string[] {
  const out: string[] = []
  for (let d = from; d <= to && out.length < limit; d = addDaysIso(d, 1)) out.push(d)
  return out
}
