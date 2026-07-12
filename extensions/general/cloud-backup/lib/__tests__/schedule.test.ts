import { describe, it, expect } from 'vitest'
import { isScheduleDue, stockholmHourToUtcHour } from '../schedule'
import type { GoogleDriveSchedule } from '../../types'

function makeSchedule(overrides: Partial<GoogleDriveSchedule> = {}): GoogleDriveSchedule {
  return {
    enabled: true,
    hour_utc: 3,
    last_auto_sync_at: null,
    last_auto_sync_status: null,
    last_auto_sync_error: null,
    ...overrides,
  }
}

// Fixed reference: 2026-07-12 12:30 UTC.
const NOW = new Date('2026-07-12T12:30:00.000Z')

describe('isScheduleDue', () => {
  it('is false when the schedule is missing or disabled', () => {
    expect(isScheduleDue(null, NOW)).toBe(false)
    expect(isScheduleDue(undefined, NOW)).toBe(false)
    expect(isScheduleDue(makeSchedule({ enabled: false }), NOW)).toBe(false)
  })

  it('is false when hour_utc is invalid', () => {
    expect(isScheduleDue(makeSchedule({ hour_utc: -1 }), NOW)).toBe(false)
    expect(isScheduleDue(makeSchedule({ hour_utc: 24 }), NOW)).toBe(false)
    expect(isScheduleDue(makeSchedule({ hour_utc: 3.5 }), NOW)).toBe(false)
    expect(
      isScheduleDue(makeSchedule({ hour_utc: 'x' as unknown as number }), NOW)
    ).toBe(false)
  })

  it('is false before the daily slot has passed', () => {
    expect(isScheduleDue(makeSchedule({ hour_utc: 13 }), NOW)).toBe(false)
    expect(isScheduleDue(makeSchedule({ hour_utc: 23 }), NOW)).toBe(false)
  })

  it('is true at or after the slot when never synced', () => {
    expect(isScheduleDue(makeSchedule({ hour_utc: 12 }), NOW)).toBe(true)
    // Catch-up: a 03:00 company missed by an overrun batch is still due at 12:30.
    expect(isScheduleDue(makeSchedule({ hour_utc: 3 }), NOW)).toBe(true)
    expect(isScheduleDue(makeSchedule({ hour_utc: 0 }), NOW)).toBe(true)
  })

  it('is false when an attempt already ran since today\'s slot', () => {
    expect(
      isScheduleDue(
        makeSchedule({ hour_utc: 3, last_auto_sync_at: '2026-07-12T03:05:00.000Z' }),
        NOW
      )
    ).toBe(false)
    expect(
      isScheduleDue(
        makeSchedule({ hour_utc: 12, last_auto_sync_at: '2026-07-12T12:10:00.000Z' }),
        NOW
      )
    ).toBe(false)
  })

  it('is true when the last attempt predates today\'s slot', () => {
    // Yesterday's run.
    expect(
      isScheduleDue(
        makeSchedule({ hour_utc: 3, last_auto_sync_at: '2026-07-11T03:05:00.000Z' }),
        NOW
      )
    ).toBe(true)
    // A late catch-up yesterday evening does not swallow today's slot.
    expect(
      isScheduleDue(
        makeSchedule({ hour_utc: 3, last_auto_sync_at: '2026-07-11T23:00:00.000Z' }),
        NOW
      )
    ).toBe(true)
  })

  it('treats an unparsable last_auto_sync_at as never synced', () => {
    expect(
      isScheduleDue(
        makeSchedule({ hour_utc: 3, last_auto_sync_at: 'not-a-date' }),
        NOW
      )
    ).toBe(true)
  })
})

describe('isScheduleDue with hour_local (Europe/Stockholm, DST-stable)', () => {
  it('computes the slot in Stockholm time during CEST (UTC+2)', () => {
    // 05:00 Swedish summer time = 03:00 UTC.
    const schedule = makeSchedule({ hour_local: 5 })
    expect(isScheduleDue(schedule, new Date('2026-07-12T02:59:00.000Z'))).toBe(false)
    expect(isScheduleDue(schedule, new Date('2026-07-12T03:01:00.000Z'))).toBe(true)
  })

  it('computes the slot in Stockholm time during CET (UTC+1)', () => {
    // 05:00 Swedish winter time = 04:00 UTC: same wall-clock, shifted UTC.
    const schedule = makeSchedule({ hour_local: 5 })
    expect(isScheduleDue(schedule, new Date('2026-01-12T03:30:00.000Z'))).toBe(false)
    expect(isScheduleDue(schedule, new Date('2026-01-12T04:01:00.000Z'))).toBe(true)
  })

  it('hour_local wins over the legacy hour_utc', () => {
    // hour_utc says 23 (not yet due), hour_local says 5 (due at 12:30 UTC).
    const schedule = makeSchedule({ hour_utc: 23, hour_local: 5 })
    expect(isScheduleDue(schedule, NOW)).toBe(true)
  })

  it('already-ran-today respects the Stockholm slot', () => {
    const ranToday = makeSchedule({
      hour_local: 5,
      last_auto_sync_at: '2026-07-12T03:05:00.000Z',
    })
    expect(isScheduleDue(ranToday, new Date('2026-07-12T12:00:00.000Z'))).toBe(false)

    const ranYesterday = makeSchedule({
      hour_local: 5,
      last_auto_sync_at: '2026-07-11T03:05:00.000Z',
    })
    expect(isScheduleDue(ranYesterday, new Date('2026-07-12T12:00:00.000Z'))).toBe(true)
  })
})

describe('stockholmHourToUtcHour', () => {
  it('maps 05:00 Stockholm to 03 UTC in summer and 04 UTC in winter', () => {
    expect(stockholmHourToUtcHour(5, new Date('2026-07-12T12:00:00.000Z'))).toBe(3)
    expect(stockholmHourToUtcHour(5, new Date('2026-01-12T12:00:00.000Z'))).toBe(4)
  })

  it('handles midnight without h24 artifacts', () => {
    expect(stockholmHourToUtcHour(0, new Date('2026-07-12T12:00:00.000Z'))).toBe(22)
    expect(stockholmHourToUtcHour(0, new Date('2026-01-12T12:00:00.000Z'))).toBe(23)
  })
})
