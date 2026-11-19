import { describe, it, expect } from 'vitest'
import {
  backupIsStale,
  claimAbandonedAfterMs,
  failuresAfterFailedAttempt,
  isScheduleDue,
  lastTurnMs,
  leftOverRunsToReport,
  planScheduledRun,
  runClaimState,
  stockholmHourToUtcHour,
} from '../schedule'
import type { CloudSchedule } from '../../types'

function makeSchedule(overrides: Partial<CloudSchedule> = {}): CloudSchedule {
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

describe('runClaimState', () => {
  const HOSTED = false
  it('is free without a claim, held while its run can still be alive, abandoned after', () => {
    expect(runClaimState(makeSchedule(), NOW, HOSTED)).toBe('free')
    expect(runClaimState(makeSchedule({ sync_started_at: null }), NOW, HOSTED)).toBe('free')
    expect(runClaimState(makeSchedule({ sync_started_at: '2026-07-12T12:16:00.000Z' }), NOW, HOSTED)).toBe('held')
    // An hourly run's claim seen by the next one: no function lives that long.
    expect(runClaimState(makeSchedule({ sync_started_at: '2026-07-12T11:32:00.000Z' }), NOW, HOSTED)).toBe('abandoned')
  })

  it('gives a manual run the extension route\'s whole 800 s and a margin before calling it gone', () => {
    const startedSixteenMinutesAgo = '2026-07-12T12:14:00.000Z'
    expect(runClaimState(makeSchedule({ sync_started_at: startedSixteenMinutesAgo, sync_started_by: 'cron' }), NOW, HOSTED)).toBe('abandoned')
    expect(runClaimState(makeSchedule({ sync_started_at: startedSixteenMinutesAgo, sync_started_by: 'manual' }), NOW, HOSTED)).toBe('held')
    expect(claimAbandonedAfterMs('manual', HOSTED)).toBeGreaterThan(800_000)
  })

  it('self-hosted, where nothing ends a long run, holds any claim for hours', () => {
    const startedThreeHoursAgo = '2026-07-12T09:30:00.000Z'
    for (const by of ['cron', 'manual'] as const) {
      expect(runClaimState(makeSchedule({ sync_started_at: startedThreeHoursAgo, sync_started_by: by }), NOW, true)).toBe('held')
      expect(runClaimState(makeSchedule({ sync_started_at: startedThreeHoursAgo, sync_started_by: by }), NOW, HOSTED)).toBe('abandoned')
    }
    expect(runClaimState(makeSchedule({ sync_started_at: '2026-07-12T05:00:00.000Z', sync_started_by: 'cron' }), NOW, true)).toBe('abandoned')
  })
})

describe('planScheduledRun', () => {
  const plan = (schedule: CloudSchedule) => planScheduledRun(schedule, NOW, false)

  it('claims a free schedule for the cron without touching its failure count, and ends its wait', () => {
    expect(plan(makeSchedule({ consecutive_failures: 2, left_over_runs: 4 }))).toEqual({
      action: 'run',
      interrupted: false,
      claimed: makeSchedule({
        consecutive_failures: 2,
        sync_started_at: NOW.toISOString(),
        sync_started_by: 'cron',
        left_over_runs: 0,
      }),
    })
  })

  it('leaves a schedule another run holds', () => {
    expect(plan(makeSchedule({ sync_started_at: '2026-07-12T12:29:00.000Z' }))).toEqual({ action: 'busy' })
  })

  it('counts an abandoned cron claim as this night\'s failure and retries, still due', () => {
    expect(
      plan(makeSchedule({
        last_auto_sync_at: '2026-07-11T03:02:00.000Z',
        sync_started_at: '2026-07-12T11:02:00.000Z',
        sync_started_by: 'cron',
      }))
    ).toMatchObject({
      action: 'run',
      interrupted: true,
      claimed: {
        sync_started_at: NOW.toISOString(),
        sync_started_by: 'cron',
        interrupted_at: NOW.toISOString(),
        consecutive_failures: 1,
        // No attempt recorded: the retry is what decides the night.
        last_auto_sync_at: '2026-07-11T03:02:00.000Z',
      },
    })
  })

  it('takes over a claim a manual run left without counting anything: no nightly backup died', () => {
    const result = plan(makeSchedule({
      consecutive_failures: 1,
      sync_started_at: '2026-07-12T11:02:00.000Z',
      sync_started_by: 'manual',
    }))
    expect(result).toMatchObject({
      action: 'run',
      interrupted: false,
      tookOver: 'manual',
      claimed: { sync_started_by: 'cron', sync_started_at: NOW.toISOString(), consecutive_failures: 1 },
    })
    expect((result as { claimed: CloudSchedule }).claimed).not.toHaveProperty('interrupted_at')
  })

  it('gives the night up when the retry was killed too: not due again before tomorrow', () => {
    const result = plan(makeSchedule({
      consecutive_failures: 1,
      interrupted_at: '2026-07-12T11:00:30.000Z',
      sync_started_at: '2026-07-12T11:00:30.000Z',
      sync_started_by: 'cron',
    }))
    expect(result.action).toBe('give_up')
    const failed = (result as { failed: CloudSchedule }).failed
    expect(failed).toMatchObject({
      sync_started_at: null,
      sync_started_by: null,
      last_auto_sync_at: NOW.toISOString(),
      last_auto_sync_status: 'error',
      consecutive_failures: 1,
    })
    expect(isScheduleDue(failed, new Date(NOW.getTime() + 3_600_000))).toBe(false)
  })

  it('allows the retry again the next night', () => {
    expect(
      plan(makeSchedule({
        consecutive_failures: 1,
        // Yesterday's kill; today's 03:00 slot came after it.
        interrupted_at: '2026-07-11T04:00:30.000Z',
        sync_started_at: '2026-07-12T11:00:30.000Z',
      }))
    ).toMatchObject({ action: 'run', interrupted: true, claimed: { consecutive_failures: 2 } })
  })
})

describe('failuresAfterFailedAttempt', () => {
  it('adds one, except for a night whose killed run is already counted', () => {
    expect(failuresAfterFailedAttempt(makeSchedule({ consecutive_failures: 2 }), NOW)).toBe(3)
    expect(
      failuresAfterFailedAttempt(
        makeSchedule({ consecutive_failures: 2, interrupted_at: '2026-07-12T11:00:30.000Z' }),
        NOW
      )
    ).toBe(2)
  })
})

describe('lastTurnMs', () => {
  it('is the later of the last attempt and the last deferral, 0 when neither', () => {
    expect(lastTurnMs(makeSchedule())).toBe(0)
    expect(
      lastTurnMs(makeSchedule({ last_auto_sync_at: '2026-07-11T03:02:00.000Z', deferred_at: '2026-07-12T11:02:00.000Z' }))
    ).toBe(Date.parse('2026-07-12T11:02:00.000Z'))
  })
})

describe('leftOverRunsToReport', () => {
  it('reports the third due run in a row without a turn, and each full day after, and nothing in between', () => {
    expect([1, 2, 3, 4, 5, 23, 24, 25, 47, 48].map(leftOverRunsToReport)).toEqual([
      null, null, 'three_runs', null, null, null, 'a_day', null, null, 'a_day',
    ])
    expect(leftOverRunsToReport(0)).toBeNull()
  })
})

describe('backupIsStale', () => {
  const on = makeSchedule()
  it('is true when automatic backup is on and nothing was saved for two days', () => {
    expect(backupIsStale({ schedule: on, lastSavedAt: '2026-07-10T12:00:00.000Z', connectedAt: null, now: NOW })).toBe(true)
    expect(backupIsStale({ schedule: on, lastSavedAt: '2026-07-11T03:05:00.000Z', connectedAt: null, now: NOW })).toBe(false)
  })

  it('is false with automatic backup off: a manual backup has no promised age', () => {
    expect(
      backupIsStale({ schedule: makeSchedule({ enabled: false }), lastSavedAt: '2026-06-01T12:00:00.000Z', connectedAt: null, now: NOW })
    ).toBe(false)
    expect(backupIsStale({ schedule: null, lastSavedAt: '2026-06-01T12:00:00.000Z', connectedAt: null, now: NOW })).toBe(false)
  })

  it('does not warn right after automatic backup is switched on over an old manual backup', () => {
    const lastSavedAt = '2026-07-01T12:00:00.000Z'
    expect(
      backupIsStale({ schedule: makeSchedule({ enabled_at: '2026-07-12T09:00:00.000Z' }), lastSavedAt, connectedAt: null, now: NOW })
    ).toBe(false)
    // Two days on with nothing saved is a backup that does not run.
    expect(
      backupIsStale({ schedule: makeSchedule({ enabled_at: '2026-07-10T09:00:00.000Z' }), lastSavedAt, connectedAt: null, now: NOW })
    ).toBe(true)
  })

  it('before the first backup, counts from the day the destination was connected', () => {
    expect(backupIsStale({ schedule: on, lastSavedAt: null, connectedAt: '2026-07-12T09:00:00.000Z', now: NOW })).toBe(false)
    expect(backupIsStale({ schedule: on, lastSavedAt: null, connectedAt: '2026-07-09T09:00:00.000Z', now: NOW })).toBe(true)
  })
})
