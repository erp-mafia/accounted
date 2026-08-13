import { describe, it, expect } from 'vitest'
import {
  resolveBookedCoverage,
  resolveFiscalYearStart,
  resolveGapFillStart,
} from '../date-suggestions'

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

describe('resolveGapFillStart', () => {
  it('suggests one week of overlap before the newest imported transaction', () => {
    const today = new Date('2026-08-13T12:00:00Z')
    expect(resolveGapFillStart('2026-08-06', today)).toEqual({
      latestImportedDate: '2026-08-06',
      suggestedStartDate: '2026-07-30',
    })
  })

  it('rolls over month and year boundaries', () => {
    // Todays within the 365-day floor of each case so only the 7-day overlap acts.
    expect(resolveGapFillStart('2026-01-03', new Date('2026-01-15T12:00:00Z'))?.suggestedStartDate).toBe('2025-12-27')
    expect(resolveGapFillStart('2026-03-04', new Date('2026-03-10T12:00:00Z'))?.suggestedStartDate).toBe('2026-02-25')
  })

  it('clamps to today when bank data claims a future date (backend rejects non-past dates)', () => {
    const today = new Date('2026-08-13T12:00:00Z')
    expect(resolveGapFillStart('2026-09-20', today)).toEqual({
      latestImportedDate: '2026-09-20',
      suggestedStartDate: '2026-08-13',
    })
  })

  it('clamps a stale renewal to the backend 365-day lookback floor so the shown date matches the actual backfill', () => {
    const today = new Date('2026-08-13T12:00:00Z')
    // Newest import 2025-01-10; minus 7d = 2025-01-03, older than the 365-day
    // floor (2025-08-13), which the backend would silently clamp to anyway.
    expect(resolveGapFillStart('2025-01-10', today)).toEqual({
      latestImportedDate: '2025-01-10',
      suggestedStartDate: '2025-08-13',
    })
  })

  it('returns null when the connection has never imported anything (first connect has no gap)', () => {
    expect(resolveGapFillStart(null)).toBeNull()
    expect(resolveGapFillStart(undefined)).toBeNull()
    expect(resolveGapFillStart('')).toBeNull()
  })

  it('returns null for an unparsable date', () => {
    expect(resolveGapFillStart('not-a-date')).toBeNull()
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
