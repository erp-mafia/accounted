import { describe, it, expect } from 'vitest'
import { deriveFirstYearDefaults, parseStartMonthDay } from '../first-year-defaults'

const NOW = new Date('2026-07-24T12:00:00Z').getTime()
const MONTH_MS = 1000 * 60 * 60 * 24 * 30.44

describe('parseStartMonthDay', () => {
  it('parses a TIC MM-DD into the start month', () => {
    expect(parseStartMonthDay('07-01')).toBe(7)
    expect(parseStartMonthDay('1-15')).toBe(1)
    expect(parseStartMonthDay('12-31')).toBe(12)
  })

  it('returns null for missing input', () => {
    expect(parseStartMonthDay(null)).toBeNull()
    expect(parseStartMonthDay(undefined)).toBeNull()
    expect(parseStartMonthDay('')).toBeNull()
  })

  it('returns null for malformed or out-of-range input', () => {
    expect(parseStartMonthDay('July 1')).toBeNull()
    expect(parseStartMonthDay('2026-07-01')).toBeNull()
    expect(parseStartMonthDay('13-01')).toBeNull()
    expect(parseStartMonthDay('0-15')).toBeNull()
  })
})

describe('deriveFirstYearDefaults', () => {
  it('pre-checks first year for a company registered 11 months ago', () => {
    const registered = NOW - 11 * MONTH_MS
    const result = deriveFirstYearDefaults(registered, NOW)
    expect(result.isFirstFiscalYear).toBe(true)
    expect(result.firstYearStart).toBeDefined()
  })

  it('does not pre-check for a company registered 13 months ago', () => {
    const registered = NOW - 13 * MONTH_MS
    expect(deriveFirstYearDefaults(registered, NOW)).toEqual({
      isFirstFiscalYear: false,
      firstYearStart: undefined,
    })
  })

  it('does not pre-check at exactly 12 months', () => {
    const registered = NOW - 12 * MONTH_MS
    expect(deriveFirstYearDefaults(registered, NOW).isFirstFiscalYear).toBe(false)
  })

  it('extends the window to 18 months when the registry shows no closed period', () => {
    // Extended first räkenskapsår (BFL 3 kap 3 §): registered 13 months ago
    // with no annual report filed is still the first year.
    const registered = NOW - 13 * MONTH_MS
    expect(
      deriveFirstYearDefaults(registered, NOW, { noClosedPeriod: true }).isFirstFiscalYear
    ).toBe(true)
    expect(
      deriveFirstYearDefaults(NOW - 19 * MONTH_MS, NOW, { noClosedPeriod: true }).isFirstFiscalYear
    ).toBe(false)
  })

  it('seeds first_year_start as the 1st of the UTC registration month', () => {
    const registered = new Date('2026-03-14T10:00:00Z').getTime()
    const result = deriveFirstYearDefaults(registered, NOW)
    expect(result.isFirstFiscalYear).toBe(true)
    expect(result.firstYearStart).toBe('2026-03-01')
  })

  it('returns falsy defaults for missing or invalid registration dates', () => {
    const empty = { isFirstFiscalYear: false, firstYearStart: undefined }
    expect(deriveFirstYearDefaults(null, NOW)).toEqual(empty)
    expect(deriveFirstYearDefaults(undefined, NOW)).toEqual(empty)
    expect(deriveFirstYearDefaults(0, NOW)).toEqual(empty)
    expect(deriveFirstYearDefaults(Number.NaN, NOW)).toEqual(empty)
  })
})
