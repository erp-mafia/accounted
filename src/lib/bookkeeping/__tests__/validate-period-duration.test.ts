import { describe, it, expect } from 'vitest'
import {
  checkPeriodDuration,
  exceedsFiscalYearCap,
  isFirstFiscalPeriod,
  monthsBetween,
  validatePeriodDuration,
} from '../validate-period-duration'

describe('monthsBetween', () => {
  it('returns 12 for a standard calendar year', () => {
    expect(monthsBetween('2025-01-01', '2025-12-31')).toBe(12)
  })

  it('returns 18 for an 18-month period', () => {
    expect(monthsBetween('2025-07-01', '2026-12-31')).toBe(18)
  })

  it('returns 1 for a single month', () => {
    expect(monthsBetween('2025-03-01', '2025-03-31')).toBe(1)
  })

  it('returns 3 for a quarter', () => {
    expect(monthsBetween('2025-10-01', '2025-12-31')).toBe(3)
  })
})

describe('validatePeriodDuration', () => {
  it('returns null for a valid 12-month period', () => {
    expect(validatePeriodDuration('2025-01-01', '2025-12-31')).toBeNull()
  })

  it('returns null for exactly 18 months (max allowed)', () => {
    expect(validatePeriodDuration('2025-07-01', '2026-12-31')).toBeNull()
  })

  it('returns null for a short first year (1 month)', () => {
    expect(validatePeriodDuration('2025-12-01', '2025-12-31')).toBeNull()
  })

  it('returns null for a short first year (3 months)', () => {
    expect(validatePeriodDuration('2025-10-01', '2025-12-31')).toBeNull()
  })

  it('returns error for 19 months (exceeds max)', () => {
    const result = validatePeriodDuration('2025-06-01', '2026-12-31')
    expect(result).toContain('19 months')
    expect(result).toContain('18 months')
  })

  it('returns error when end is before start', () => {
    expect(validatePeriodDuration('2025-06-01', '2025-01-31')).toBe(
      'Period end must be after period start'
    )
  })

  it('returns error when start is not 1st of month (default)', () => {
    const result = validatePeriodDuration('2025-01-15', '2025-12-31')
    expect(result).toContain('Period start must be the 1st of a month')
    // Says what IS allowed and why, not only "no" (issue #2237).
    expect(result).toContain('first fiscal year may start mid-month')
    expect(result).toContain('BFL 3 kap.')
  })

  it('returns error when start is not 1st of month (isFirstPeriod: false)', () => {
    expect(validatePeriodDuration('2025-03-25', '2025-12-31', { isFirstPeriod: false })).toContain(
      'Period start must be the 1st of a month'
    )
  })

  it('allows mid-month start for first fiscal period', () => {
    expect(validatePeriodDuration('2025-03-25', '2025-12-31', { isFirstPeriod: true })).toBeNull()
  })

  it('allows mid-month start for first period (July)', () => {
    expect(validatePeriodDuration('2025-07-15', '2025-12-31', { isFirstPeriod: true })).toBeNull()
  })

  it('still allows day-1 start for first period (6 months)', () => {
    expect(validatePeriodDuration('2025-07-01', '2025-12-31', { isFirstPeriod: true })).toBeNull()
  })

  it('enforces end-of-month even for first period', () => {
    expect(validatePeriodDuration('2025-03-25', '2025-12-15', { isFirstPeriod: true })).toBe(
      'Period end must be the last day of a month'
    )
  })

  it('enforces 18-month max for first period with mid-month start', () => {
    const result = validatePeriodDuration('2025-01-15', '2026-12-31', { isFirstPeriod: true })
    expect(result).toContain('months')
    expect(result).toContain('18 months')
  })

  // BFL 3 kap 3 § sets NO minimum for a first räkenskapsår: it may be
  // "hur kort som helst" (Bolagsverket). A 6-month floor here blocked an
  // autumn-registered AB from shortening its first year to Dec 31 for an
  // early årsredovisning (real customer case 2026-07-25).
  it('allows a short first period (3 months, autumn registration to Dec 31)', () => {
    expect(validatePeriodDuration('2025-10-01', '2025-12-31', { isFirstPeriod: true })).toBeNull()
  })

  it('allows a very short first period (2 months, mid-month start)', () => {
    expect(validatePeriodDuration('2026-03-25', '2026-05-31', { isFirstPeriod: true })).toBeNull()
  })

  it('allows exactly 6 months for first period', () => {
    expect(validatePeriodDuration('2026-07-01', '2026-12-31', { isFirstPeriod: true })).toBeNull()
  })

  it('realistic customer case: 2026-03-25 to 2027-02-28', () => {
    expect(validatePeriodDuration('2026-03-25', '2027-02-28', { isFirstPeriod: true })).toBeNull()
  })

  it('returns error when end is not last day of month', () => {
    expect(validatePeriodDuration('2025-01-01', '2025-12-15')).toBe(
      'Period end must be the last day of a month'
    )
  })

  it('handles February end correctly (non-leap year)', () => {
    expect(validatePeriodDuration('2025-01-01', '2025-02-28')).toBeNull()
  })

  it('handles February end correctly (leap year)', () => {
    expect(validatePeriodDuration('2024-01-01', '2024-02-29')).toBeNull()
  })

  it('rejects Feb 28 in a leap year (not last day)', () => {
    expect(validatePeriodDuration('2024-01-01', '2024-02-28')).toBe(
      'Period end must be the last day of a month'
    )
  })

  it('returns null for a broken fiscal year (May-Apr)', () => {
    expect(validatePeriodDuration('2025-05-01', '2026-04-30')).toBeNull()
  })
})

