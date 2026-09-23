import { describe, it, expect } from 'vitest'
import { validatePeriodDuration, monthsBetween } from '../validate-period-duration'

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
