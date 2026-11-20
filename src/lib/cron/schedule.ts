/**
 * What a schedule promises: how often a five-field cron expression runs, and
 * so how long a job may be absent before it counts as missed.
 *
 * Not a cron parser. The watch job (./watch.ts) only needs the period, and
 * every expression in vercel.json is built from the same few shapes (a
 * number, a list, a range, a step, a star), which is what this counts. An
 * expression it cannot count returns null and a unit test fails for it
 * (__tests__/schedule.test.ts runs every scheduled job through it), so a new
 * shape is noticed when it is written, not when its job goes missing.
 */

import { SCHEDULED_JOBS, type ScheduledJob } from './scheduled-jobs.generated'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** How many values of 0..size-1 (or 1..size) one field matches; null when it is not a shape counted here. */
function matches(field: string, min: number, max: number): number | null {
  let total = 0
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return null
    let from: number
    let to: number
    if (range === '*') {
      from = min
      to = max
    } else if (/^\d+$/.test(range)) {
      from = Number(range)
      // "5/15" means from 5 to the end, every 15.
      to = stepText === undefined ? from : max
    } else {
      const bounds = /^(\d+)-(\d+)$/.exec(range)
      if (!bounds) return null
      from = Number(bounds[1])
      to = Number(bounds[2])
    }
    if (from < min || to > max || from > to) return null
    total += Math.floor((to - from) / step) + 1
  }
  return total > 0 ? total : null
}

/**
 * The average time between two runs of a schedule, in ms. Day-of-month and
 * day-of-week narrow the days it runs on (a month is counted as 31 days, so a
 * monthly job is never called missed a day early).
 */
export function schedulePeriodMs(schedule: string): number | null {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  if (month !== '*') return null
  const minutes = matches(minute, 0, 59)
  const hours = matches(hour, 0, 23)
  if (minutes === null || hours === null) return null
  const runsPerDay = minutes * hours
  if (dayOfMonth !== '*' && dayOfWeek !== '*') return null
  if (dayOfMonth !== '*') {
    const days = matches(dayOfMonth, 1, 31)
    return days === null ? null : (31 * DAY_MS) / (days * runsPerDay)
  }
  if (dayOfWeek !== '*') {
    const days = matches(dayOfWeek, 0, 7)
    return days === null ? null : (7 * DAY_MS) / (days * runsPerDay)
  }
  return DAY_MS / runsPerDay
}

/**
 * How long after its last run a job counts as missed: its period plus a
 * grace of one more period, at least 15 minutes (the platform delivers a
 * minute job late or skips one now and then) and at most 3 hours (a daily
 * job that did not run is known the same morning, not the next day).
 */
export function missedAfterMs(schedule: string): number | null {
  const period = schedulePeriodMs(schedule)
  if (period === null) return null
  return period + Math.min(Math.max(period, 15 * MINUTE_MS), 3 * HOUR_MS)
}

const BY_PATH = new Map(SCHEDULED_JOBS.map((job) => [job.path, job]))

/** The scheduled job behind a request path, when vercel.json schedules it. */
export function scheduledJobFor(path: string): ScheduledJob | null {
  return BY_PATH.get(path) ?? null
}

export { SCHEDULED_JOBS, type ScheduledJob }
