import { describe, it, expect } from 'vitest'
import {
  defaultRunPaymentDate,
  formatRunPeriod,
  nextRunPeriod,
  runPeriodChoices,
  type RunPeriodSource,
} from '../next-run-period'

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

  it('reads the Swedish month of `now` at a year boundary, whatever zone the process is in', () => {
    expect(nextRunPeriod([], new Date('2026-12-31T22:30:00Z'))).toEqual({ period_year: 2026, period_month: 12 })
    expect(nextRunPeriod([], new Date('2026-12-31T23:30:00Z'))).toEqual({ period_year: 2027, period_month: 1 })
  })
})

describe('formatRunPeriod', () => {
  it('is YYYY-MM with a padded month, as the Löner table shows it', () => {
    expect(formatRunPeriod({ period_year: 2026, period_month: 9 })).toBe('2026-09')
    expect(formatRunPeriod({ period_year: 2026, period_month: 12 })).toBe('2026-12')
  })
})

describe('defaultRunPaymentDate', () => {
  it('is the company pay day in the run month', () => {
    expect(defaultRunPaymentDate({ period_year: 2026, period_month: 11 }, 25)).toBe('2026-11-25')
  })

  it('pads a single-digit pay day', () => {
    expect(defaultRunPaymentDate({ period_year: 2026, period_month: 11 }, 5)).toBe('2026-11-05')
  })

  it('falls back to the 25th when the company has no settings row', () => {
    expect(defaultRunPaymentDate({ period_year: 2026, period_month: 11 }, null)).toBe('2026-11-25')
    expect(defaultRunPaymentDate({ period_year: 2026, period_month: 11 }, undefined)).toBe('2026-11-25')
  })

  it('stays inside a short month: the pay day is at most 28', () => {
    expect(defaultRunPaymentDate({ period_year: 2027, period_month: 2 }, 28)).toBe('2027-02-28')
  })
})

describe('runPeriodChoices', () => {
  // crm#1001: a company's first run, started early in a month for a month
  // that was already paid out.
  const EARLY_OCTOBER = new Date(2026, 9, 5, 10, 0)

  const months = (runs: readonly RunPeriodSource[], now: Date) =>
    runPeriodChoices(runs, now).map((c) => formatRunPeriod(c))

  it('offers this month as the default and the three months before it when there is no run', () => {
    expect(runPeriodChoices([], EARLY_OCTOBER)).toEqual([
      { period_year: 2026, period_month: 10, isDefault: true, hasRun: false },
      { period_year: 2026, period_month: 9, isDefault: false, hasRun: false },
      { period_year: 2026, period_month: 8, isDefault: false, hasRun: false },
      { period_year: 2026, period_month: 7, isDefault: false, hasRun: false },
    ])
  })

  it('keeps the default exactly the month nextRunPeriod picks', () => {
    const cases: RunPeriodSource[][] = [
      [],
      [{ period_year: 2026, period_month: 9, status: 'booked' }],
      [{ period_year: 2026, period_month: 10, status: 'draft' }],
      [{ period_year: 2026, period_month: 3, status: 'booked' }],
      [{ period_year: 2026, period_month: 12, status: 'paid' }],
    ]
    for (const runs of cases) {
      const defaults = runPeriodChoices(runs, EARLY_OCTOBER).filter((c) => c.isDefault)
      expect(defaults).toHaveLength(1)
      expect({ period_year: defaults[0].period_year, period_month: defaults[0].period_month }).toEqual(
        nextRunPeriod(runs, EARLY_OCTOBER),
      )
    }
  })

  it('marks the months that already have a live run, so the menu can refuse them', () => {
    const runs = [
      { period_year: 2026, period_month: 9, status: 'booked' },
      { period_year: 2026, period_month: 8, status: 'booked' },
    ]
    expect(runPeriodChoices(runs, EARLY_OCTOBER)).toEqual([
      { period_year: 2026, period_month: 10, isDefault: true, hasRun: false },
      { period_year: 2026, period_month: 9, isDefault: false, hasRun: true },
      { period_year: 2026, period_month: 8, isDefault: false, hasRun: true },
      { period_year: 2026, period_month: 7, isDefault: false, hasRun: false },
    ])
  })

  it('offers a skipped month between two runs', () => {
    const runs = [
      { period_year: 2026, period_month: 9, status: 'booked' },
      { period_year: 2026, period_month: 7, status: 'booked' },
    ]
    const august = runPeriodChoices(runs, EARLY_OCTOBER).find((c) => c.period_month === 8)
    expect(august).toEqual({ period_year: 2026, period_month: 8, isDefault: false, hasRun: false })
  })

  it('frees a month whose only run is corrected, as the route does', () => {
    const runs = [
      { period_year: 2026, period_month: 9, status: 'corrected' },
      { period_year: 2026, period_month: 8, status: 'corrected' },
      { period_year: 2026, period_month: 8, status: 'booked' },
    ]
    const choices = runPeriodChoices(runs, EARLY_OCTOBER)
    expect(choices.find((c) => c.period_month === 9)?.hasRun).toBe(false)
    expect(choices.find((c) => c.period_month === 8)?.hasRun).toBe(true)
  })

  it('counts back from the default when the default is ahead of today', () => {
    const runs = [{ period_year: 2026, period_month: 10, status: 'draft' }]
    expect(months(runs, EARLY_OCTOBER)).toEqual(['2026-11', '2026-10', '2026-09', '2026-08'])
    expect(runPeriodChoices(runs, EARLY_OCTOBER)[0].isDefault).toBe(true)
  })

  it('still offers this month when the last run is long ago, and keeps that old default last', () => {
    const runs = [{ period_year: 2026, period_month: 3, status: 'booked' }]
    const choices = runPeriodChoices(runs, EARLY_OCTOBER)
    expect(choices.map((c) => formatRunPeriod(c))).toEqual(['2026-10', '2026-09', '2026-08', '2026-07', '2026-04'])
    expect(choices.filter((c) => c.isDefault).map((c) => formatRunPeriod(c))).toEqual(['2026-04'])
  })

  it('steps back across a year boundary', () => {
    expect(months([], new Date(2027, 0, 10, 9, 0))).toEqual(['2027-01', '2026-12', '2026-11', '2026-10'])
  })

  it('ignores rows that are not a real month', () => {
    const runs = [
      { period_year: 2026, period_month: 13 },
      { period_year: 'x', period_month: 9 },
    ]
    expect(runPeriodChoices(runs, EARLY_OCTOBER).every((c) => !c.hasRun)).toBe(true)
  })
})
