import { describe, expect, it } from 'vitest'
import { addDaysIso } from '@/lib/dates/iso'
import { autoLockFloor, autoLockTarget } from '../auto-lock'

/**
 * The definition spelled out the slow way: walk back from today to the first
 * day that is a month end and lies at least `days` days back.
 */
function floorByWalking(today: string, days: number): string {
  let day = addDaysIso(today, -days)
  while (addDaysIso(day, 1).slice(8) !== '01') day = addDaysIso(day, -1)
  return day
}

describe('autoLockFloor', () => {
  it('is the newest month end the chosen number of days back (30, 60, 90 on 2026-11-17)', () => {
    expect(autoLockFloor('2026-11-17', 30)).toBe('2026-09-30')
    expect(autoLockFloor('2026-11-17', 60)).toBe('2026-08-31')
    expect(autoLockFloor('2026-11-17', 90)).toBe('2026-07-31')
  })

  it('locks a month on the day the days have passed, not the day after', () => {
    // September ends 2026-09-30; 30 days later is 2026-10-30.
    expect(autoLockFloor('2026-10-29', 30)).toBe('2026-08-31')
    expect(autoLockFloor('2026-10-30', 30)).toBe('2026-09-30')
    expect(autoLockFloor('2026-10-31', 30)).toBe('2026-09-30')
  })

  it('ends February on the 29th in a leap year and on the 28th otherwise', () => {
    expect(autoLockFloor('2028-03-29', 30)).toBe('2028-01-31')
    expect(autoLockFloor('2028-03-30', 30)).toBe('2028-02-29')
    expect(autoLockFloor('2027-03-29', 30)).toBe('2027-01-31')
    expect(autoLockFloor('2027-03-30', 30)).toBe('2027-02-28')
  })

  it('crosses a year boundary', () => {
    expect(autoLockFloor('2027-01-29', 30)).toBe('2026-11-30')
    expect(autoLockFloor('2027-01-30', 30)).toBe('2026-12-31')
    expect(autoLockFloor('2027-03-30', 90)).toBe('2026-11-30')
    expect(autoLockFloor('2027-03-31', 90)).toBe('2026-12-31')
    expect(autoLockFloor('2027-01-01', 1)).toBe('2026-12-31')
  })

  it('agrees with the definition walked day by day, for every day of a normal year and a leap year', () => {
    for (const days of [1, 30, 31, 45, 60, 90, 365]) {
      for (let today = '2027-01-01'; today < '2029-01-01'; today = addDaysIso(today, 1)) {
        expect(autoLockFloor(today, days), `${today}, ${days} days`).toBe(floorByWalking(today, days))
      }
    }
  })
})

describe('autoLockTarget', () => {
  const today = '2026-11-17'
  const target = (days: number | null, lockedThrough: string | null) =>
    autoLockTarget({ auto_lock_period_days: days, bookkeeping_locked_through: lockedThrough }, today)

  it('sets a first lock date at the floor', () => {
    expect(target(30, null)).toBe('2026-09-30')
    expect(target(90, null)).toBe('2026-07-31')
  })

  it('moves an earlier lock date up to the floor, also one somebody moved back the day before', () => {
    expect(target(30, '2025-12-31')).toBe('2026-09-30')
    expect(target(30, '2026-09-19')).toBe('2026-09-30')
    expect(target(30, '2026-09-29')).toBe('2026-09-30')
    expect(target(90, '2024-12-31')).toBe('2026-07-31')
  })

  it('leaves a lock date at or past the floor alone: it never moves back', () => {
    expect(target(30, '2026-09-30')).toBeNull()
    expect(target(30, '2026-10-31')).toBeNull()
    expect(target(60, '2026-10-31')).toBeNull()
  })

  it('does nothing while the setting is off or holds no whole number of days', () => {
    expect(target(null, null)).toBeNull()
    expect(target(0, null)).toBeNull()
    expect(target(-30, null)).toBeNull()
    expect(target(30.5, null)).toBeNull()
  })

  it('has nothing to lock more than a century back, up to the largest number the column holds', () => {
    expect(target(36_500, null)).toBe('1926-11-30')
    expect(target(36_501, null)).toBeNull()
    expect(target(2_147_483_647, null)).toBeNull()
  })
})
