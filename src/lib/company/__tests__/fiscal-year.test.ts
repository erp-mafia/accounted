import { describe, it, expect } from 'vitest'
import { getCurrentFiscalYearStart, getPreviousFiscalYearStart, daysBetween } from '../fiscal-year'

describe('getCurrentFiscalYearStart', () => {
  it('returns Jan 1 of current year for calendar-year fiscals', () => {
    expect(getCurrentFiscalYearStart({ fiscal_year_start_month: 1, entity_type: 'aktiebolag' }, new Date('2026-05-21'))).toBe('2026-01-01')
  })

  it('returns previous-year July 1 when today is before July with a July fiscal start', () => {
    expect(getCurrentFiscalYearStart({ fiscal_year_start_month: 7, entity_type: 'aktiebolag' }, new Date('2026-05-21'))).toBe('2025-07-01')
  })

  it('returns current-year July 1 when today is after July with a July fiscal start', () => {
    expect(getCurrentFiscalYearStart({ fiscal_year_start_month: 7, entity_type: 'aktiebolag' }, new Date('2026-09-15'))).toBe('2026-07-01')
  })

  it('locks enskild firma to calendar year even with a non-Jan setting', () => {
    expect(getCurrentFiscalYearStart({ fiscal_year_start_month: 7, entity_type: 'enskild_firma' }, new Date('2026-05-21'))).toBe('2026-01-01')
  })

  it('defaults to Jan 1 when settings are missing', () => {
    expect(getCurrentFiscalYearStart(null, new Date('2026-05-21'))).toBe('2026-01-01')
  })
})

describe('getPreviousFiscalYearStart', () => {
  it('returns prior calendar year for calendar fiscals', () => {
    expect(getPreviousFiscalYearStart({ fiscal_year_start_month: 1, entity_type: 'aktiebolag' }, new Date('2026-05-21'))).toBe('2025-01-01')
  })

  it('handles July fiscal start correctly', () => {
    expect(getPreviousFiscalYearStart({ fiscal_year_start_month: 7, entity_type: 'aktiebolag' }, new Date('2026-05-21'))).toBe('2024-07-01')
  })
})

describe('daysBetween', () => {
  it('counts whole days between two dates', () => {
    expect(daysBetween('2026-01-01', '2026-01-11')).toBe(10)
  })

  it('returns 0 when from > to (no negative)', () => {
    expect(daysBetween('2026-05-21', '2026-05-01')).toBe(0)
  })
})
