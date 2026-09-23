import { describe, it, expect } from 'vitest'
import { abFirstYearEndOptions, efFirstYearEndOptions } from '../fiscal-options'
import { computeFiscalPeriod } from '@/lib/company/compute-fiscal-period'

/**
 * BFL 3 kap sets no minimum length for a first räkenskapsår, only the
 * 18-month maximum. PR #1165 removed an invented 6-month floor from
 * validatePeriodDuration; these tests pin the same rule on the onboarding
 * journey's option generator, which kept the floor until now.
 */

/** The journey's own gate before submit: option -> computeFiscalPeriod. */
function journeyAccepts(start: string, end: string): string | null {
  return computeFiscalPeriod({
    entity_type: 'aktiebolag',
    is_first_fiscal_year: true,
    first_year_start: start,
    first_year_end: end,
  }).error
}

describe('abFirstYearEndOptions', () => {
  it('offers a 3-month first year (autumn registration ending 31 Dec)', () => {
    const options = abFirstYearEndOptions(2026, 10, 12)
    const short = options.find((o) => o.months === 3)
    expect(short).toBeDefined()
    expect(short?.date).toBe('2026-12-31')
    expect(journeyAccepts('2026-10-01', short!.date)).toBeNull()
  })

  it('offers an 18-month first year', () => {
    const options = abFirstYearEndOptions(2026, 1, 6)
    const long = options.find((o) => o.months === 18)
    expect(long).toBeDefined()
    expect(long?.date).toBe('2027-06-30')
    expect(journeyAccepts('2026-01-01', long!.date)).toBeNull()
  })

  it('never offers a 19-month first year, and the journey gate rejects one', () => {
    const options = abFirstYearEndOptions(2026, 1, 7)
    expect(options.map((o) => o.months)).toEqual([7])
    expect(options.some((o) => o.date === '2027-07-31')).toBe(false)
    expect(journeyAccepts('2026-01-01', '2027-07-31')).toContain('exceeds maximum 18 months')
  })

  it('drops end months that fall before the start month (no zero or negative spans)', () => {
    const options = abFirstYearEndOptions(2026, 10, 3)
    expect(options.map((o) => o.date)).toEqual(['2027-03-31', '2028-03-31'])
    expect(options.map((o) => o.months)).toEqual([6, 18])
    expect(options.every((o) => o.months >= 1)).toBe(true)
  })

  it('offers a 1-month first year when the start and end month are the same', () => {
    const options = abFirstYearEndOptions(2026, 12, 12)
    expect(options[0]).toMatchObject({ date: '2026-12-31', months: 1 })
    expect(journeyAccepts('2026-12-01', '2026-12-31')).toBeNull()
  })
})

describe('AB and EF option generation agree', () => {
  it('produces identical options for a December end month, for every start month', () => {
    for (let startMonth = 1; startMonth <= 12; startMonth++) {
      expect(abFirstYearEndOptions(2026, startMonth, 12), `start month ${startMonth}`).toEqual(
        efFirstYearEndOptions(2026, startMonth),
      )
    }
  })

  it('both offer the short first year an autumn registration needs', () => {
    expect(efFirstYearEndOptions(2026, 10).map((o) => o.months)).toEqual([3, 15])
    expect(abFirstYearEndOptions(2026, 10, 12).map((o) => o.months)).toEqual([3, 15])
  })
})
