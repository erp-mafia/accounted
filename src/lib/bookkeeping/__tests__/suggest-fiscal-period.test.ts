import { describe, it, expect } from 'vitest'
import {
  computeSuggestedPeriod,
  fiscalYearName,
  fiscalYearShortName,
  isDerivedFiscalYearName,
  missingFiscalYears,
  nextFiscalYearRange,
  scheduledFiscalYear,
  suggestSeedDate,
  resolveCurrentPeriodId,
} from '../suggest-fiscal-period'

type Range = { period_start: string; period_end: string }

const FY2024: Range = { period_start: '2024-01-01', period_end: '2024-12-31' }
const FY2026: Range = { period_start: '2026-01-01', period_end: '2026-12-31' }

describe('nextFiscalYearRange', () => {
  it('runs twelve months from the day after', () => {
    expect(nextFiscalYearRange('2026-12-31')).toEqual({ start: '2027-01-01', end: '2027-12-31' })
    expect(nextFiscalYearRange('2026-06-30')).toEqual({ start: '2026-07-01', end: '2027-06-30' })
  })

  it('follows a short first year with a whole one, the February of a leap year included', () => {
    expect(nextFiscalYearRange('2026-01-31')).toEqual({ start: '2026-02-01', end: '2027-01-31' })
    expect(nextFiscalYearRange('2027-02-28')).toEqual({ start: '2027-03-01', end: '2028-02-29' })
  })
})

