import { describe, it, expect } from 'vitest'
import {
  filterBucketsToRange,
  mergeMonthlySeries,
  periodsInRange,
  pickCurrentPeriod,
  resolvePeriodPreset,
  resultMargin,
  sumBuckets,
  type FiscalPeriodLite,
  type MonthBucket,
} from '@/lib/byra/kpi-aggregate'

const bucket = (
  year: number,
  month0: number,
  income = 0,
  expenses = 0,
): MonthBucket => ({ year, month0, income, expenses })

const period = (
  id: string,
  start: string,
  end: string,
  ob: string | null = null,
): FiscalPeriodLite => ({
  id,
  company_id: 'c1',
  period_start: start,
  period_end: end,
  opening_balance_entry_id: ob,
})

describe('resolvePeriodPreset', () => {
  const today = new Date(2026, 7, 4) // 2026-08-04

  it('resolves month to the first of the current month', () => {
    expect(resolvePeriodPreset('month', today).range).toEqual({
      fromDate: '2026-08-01',
      toDate: '2026-08-04',
    })
  })

  it('resolves quarter to the quarter start', () => {
    expect(resolvePeriodPreset('quarter', today).range).toEqual({
      fromDate: '2026-07-01',
      toDate: '2026-08-04',
    })
  })

  it('resolves ytd to January 1', () => {
    expect(resolvePeriodPreset('ytd', today).range).toEqual({
      fromDate: '2026-01-01',
      toDate: '2026-08-04',
    })
  })

  it('resolves 12m across the year boundary', () => {
    expect(resolvePeriodPreset('12m', today).range).toEqual({
      fromDate: '2025-09-01',
      toDate: '2026-08-04',
    })
  })

  it('falls back to ytd on unknown or missing input', () => {
    expect(resolvePeriodPreset('bogus', today).preset).toBe('ytd')
    expect(resolvePeriodPreset(undefined, today).preset).toBe('ytd')
  })

  it('handles a January today for quarter and 12m', () => {
    const january = new Date(2026, 0, 15)
    expect(resolvePeriodPreset('quarter', january).range.fromDate).toBe('2026-01-01')
    expect(resolvePeriodPreset('12m', january).range.fromDate).toBe('2025-02-01')
  })
})

describe('pickCurrentPeriod', () => {
  const fy25 = period('p25', '2025-01-01', '2025-12-31')
  const fy26 = period('p26', '2026-01-01', '2026-12-31')
  const fy27 = period('p27', '2027-01-01', '2027-12-31')

  it('picks the period containing today', () => {
    expect(pickCurrentPeriod([fy25, fy26, fy27], '2026-08-04')?.id).toBe('p26')
  })

  it('falls back to the most recent past period', () => {
    expect(pickCurrentPeriod([fy25, fy26], '2027-06-01')?.id).toBe('p26')
  })

  it('falls back to the earliest future period when all are ahead', () => {
    expect(pickCurrentPeriod([fy26, fy27], '2024-06-01')?.id).toBe('p26')
  })

  it('returns null for no periods', () => {
    expect(pickCurrentPeriod([], '2026-08-04')).toBeNull()
  })

  it('prefers the latest start when periods overlap today', () => {
    const short = period('pShort', '2026-07-01', '2026-12-31')
    expect(pickCurrentPeriod([fy26, short], '2026-08-04')?.id).toBe('pShort')
  })
})

describe('periodsInRange', () => {
  it('keeps periods overlapping the range and drops the rest', () => {
    const fy25 = period('p25', '2025-01-01', '2025-12-31')
    const fy26 = period('p26', '2026-01-01', '2026-12-31')
    const range = { fromDate: '2025-09-01', toDate: '2026-08-04' }
    expect(periodsInRange([fy25, fy26], range).map((p) => p.id)).toEqual(['p25', 'p26'])
    expect(
      periodsInRange([fy25], { fromDate: '2026-01-01', toDate: '2026-08-04' }),
    ).toEqual([])
  })
})

describe('filterBucketsToRange', () => {
  it('keeps whole months inside the range, inclusive of partial edge months', () => {
    const buckets = [
      bucket(2025, 7),
      bucket(2025, 8),
      bucket(2026, 7),
      bucket(2026, 8),
    ]
    const range = { fromDate: '2025-09-01', toDate: '2026-08-04' }
    expect(filterBucketsToRange(buckets, range)).toEqual([
      bucket(2025, 8),
      bucket(2026, 7),
    ])
  })
})

describe('sumBuckets and resultMargin', () => {
  it('sums revenue, expenses and result with öre rounding', () => {
    const sums = sumBuckets([
      bucket(2026, 0, 100.005, 50.004),
      bucket(2026, 1, 200, 25),
    ])
    expect(sums.revenue).toBe(300.01)
    expect(sums.expenses).toBe(75.0)
    expect(sums.result).toBe(225.01)
  })

  it('returns zeros for no buckets', () => {
    expect(sumBuckets([])).toEqual({ revenue: 0, expenses: 0, result: 0 })
  })

  it('computes margin in percent and nulls out on zero revenue', () => {
    expect(resultMargin(200, 50)).toBe(25)
    expect(resultMargin(300, 100)).toBe(33.33)
    expect(resultMargin(0, -500)).toBeNull()
  })
})

describe('mergeMonthlySeries', () => {
  it('zero-fills every month of the range and sums across companies', () => {
    const range = { fromDate: '2026-01-01', toDate: '2026-03-31' }
    const months = mergeMonthlySeries(
      [bucket(2026, 0, 100, 40), bucket(2026, 0, 50, 10), bucket(2026, 2, 30, 5)],
      range,
    )
    expect(months).toEqual([
      { label: 'Jan', income: 150, expenses: 50 },
      { label: 'Feb', income: 0, expenses: 0 },
      { label: 'Mar', income: 30, expenses: 5 },
    ])
  })

  it('adds a year suffix when the range spans calendar years', () => {
    const range = { fromDate: '2025-12-01', toDate: '2026-01-31' }
    const months = mergeMonthlySeries([bucket(2025, 11, 10, 0)], range)
    expect(months.map((m) => m.label)).toEqual(['Dec 25', 'Jan 26'])
  })

  it('ignores buckets outside the range', () => {
    const range = { fromDate: '2026-01-01', toDate: '2026-01-31' }
    const months = mergeMonthlySeries([bucket(2025, 11, 999, 999)], range)
    expect(months).toEqual([{ label: 'Jan', income: 0, expenses: 0 }])
  })

  it('returns empty for an inverted range', () => {
    expect(
      mergeMonthlySeries([], { fromDate: '2026-03-01', toDate: '2026-01-31' }),
    ).toEqual([])
  })
})
