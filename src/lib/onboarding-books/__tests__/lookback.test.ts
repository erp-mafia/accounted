import { describe, expect, it } from 'vitest'
import { daysBetween, isoAddDays, resolveLookback } from '../lookback'

const TODAY = '2026-09-10'

describe('resolveLookback', () => {
  it('migration path: the day after the last verifikat', () => {
    const r = resolveLookback({ mode: 'auto', lastEntryDate: '2026-06-11', fiscalYearStart: '2026-01-01', customDate: null, today: TODAY })
    expect(r.rule).toBe('after_last_entry')
    expect(r.fromDate).toBe('2026-06-12')
    expect(r.body).toEqual({ initial_lookback_from_date: '2026-06-12' })
    expect(r.days).toBe(90)
  })

  it('no verifikat: 90 days back', () => {
    const r = resolveLookback({ mode: 'auto', lastEntryDate: null, fiscalYearStart: '2026-01-01', customDate: null, today: TODAY })
    expect(r.rule).toBe('90_days')
    expect(r.body).toEqual({ initial_lookback_days: 90 })
    expect(r.fromDate).toBe('2026-06-12')
  })

  it('a last verifikat dated today or later means nothing to fill', () => {
    const r = resolveLookback({ mode: 'auto', lastEntryDate: '2026-09-10', fiscalYearStart: null, customDate: null, today: TODAY })
    expect(r.rule).toBe('90_days')
  })

  it('räkenskapsårets början and a date go as from-dates', () => {
    const fy = resolveLookback({ mode: 'fy', lastEntryDate: null, fiscalYearStart: '2026-01-01', customDate: null, today: TODAY })
    expect(fy.body).toEqual({ initial_lookback_from_date: '2026-01-01' })
    expect(fy.days).toBe(252)
    const date = resolveLookback({ mode: 'date', lastEntryDate: null, fiscalYearStart: null, customDate: '2026-03-03', today: TODAY })
    expect(date.rule).toBe('date')
    expect(date.fromDate).toBe('2026-03-03')
  })

  it('an unusable date falls back to 90 days instead of a blank request', () => {
    expect(resolveLookback({ mode: 'date', lastEntryDate: null, fiscalYearStart: null, customDate: 'nope', today: TODAY }).rule).toBe('90_days')
    expect(resolveLookback({ mode: 'date', lastEntryDate: null, fiscalYearStart: null, customDate: '2027-01-01', today: TODAY }).rule).toBe('90_days')
    expect(resolveLookback({ mode: 'fy', lastEntryDate: null, fiscalYearStart: null, customDate: null, today: TODAY }).rule).toBe('90_days')
  })
})

describe('date helpers', () => {
  it('adds days across month and year ends', () => {
    expect(isoAddDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(isoAddDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30)
    expect(daysBetween('2026-02-01', '2026-01-01')).toBe(0)
  })
})
