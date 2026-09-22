import { describe, it, expect } from 'vitest'
import { nextRunPeriod } from '../next-run-period'

// Local-time constructor on purpose: the function reads the local getters.
const MID_SEPTEMBER = new Date(2026, 8, 21, 17, 5)

describe('nextRunPeriod', () => {
  it('is the month `now` falls in when the company has no runs', () => {
    expect(nextRunPeriod([], MID_SEPTEMBER)).toEqual({ period_year: 2026, period_month: 9 })
  })

  it('is the month after the latest run, whatever `now` is', () => {
    const runs = [{ period_year: 2026, period_month: 6, status: 'booked' }]
    expect(nextRunPeriod(runs, MID_SEPTEMBER)).toEqual({ period_year: 2026, period_month: 7 })
  })

  it('counts a run that is still a draft: this is the click that started October by accident', () => {
    const runs = [
      { period_year: 2026, period_month: 9, status: 'draft' },
      { period_year: 2026, period_month: 8, status: 'booked' },
    ]
    expect(nextRunPeriod(runs, MID_SEPTEMBER)).toEqual({ period_year: 2026, period_month: 10 })
  })

  it('rolls December into January of the next year', () => {
    const runs = [{ period_year: 2026, period_month: 12, status: 'paid' }]
    expect(nextRunPeriod(runs, MID_SEPTEMBER)).toEqual({ period_year: 2027, period_month: 1 })
  })

  it('does not depend on the order of the rows', () => {
    const runs = [
      { period_year: 2025, period_month: 12, status: 'booked' },
      { period_year: 2026, period_month: 2, status: 'booked' },
      { period_year: 2026, period_month: 1, status: 'booked' },
    ]
    expect(nextRunPeriod(runs, MID_SEPTEMBER)).toEqual({ period_year: 2026, period_month: 3 })
  })

  it('compares the year before the month', () => {
    const runs = [
      { period_year: 2025, period_month: 11, status: 'booked' },
      { period_year: 2026, period_month: 2, status: 'booked' },
    ]
    expect(nextRunPeriod(runs, MID_SEPTEMBER)).toEqual({ period_year: 2026, period_month: 3 })
  })

  it('skips a corrected run: its correction run carries the period', () => {
    const runs = [
      { period_year: 2026, period_month: 9, status: 'corrected' },
      { period_year: 2026, period_month: 8, status: 'booked' },
    ]
    expect(nextRunPeriod(runs, MID_SEPTEMBER)).toEqual({ period_year: 2026, period_month: 9 })
  })

  it('falls back to `now` when every run is corrected', () => {
    const runs = [{ period_year: 2026, period_month: 5, status: 'corrected' }]
    expect(nextRunPeriod(runs, MID_SEPTEMBER)).toEqual({ period_year: 2026, period_month: 9 })
  })

  it('treats a row without a status as live (the route selects the period columns only)', () => {
    expect(nextRunPeriod([{ period_year: 2026, period_month: 6 }], MID_SEPTEMBER)).toEqual({
      period_year: 2026,
      period_month: 7,
    })
  })

  it('reads untyped string values the way the route did with Number()', () => {
    expect(nextRunPeriod([{ period_year: '2026', period_month: '12' }], MID_SEPTEMBER)).toEqual({
      period_year: 2027,
      period_month: 1,
    })
  })

  it('ignores a row whose period is not a real month instead of building on it', () => {
    const runs = [
      { period_year: 2026, period_month: 13 },
      { period_year: 'x', period_month: 4 },
      { period_year: 2026, period_month: 3 },
    ]
    expect(nextRunPeriod(runs, MID_SEPTEMBER)).toEqual({ period_year: 2026, period_month: 4 })
  })

  it('uses the local month of `now` at a year boundary', () => {
    expect(nextRunPeriod([], new Date(2026, 11, 31, 23, 30))).toEqual({ period_year: 2026, period_month: 12 })
    expect(nextRunPeriod([], new Date(2027, 0, 1, 0, 30))).toEqual({ period_year: 2027, period_month: 1 })
  })
})