describe('exceedsFiscalYearCap', () => {
  it.each([
    ['2024-03-01', '2025-08-31', false], // exactly 18 months
    ['2024-03-15', '2025-08-31', false], // a mid-month start counts its month, and fits
    ['2024-01-31', '2025-07-31', true], // the day of the 31st, then 18 whole months
    ['2024-03-31', '2025-09-30', true], // the same, ending in a shorter month
    ['2024-02-29', '2025-08-31', true],
    ['2024-03-01', '2025-09-30', true], // 19 months
    ['2024-01-01', '2026-12-31', true], // the 36 months on prod
  ])('%s to %s: %s', (start, end, over) => {
    expect(exceedsFiscalYearCap(start, end)).toBe(over)
  })

  it('is the cap checkPeriodDuration refuses', () => {
    expect(checkPeriodDuration('2024-01-31', '2025-07-31', { isFirstPeriod: true })).toMatchObject({
      rule: 'exceeds_18_months',
      months: 19,
    })
    expect(checkPeriodDuration('2024-03-15', '2025-08-31', { isFirstPeriod: true })).toBeNull()
  })
})

describe('isFirstFiscalPeriod', () => {
  it('is the year no recorded year starts before', () => {
    expect(isFirstFiscalPeriod('2024-03-14', ['2025-01-01', '2026-01-01'])).toBe(true)
    expect(isFirstFiscalPeriod('2025-01-01', ['2024-03-14', '2026-01-01'])).toBe(false)
  })

  it('is not the year behind a gap', () => {
    expect(isFirstFiscalPeriod('2025-01-01', ['2023-01-01'])).toBe(false)
  })

  it('takes a lone year as the first, and may be handed the year itself', () => {
    expect(isFirstFiscalPeriod('2025-01-01', [])).toBe(true)
    expect(isFirstFiscalPeriod('2025-01-01', ['2025-01-01'])).toBe(true)
  })
})

describe('checkPeriodDuration on a form bound to the calendar year', () => {
  const calendarYearOnly = true

  it('takes a calendar year, and a first year from any day to 31 December', () => {
    expect(checkPeriodDuration('2026-01-01', '2026-12-31', { calendarYearOnly })).toBeNull()
    expect(checkPeriodDuration('2026-03-10', '2026-12-31', { calendarYearOnly, isFirstPeriod: true })).toBeNull()
    expect(checkPeriodDuration('2025-07-14', '2026-12-31', { calendarYearOnly, isFirstPeriod: true })).toBeNull()
  })

  it('refuses any other end, the first year included', () => {
    expect(checkPeriodDuration('2026-01-01', '2026-06-30', { calendarYearOnly })?.rule).toBe('not_calendar_year_end')
    expect(checkPeriodDuration('2026-03-10', '2026-06-30', { calendarYearOnly, isFirstPeriod: true })?.rule).toBe(
      'not_calendar_year_end',
    )
  })

  it('refuses a later year starting after 1 January', () => {
    expect(checkPeriodDuration('2026-02-01', '2026-12-31', { calendarYearOnly })?.rule).toBe('not_calendar_year_start')
  })

  it('still holds a first year to 18 months', () => {
    expect(checkPeriodDuration('2025-06-14', '2026-12-31', { calendarYearOnly, isFirstPeriod: true })?.rule).toBe(
      'exceeds_18_months',
    )
  })

  it('leaves every other form its broken year', () => {
    expect(checkPeriodDuration('2025-09-01', '2026-08-31')).toBeNull()
  })
})
