import type { GoogleDriveSchedule } from '../types'

const STOCKHOLM_TZ = 'Europe/Stockholm'

function isValidHour(hour: unknown): hour is number {
  return (
    typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23
  )
}

function stockholmDateString(now: Date): string {
  // sv-SE with a timeZone yields YYYY-MM-DD.
  return new Intl.DateTimeFormat('sv-SE', { timeZone: STOCKHOLM_TZ }).format(now)
}

function stockholmHourOf(date: Date): number {
  return Number(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: STOCKHOLM_TZ,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(date)
  )
}

/**
 * Absolute timestamp of today's HH:00 in Europe/Stockholm. Tries the two
 * offsets Sweden uses (CEST +02:00, CET +01:00) and keeps the one that lands
 * on the requested wall-clock hour, so DST transitions resolve correctly
 * without a timezone library.
 */
export function stockholmSlotForDay(now: Date, hour: number): Date {
  const dateStr = stockholmDateString(now)
  const hh = String(hour).padStart(2, '0')
  for (const offset of ['+02:00', '+01:00']) {
    const candidate = new Date(`${dateStr}T${hh}:00:00${offset}`)
    if (stockholmHourOf(candidate) === hour) return candidate
  }
  return new Date(`${dateStr}T${hh}:00:00+01:00`)
}

/** UTC hour that corresponds to a Stockholm wall-clock hour today. */
export function stockholmHourToUtcHour(hour: number, now: Date = new Date()): number {
  return stockholmSlotForDay(now, hour).getUTCHours()
}

/**
 * Today's scheduled slot as an absolute timestamp, or null when the schedule
 * carries no valid hour. `hour_local` (Europe/Stockholm wall-clock, stable
 * across DST) wins over the legacy `hour_utc`.
 */
function scheduleSlotForDay(schedule: GoogleDriveSchedule, now: Date): Date | null {
  if (isValidHour(schedule.hour_local)) {
    return stockholmSlotForDay(now, schedule.hour_local)
  }
  if (isValidHour(schedule.hour_utc)) {
    const slot = new Date(now)
    slot.setUTCHours(schedule.hour_utc, 0, 0, 0)
    return slot
  }
  return null
}

/**
 * A schedule is due when its daily slot for today has passed and no auto-sync
 * attempt has run since that slot. Hour equality is deliberately NOT
 * required: if the popular 03:00 batch overruns the cron's time budget, the
 * leftover companies stay due and get picked up by the next hourly run
 * instead of silently losing the whole day.
 */
export function isScheduleDue(
  schedule: GoogleDriveSchedule | null | undefined,
  now: Date
): boolean {
  if (!schedule?.enabled) return false
  const slot = scheduleSlotForDay(schedule, now)
  if (!slot) return false
  if (now.getTime() < slot.getTime()) return false

  if (!schedule.last_auto_sync_at) return true
  const lastAttempt = new Date(schedule.last_auto_sync_at).getTime()
  return Number.isFinite(lastAttempt) ? lastAttempt < slot.getTime() : true
}
