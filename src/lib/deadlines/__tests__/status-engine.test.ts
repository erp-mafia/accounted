import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { daysUntilDeadline } from '../status-engine'

/**
 * The day count is local-time by nature (a deadline falls on a date, not at an
 * instant), so these cases pin the zone instead of inheriting the machine's:
 * Europe/Stockholm is where the DST transitions that broke the arithmetic
 * happen, and CI runs in UTC, which has none, so a zone-less test would guard
 * nothing there. Every expectation below holds in both zones, which is exactly
 * the property the calendar-day count restores.
 */
const hostTz = process.env.TZ

function clockAt(instant: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(instant))
}

describe.each(['Europe/Stockholm', 'UTC'])('daysUntilDeadline in %s', (tz) => {
  beforeAll(() => {
    process.env.TZ = tz
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  afterAll(() => {
    if (hostTz === undefined) {
      delete process.env.TZ
    } else {
      process.env.TZ = hostTz
    }
  })

  it('counts 14 calendar days when the span crosses the autumn transition', () => {
    // Europe/Stockholm gains an hour on 2026-10-25, so dividing the two local
    // midnights by 24 hours made this span 14.0417 days and the rounding
    // reported 15, which dropped the deadline out of the action_needed window.
    clockAt('2026-10-18T09:00:00Z')

    expect(daysUntilDeadline('2026-11-01')).toBe(14)
  })

  it('counts 14 calendar days when the span crosses the spring transition', () => {
    // The hour lost on 2026-03-29 made the same span 13.9583 days, which the
    // old rounding happened to put back at 14. Pinned so the direction that
    // used to be right by accident stays right on purpose.
    clockAt('2026-03-22T09:00:00Z')

    expect(daysUntilDeadline('2026-04-05')).toBe(14)
  })

  it('reports a day-old deadline as overdue across the spring transition', () => {
    // The lost hour the other way round: -0.9583 days, reported as 0, so a
    // deadline that passed yesterday read as due today and the passed-due-date
    // check in lib/clients/aggregate.ts never flagged it overdue.
    clockAt('2026-03-30T09:00:00Z')

    expect(daysUntilDeadline('2026-03-29')).toBe(-1)
  })

  it('keeps the count of an ordinary span with no transition in it', () => {
    clockAt('2026-06-10T09:00:00Z')

    expect(daysUntilDeadline('2026-06-10')).toBe(0)
    expect(daysUntilDeadline('2026-06-24')).toBe(14)
    expect(daysUntilDeadline('2026-06-25')).toBe(15)
  })
})
