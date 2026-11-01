import { describe, it, expect } from 'vitest'
import {
  addDaysIso,
  addMonthsIso,
  daysBetweenIso,
  endOfDayIsoStockholm,
  stockholmWallTimeToUtc,
  todayIsoStockholm,
  toIsoDate,
  daysPastDue,
  isPastDue,
  previousMonthEndIso,
  stockholmYearMonth,
} from '../iso'

describe('todayIsoStockholm', () => {
  it('rolls over to the next Swedish calendar day before UTC midnight (CEST, UTC+2)', () => {
    expect(todayIsoStockholm(new Date('2026-06-30T22:30:00Z'))).toBe('2026-07-01')
  })

  it('keeps the same day at midday', () => {
    expect(todayIsoStockholm(new Date('2026-01-15T12:00:00Z'))).toBe('2026-01-15')
  })

  it('rolls over one hour later in winter (CET, UTC+1)', () => {
    expect(todayIsoStockholm(new Date('2026-01-15T22:30:00Z'))).toBe('2026-01-15')
    expect(todayIsoStockholm(new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-16')
  })

  it('defaults to now and returns a YYYY-MM-DD string', () => {
    expect(todayIsoStockholm()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('UTC helpers', () => {
  it('addDaysIso is pure UTC arithmetic', () => {
    expect(addDaysIso('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDaysIso('2026-03-29', 1)).toBe('2026-03-30')
    expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('addMonthsIso clamps to the last day of the target month', () => {
    expect(addMonthsIso('2026-03-31', -1)).toBe('2026-02-28')
    expect(addMonthsIso('2028-02-29', -12)).toBe('2027-02-28')
    expect(addMonthsIso('2026-01-16', -12)).toBe('2025-01-16')
    expect(addMonthsIso('2026-11-30', 3)).toBe('2027-02-28')
    expect(addMonthsIso('2026-07-02', 12)).toBe('2027-07-02')
  })

  it('daysBetweenIso is signed', () => {
    expect(daysBetweenIso('2026-01-01', '2026-01-31')).toBe(30)
    expect(daysBetweenIso('2026-01-31', '2026-01-01')).toBe(-30)
  })

  it('toIsoDate takes the UTC calendar date, unlike todayIsoStockholm', () => {
    const late = new Date('2026-06-30T22:30:00Z')
    expect(toIsoDate(late)).toBe('2026-06-30')
    expect(todayIsoStockholm(late)).toBe('2026-07-01')
  })
})

describe('endOfDayIsoStockholm', () => {
  it('ends a summer day at 21:59:59Z and a winter day at 22:59:59Z', () => {
    expect(endOfDayIsoStockholm('2027-04-10')).toBe('2027-04-10T21:59:59Z')
    expect(endOfDayIsoStockholm('2027-01-15')).toBe('2027-01-15T22:59:59Z')
  })

  it('handles the clock-change days themselves (last Sunday of March and October)', () => {
    expect(endOfDayIsoStockholm('2027-03-28')).toBe('2027-03-28T21:59:59Z')
    expect(endOfDayIsoStockholm('2027-10-31')).toBe('2027-10-31T22:59:59Z')
    expect(endOfDayIsoStockholm('2027-03-27')).toBe('2027-03-27T22:59:59Z')
  })

  it('is still inside the Swedish day it names', () => {
    expect(todayIsoStockholm(new Date(endOfDayIsoStockholm('2027-04-10')))).toBe('2027-04-10')
    expect(todayIsoStockholm(new Date(new Date(endOfDayIsoStockholm('2027-04-10')).getTime() + 1000))).toBe('2027-04-11')
  })
})

describe('stockholmWallTimeToUtc', () => {
  it('reads a Swedish wall-clock time in winter and in summer', () => {
    expect(stockholmWallTimeToUtc('2027-02-12', '09:00').toISOString()).toBe('2027-02-12T08:00:00.000Z')
    expect(stockholmWallTimeToUtc('2027-06-30', '09:00').toISOString()).toBe('2027-06-30T07:00:00.000Z')
    expect(stockholmWallTimeToUtc('2027-02-12', '14:30:00').toISOString()).toBe('2027-02-12T13:30:00.000Z')
  })

  it('lands right on the days the clocks change', () => {
    // Summer time starts 2027-03-28 at 02:00 local, ends 2027-10-31 at 03:00 local.
    expect(stockholmWallTimeToUtc('2027-03-28', '09:00').toISOString()).toBe('2027-03-28T07:00:00.000Z')
    expect(stockholmWallTimeToUtc('2027-10-31', '09:00').toISOString()).toBe('2027-10-31T08:00:00.000Z')
  })
})

describe('stockholmYearMonth', () => {
  it('is the Swedish year and month, not the UTC ones', () => {
    expect(stockholmYearMonth(new Date('2026-12-31T23:30:00Z'))).toEqual({ year: 2027, month: 1 })
    expect(stockholmYearMonth(new Date('2026-06-30T22:30:00Z'))).toEqual({ year: 2026, month: 7 })
    expect(stockholmYearMonth(new Date('2026-06-30T21:30:00Z'))).toEqual({ year: 2026, month: 6 })
  })
})

describe('previousMonthEndIso', () => {
  it('is the last day of the month before, across a year and a leap day', () => {
    expect(previousMonthEndIso('2027-01-01')).toBe('2026-12-31')
    expect(previousMonthEndIso('2028-03-15')).toBe('2028-02-29')
    expect(previousMonthEndIso('2026-11-30')).toBe('2026-10-31')
  })
})

describe('isPastDue and daysPastDue', () => {
  it('the due date itself is on time, the day after is day one', () => {
    expect(isPastDue('2026-11-02', '2026-11-01')).toBe(false)
    expect(isPastDue('2026-11-02', '2026-11-02')).toBe(false)
    expect(isPastDue('2026-11-02', '2026-11-03')).toBe(true)
    expect(daysPastDue('2026-11-02', '2026-11-01')).toBe(0)
    expect(daysPastDue('2026-11-02', '2026-11-02')).toBe(0)
    expect(daysPastDue('2026-11-02', '2026-11-03')).toBe(1)
    expect(daysPastDue('2026-11-02', '2026-12-03')).toBe(31)
  })
})
