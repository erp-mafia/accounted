import { describe, expect, it } from 'vitest'
import { missedAfterMs, schedulePeriodMs, scheduledJobFor, SCHEDULED_JOBS } from '../schedule'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('schedulePeriodMs', () => {
  it.each([
    ['* * * * *', MINUTE],
    ['*/2 * * * *', 2 * MINUTE],
    ['*/15 * * * *', 15 * MINUTE],
    ['2-59/5 * * * *', 5 * MINUTE],
    ['3-59/10 * * * *', 10 * MINUTE],
    ['5,20,35,50 * * * *', 15 * MINUTE],
    ['25 * * * *', HOUR],
    ['30 */2 * * *', 2 * HOUR],
    ['0 6 * * *', DAY],
    ['15 4 * * 1', 7 * DAY],
    ['0 6 1 * *', 31 * DAY],
  ])('%s runs every %d ms', (schedule, period) => {
    expect(schedulePeriodMs(schedule)).toBe(period)
  })

  it('answers null for a shape it does not count, so nothing is called missed on a guess', () => {
    for (const schedule of ['0 6 * 1 *', '0 6 1 * 1', '@daily', '0 6 * *', 'a * * * *', '70 * * * *', '*/0 * * * *']) {
      expect(schedulePeriodMs(schedule), schedule).toBeNull()
    }
  })

  it('counts every schedule in vercel.json', () => {
    for (const job of SCHEDULED_JOBS) {
      expect(schedulePeriodMs(job.schedule), `${job.path} (${job.schedule})`).toBeGreaterThan(0)
    }
  })
})

describe('missedAfterMs', () => {
  it('gives a minute job a quarter of an hour, an hourly job one more hour, and a daily job three', () => {
    expect(missedAfterMs('* * * * *')).toBe(16 * MINUTE)
    expect(missedAfterMs('*/10 * * * *')).toBe(25 * MINUTE)
    expect(missedAfterMs('0 * * * *')).toBe(2 * HOUR)
    expect(missedAfterMs('0 6 * * *')).toBe(DAY + 3 * HOUR)
    expect(missedAfterMs('0 6 1 * *')).toBe(31 * DAY + 3 * HOUR)
  })
})

describe('the scheduled jobs', () => {
  it('are found by their path, with the limit the route declares', () => {
    expect(scheduledJobFor('/api/payments/orders/status/cron')).toEqual({
      path: '/api/payments/orders/status/cron',
      schedule: '*/15 * * * *',
      maxDurationSeconds: 300,
    })
    expect(scheduledJobFor('/api/connector/sync/cron')).toBeNull()
  })

  it('include the watch job itself, and no limit above the one the watch assumes for a row without one', () => {
    expect(scheduledJobFor('/api/health/cron-runs/cron')).not.toBeNull()
    for (const job of SCHEDULED_JOBS) expect(job.maxDurationSeconds, job.path).toBeLessThanOrEqual(15 * 60)
  })
})
