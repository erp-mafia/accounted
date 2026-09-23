import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { computeFiscalPeriod } from '../compute-fiscal-period'

describe('computeFiscalPeriod', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:00'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('derives a calendar year from start month 1', () => {
    const result = computeFiscalPeriod({ fiscal_year_start_month: 1, entity_type: 'aktiebolag' })
    expect(result.error).toBeNull()
    expect(result.startStr).toBe('2026-01-01')
    expect(result.endStr).toBe('2026-12-31')
    expect(result.periodName).toBe('Räkenskapsår 2026')
  })

  it('defaults to a calendar year when start month is missing', () => {
    const result = computeFiscalPeriod({ entity_type: 'aktiebolag' })
    expect(result.error).toBeNull()
    expect(result.startStr).toBe('2026-01-01')
    expect(result.endStr).toBe('2026-12-31')
  })

  it('derives a broken fiscal year (brutet räkenskapsår) crossing the year end', () => {
    const result = computeFiscalPeriod({ fiscal_year_start_month: 7, entity_type: 'aktiebolag' })
    expect(result.error).toBeNull()
    expect(result.startStr).toBe('2026-07-01')
    expect(result.endStr).toBe('2027-06-30')
    expect(result.periodName).toBe('Räkenskapsår 2026/2027')
  })

  it('forces enskild firma onto the calendar year regardless of start month', () => {
    const result = computeFiscalPeriod({ fiscal_year_start_month: 7, entity_type: 'enskild_firma' })
    expect(result.error).toBeNull()
    expect(result.startStr).toBe('2026-01-01')
    expect(result.endStr).toBe('2026-12-31')
    expect(result.periodName).toBe('Räkenskapsår 2026')
  })

  it('uses first-year dates verbatim, same-year name', () => {
    const result = computeFiscalPeriod({
      entity_type: 'aktiebolag',
      is_first_fiscal_year: true,
      first_year_start: '2026-03-14',
      first_year_end: '2026-12-31',
    })
    expect(result.error).toBeNull()
    expect(result.startStr).toBe('2026-03-14')
    expect(result.endStr).toBe('2026-12-31')
    expect(result.periodName).toBe('Första räkenskapsåret 2026')
  })

  it('allows a mid-month start date only for the first year (BFL 3 kap.)', () => {
    const result = computeFiscalPeriod({
      entity_type: 'aktiebolag',
      is_first_fiscal_year: true,
      first_year_start: '2026-03-14',
      first_year_end: '2027-06-30',
    })
    expect(result.error).toBeNull()
    expect(result.periodName).toBe('Första räkenskapsåret 2026/2027')
  })

  it('accepts an extended first year up to 18 months', () => {
    const result = computeFiscalPeriod({
      entity_type: 'aktiebolag',
      is_first_fiscal_year: true,
      first_year_start: '2026-07-01',
      first_year_end: '2027-12-31',
    })
    expect(result.error).toBeNull()
    expect(result.periodName).toBe('Första räkenskapsåret 2026/2027')
  })

  it('rejects a first year longer than 18 months', () => {
    const result = computeFiscalPeriod({
      entity_type: 'aktiebolag',
      is_first_fiscal_year: true,
      first_year_start: '2026-01-01',
      first_year_end: '2027-12-31',
    })
    expect(result.error).toContain('exceeds maximum 18 months')
    expect(result.startStr).toBe('')
    expect(result.endStr).toBe('')
    expect(result.periodName).toBe('')
  })

  // BFL 3 kap 3 § allows a first räkenskapsår of any length up to 18 months:
  // an autumn-registered AB may end its first year at Dec 31 (Bolagsverket
  // offers this explicitly on the registration certificate).
  it('accepts a first year shorter than 6 months', () => {
    const result = computeFiscalPeriod({
      entity_type: 'aktiebolag',
      is_first_fiscal_year: true,
      first_year_start: '2026-10-01',
      first_year_end: '2026-12-31',
    })
    expect(result.error).toBeNull()
    expect(result.startStr).toBe('2026-10-01')
    expect(result.endStr).toBe('2026-12-31')
  })

  it('rejects an end date that is not the last day of a month', () => {
    const result = computeFiscalPeriod({
      entity_type: 'aktiebolag',
      is_first_fiscal_year: true,
      first_year_start: '2026-03-01',
      first_year_end: '2026-12-30',
    })
    expect(result.error).toContain('last day of a month')
  })

  it('rejects an end before the start', () => {
    const result = computeFiscalPeriod({
      entity_type: 'aktiebolag',
      is_first_fiscal_year: true,
      first_year_start: '2026-06-01',
      first_year_end: '2026-05-31',
    })
    expect(result.error).toContain('must be after')
  })

  it('falls back to the standard branch when first-year dates are incomplete', () => {
    const result = computeFiscalPeriod({
      entity_type: 'aktiebolag',
      is_first_fiscal_year: true,
      fiscal_year_start_month: 1,
    })
    expect(result.error).toBeNull()
    expect(result.startStr).toBe('2026-01-01')
    expect(result.endStr).toBe('2026-12-31')
  })
})