describe('scheduledFiscalYear', () => {
  it('is the twelve-month year holding the date', () => {
    expect(scheduledFiscalYear('2026-03-05', 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    expect(scheduledFiscalYear('2026-03-05', 7)).toEqual({ start: '2025-07-01', end: '2026-06-30' })
    expect(scheduledFiscalYear('2026-07-01', 7)).toEqual({ start: '2026-07-01', end: '2027-06-30' })
  })
})

describe('missingFiscalYears', () => {
  it('walks the chain up to the year holding the date', () => {
    expect(missingFiscalYears('2028-03-10', [FY2026], 10)).toEqual([
      { start: '2027-01-01', end: '2027-12-31' },
      { start: '2028-01-01', end: '2028-12-31' },
    ])
  })

  it('stops at the next recorded year', () => {
    expect(
      missingFiscalYears('2025-02-01', [FY2024, { period_start: '2025-07-01', period_end: '2026-06-30' }], 10),
    ).toEqual([{ start: '2025-01-01', end: '2025-06-30' }])
  })

  it('answers nothing for a date further off than the limit', () => {
    expect(missingFiscalYears('2099-03-10', [FY2026], 10)).toEqual([])
  })
})

describe('fiscalYearName', () => {
  it('names a calendar year by its year', () => {
    expect(fiscalYearName('2025-01-01', '2025-12-31')).toBe('Räkenskapsår 2025')
  })

  it('names a straddling year by both years', () => {
    expect(fiscalYearName('2024-07-01', '2025-06-30')).toBe('Räkenskapsår 2024/2025')
  })

  it('names a backfilled first year that spans two calendar years by both years', () => {
    // The customer case: the create dialog seeded "Räkenskapsår 2027" and the
    // user re-dated the form to the company's first, extended year.
    expect(fiscalYearName('2022-07-28', '2023-12-31')).toBe('Räkenskapsår 2022/2023')
  })
})

describe('isDerivedFiscalYearName', () => {
  it('recognises the names fiscalYearName produces', () => {
    expect(isDerivedFiscalYearName('Räkenskapsår 2025')).toBe(true)
    expect(isDerivedFiscalYearName('Räkenskapsår 2024/2025')).toBe(true)
    expect(isDerivedFiscalYearName(fiscalYearName('2022-07-28', '2023-12-31'))).toBe(true)
  })

  it('recognises a derived name whose years no longer match the dates', () => {
    // The customer row (#2286, #2287): seeded "Räkenskapsår 2027" on a
    // 2022/2023 year. The edit dialog must let it follow corrected dates.
    expect(isDerivedFiscalYearName('Räkenskapsår 2027')).toBe(true)
    expect(isDerivedFiscalYearName('  Räkenskapsår 2027  ')).toBe(true)
  })

  it('leaves hand-written names alone', () => {
    expect(isDerivedFiscalYearName('Första året')).toBe(false)
    expect(isDerivedFiscalYearName('Räkenskapsår 2025 (förlängt)')).toBe(false)
    expect(isDerivedFiscalYearName('2025')).toBe(false)
    expect(isDerivedFiscalYearName('Fiscal year 2025')).toBe(false)
    expect(isDerivedFiscalYearName('')).toBe(false)
  })
})

describe('fiscalYearShortName', () => {
  it('drops the noun from a generated name shown under a Räkenskapsår label (crm#1380)', () => {
    // The "Räkenskapsår:" line of a new verifikat read "Räkenskapsår: Räkenskapsår 2026".
    expect(fiscalYearShortName('Räkenskapsår 2026')).toBe('2026')
    expect(fiscalYearShortName(fiscalYearName('2025-07-01', '2026-06-30'))).toBe('2025/2026')
    expect(fiscalYearShortName('  Räkenskapsår 2026  ')).toBe('2026')
  })

  it('covers the onboarding first year and the year opened at year end', () => {
    expect(fiscalYearShortName('Första räkenskapsåret 2026')).toBe('2026')
    expect(fiscalYearShortName('Första räkenskapsåret 2025/2026')).toBe('2025/2026')
    expect(fiscalYearShortName('FY 2027')).toBe('2027')
    expect(fiscalYearShortName('FY 2026/2027')).toBe('2026/2027')
  })

  it('keeps a name the user wrote whole', () => {
    expect(fiscalYearShortName('Räkenskapsår 2025 (förlängt)')).toBe('Räkenskapsår 2025 (förlängt)')
    expect(fiscalYearShortName('Räkenskapsår 2024-2025')).toBe('Räkenskapsår 2024-2025')
    expect(fiscalYearShortName('Första året')).toBe('Första året')
    expect(fiscalYearShortName('Fiscal year 2025')).toBe('Fiscal year 2025')
    expect(fiscalYearShortName('2025')).toBe('2025')
    expect(fiscalYearShortName('')).toBe('')
  })
})

describe('computeSuggestedPeriod', () => {
  it('suggests a calendar year around the entry date when there are no periods', () => {
    expect(computeSuggestedPeriod('2025-06-15', [])).toEqual({
      name: 'Räkenskapsår 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })
  })

  it('suggests a backfill year before the earliest period', () => {
    expect(computeSuggestedPeriod('2025-06-15', [FY2026])).toEqual({
      name: 'Räkenskapsår 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })
  })

  it('suggests the missing year when the entry date is in an interior gap', () => {
    // FY 2024 + FY 2026 exist, 2025 is the hole (interior-gap scenario).
    expect(computeSuggestedPeriod('2025-06-15', [FY2024, FY2026])).toEqual({
      name: 'Räkenskapsår 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })
  })

  it('caps the gap suggestion so it never overlaps the right neighbour', () => {
    // A six-month hole (Jan-Jun 2025) before a short FY 2025 H2 period.
    const fy2025h2: Range = { period_start: '2025-07-01', period_end: '2025-12-31' }
    expect(computeSuggestedPeriod('2025-03-15', [FY2024, fy2025h2])).toEqual({
      name: 'Räkenskapsår 2025',
      period_start: '2025-01-01',
      period_end: '2025-06-30',
    })
  })

  it('suggests the next forward year after the latest period', () => {
    expect(computeSuggestedPeriod('2025-06-15', [FY2024])).toEqual({
      name: 'Räkenskapsår 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })
  })
})

describe('suggestSeedDate', () => {
  const today = '2026-06-16'

  it('returns today when there are no periods', () => {
    expect(suggestSeedDate([], today)).toBe('2026-06-16')
  })

  it('returns the start of the earliest gap when one exists', () => {
    expect(suggestSeedDate([FY2024, FY2026], today)).toBe('2025-01-01')
  })

  it('returns the day after the latest period when there is no gap', () => {
    const fy2025: Range = { period_start: '2025-01-01', period_end: '2025-12-31' }
    expect(suggestSeedDate([FY2024, fy2025], today)).toBe('2026-01-01')
  })

  it('returns the day after the only period for a single period', () => {
    expect(suggestSeedDate([FY2024], today)).toBe('2025-01-01')
  })
})

describe('resolveCurrentPeriodId', () => {
  const P2024 = { id: 'p2024', period_start: '2024-01-01', period_end: '2024-12-31' }
  const P2025 = { id: 'p2025', period_start: '2025-01-01', period_end: '2025-12-31' }
  const P2026 = { id: 'p2026', period_start: '2026-01-01', period_end: '2026-12-31' }

  it('returns null when there are no periods', () => {
    expect(resolveCurrentPeriodId([], '2026-06-29')).toBeNull()
  })

  it('returns the period that contains today', () => {
    expect(resolveCurrentPeriodId([P2024, P2025, P2026], '2026-06-29')).toBe('p2026')
  })

  it('is order-independent', () => {
    expect(resolveCurrentPeriodId([P2026, P2024, P2025], '2025-03-01')).toBe('p2025')
  })

  it('falls back to the most recent started period when today sits in a gap after the last year', () => {
    // Today is in 2027 but only periods up to 2026 exist (next year not created yet).
    expect(resolveCurrentPeriodId([P2024, P2025, P2026], '2027-02-15')).toBe('p2026')
  })

  it('falls back to the earliest period when every period is still upcoming', () => {
    expect(resolveCurrentPeriodId([P2025, P2026], '2024-06-01')).toBe('p2025')
  })
})
