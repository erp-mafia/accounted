import { describe, it, expect } from 'vitest'
import { resolveBookedCoverage, resolveFiscalYearStart } from '../date-suggestions'

describe('resolveBookedCoverage', () => {
  it('suggests the day after the last posted verifikat date', () => {
    expect(resolveBookedCoverage('2026-05-14')).toEqual({
      lastBookedDate: '2026-05-14',
      suggestedStartDate: '2026-05-15',
    })
  })

  it('rolls over month and year boundaries', () => {
    // Pin "today" past every case so the clamp does not kick in.
    const today = new Date('2030-01-01T12:00:00Z')
    expect(resolveBookedCoverage('2026-01-31', today)?.suggestedStartDate).toBe('2026-02-01')
    expect(resolveBookedCoverage('2026-12-31', today)?.suggestedStartDate).toBe('2027-01-01')
    // Leap year: 2028-02-28 is not the last day of February.
    expect(resolveBookedCoverage('2028-02-28', today)?.suggestedStartDate).toBe('2028-02-29')
  })

  it('clamps to today when the last posted verifikat is dated today (backend rejects non-past dates)', () => {
    // Day after 2026-07-09 would be 2026-07-10 (tomorrow), which the PATCH
    // handler rejects with 400; the suggestion must stay clickable.
    const today = new Date('2026-07-09T12:00:00Z')
    expect(resolveBookedCoverage('2026-07-09', today)).toEqual({
      lastBookedDate: '2026-07-09',
      suggestedStartDate: '2026-07-09',
    })
  })

  it('clamps to today when the last posted verifikat is dated in the future', () => {
    const today = new Date('2026-07-09T12:00:00Z')
    expect(resolveBookedCoverage('2026-08-15', today)).toEqual({
      lastBookedDate: '2026-08-15',
      suggestedStartDate: '2026-07-09',
    })
  })

  it('returns null when the company has no posted entries (issue #917: never fall back to fiscal_year_end)', () => {
    expect(resolveBookedCoverage(null)).toBeNull()
    expect(resolveBookedCoverage(undefined)).toBeNull()
    expect(resolveBookedCoverage('')).toBeNull()
  })
})

describe('resolveFiscalYearStart', () => {
  const calendarYearSettings = {
    fiscal_year_start_month: 1,
    entity_type: 'aktiebolag' as const,
  }

  it('prefers the actual fiscal period row over the recurring start month (issue #917: extended first year)', () => {
    // Company with an extended first fiscal year 2025-10-01 to 2026-12-31 that
    // later runs calendar years: the recurring setting would wrongly resolve
    // to 2026-01-01.
    expect(
      resolveFiscalYearStart('2025-10-01', calendarYearSettings, new Date('2026-07-09')),
    ).toBe('2025-10-01')
  })

  it('falls back to the recurring fiscal_year_start_month when no period row exists', () => {
    expect(
      resolveFiscalYearStart(null, calendarYearSettings, new Date('2026-07-09')),
    ).toBe('2026-01-01')
    expect(
      resolveFiscalYearStart(
        undefined,
        { fiscal_year_start_month: 7, entity_type: 'aktiebolag' },
        new Date('2026-05-01'),
      ),
    ).toBe('2025-07-01')
  })

  it('falls back to calendar year when settings are missing too', () => {
    expect(resolveFiscalYearStart(null, null, new Date('2026-07-09'))).toBe('2026-01-01')
  })
})
