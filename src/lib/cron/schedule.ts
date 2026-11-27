/**
 * What a schedule promises: how often a five-field cron expression runs, and
 * so how long a job may be absent before it counts as missed.
 *
 * Not a cron parser. The watch job (./watch.ts) only needs the longest time
 * between two runs, and every expression in vercel.json is built from the
 * same few shapes (a number, a list, a range, a step, a star), which is what
 * this reads. An expression it cannot read returns null and a unit test fails
 * for it (__tests__/schedule.test.ts runs every scheduled job through it), so
 * a new shape is noticed when it is written, not when its job goes missing.
 */

import { SCHEDULED_JOBS, type ScheduledJob } from './scheduled-jobs.generated'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** The values of min..max one field matches; null when it is not a shape read here. */
function matches(field: string, min: number, max: number): number[] | null {
  const values: number[] = []
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
    for (let value = from; value <= to; value += step) values.push(value)
  }
  return values.length > 0 ? values : null
}

/**
 * The longest wait from one run to the next, for runs at these times of day
 * (ms after midnight) on these days of a cycle of cycleDays days: the last
 * run of a cycle is followed by the first run of the next.
 */
function longestGap(days: readonly number[], times: readonly number[], cycleDays: number): number {
  const runs = days.flatMap((day) => times.map((time) => day * DAY_MS + time)).sort((a, b) => a - b)
  let longest = runs[0] + cycleDays * DAY_MS - runs[runs.length - 1]
  for (let i = 1; i < runs.length; i++) longest = Math.max(longest, runs[i] - runs[i - 1])
  return longest
}

/**
 * The longest time between two runs of a schedule, in ms: its period when
 * the runs are evenly spaced, and the longest wait when they are not
 * (0 2,4 * * * waits 22 hours from 04:00 to 02:00, not its average 12).
 * Day-of-month and day-of-week narrow the days it runs on (a month is counted
 * as 31 days, so a monthly job is never called missed a day early).
 */
export function schedulePeriodMs(schedule: string): number | null {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  if (month !== '*') return null
  const minutes = matches(minute, 0, 59)
  const hours = matches(hour, 0, 23)
  if (minutes === null || hours === null) return null
  const times = hours.flatMap((h) => minutes.map((m) => h * HOUR_MS + m * MINUTE_MS))
  if (dayOfMonth !== '*' && dayOfWeek !== '*') return null
  if (dayOfMonth !== '*') {
    const days = matches(dayOfMonth, 1, 31)
    return days === null ? null : longestGap(days, times, 31)
  }
  if (dayOfWeek !== '*') {
    const days = matches(dayOfWeek, 0, 7)
    // 0 and 7 are both Sunday.
    return days === null ? null : longestGap(days.map((day) => day % 7), times, 7)
  }
  return longestGap([0], times, 1)
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
