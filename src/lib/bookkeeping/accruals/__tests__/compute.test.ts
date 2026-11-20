import { describe, expect, it } from 'vitest'
import {
  computeInstallmentAmounts,
  computeInstallments,
  countCalendarMonths,
  dayAfter,
  deferralReleaseDate,
  firstOfMonth,
  listCalendarMonths,
  maxIsoDate,
  replanPendingInstallments,
} from '@/lib/bookkeeping/accruals/compute'
import { sumOre } from '@/lib/money'

describe('firstOfMonth', () => {
  it('truncates to the first of the month', () => {
    expect(firstOfMonth('2026-01-15')).toBe('2026-01-01')
    expect(firstOfMonth('2026-12-31')).toBe('2026-12-01')
    expect(firstOfMonth('2026-06-01')).toBe('2026-06-01')
  })
})

describe('countCalendarMonths', () => {
  it('counts months touched, inclusive', () => {
    expect(countCalendarMonths('2026-01-01', '2026-01-31')).toBe(1)
    expect(countCalendarMonths('2026-01-10', '2026-12-31')).toBe(12)
    // Mid-month start still touches both end months.
    expect(countCalendarMonths('2026-01-31', '2026-02-01')).toBe(2)
  })

  it('handles year boundaries and brutet räkenskapsår', () => {
    expect(countCalendarMonths('2026-11-15', '2027-02-14')).toBe(4)
    expect(countCalendarMonths('2026-07-01', '2027-06-30')).toBe(12)
  })

  it('throws when the end month precedes the start month', () => {
    expect(() => countCalendarMonths('2026-06-01', '2026-01-31')).toThrow()
  })
})

describe('listCalendarMonths', () => {
  it('lists first-of-month dates across a year boundary', () => {
    expect(listCalendarMonths('2026-11-15', '2027-02-14')).toEqual([
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ])
  })
})

describe('computeInstallmentAmounts', () => {
  it('splits evenly when the amount divides cleanly', () => {
    expect(computeInstallmentAmounts(12000, 12)).toEqual(Array(12).fill(1000))
  })

  it('distributes remainder öre from the first month and sums exactly', () => {
    const amounts = computeInstallmentAmounts(10000, 12)
    expect(amounts.slice(0, 4)).toEqual([833.34, 833.34, 833.34, 833.34])
    expect(amounts.slice(4)).toEqual(Array(8).fill(833.33))
    const sum = Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100
    expect(sum).toBe(10000)
  })

  it('sums exactly for awkward totals (property check)', () => {
    const cases: Array<[number, number]> = [
      [0.13, 12],
      [1, 3],
      [99.99, 7],
      [12345.67, 11],
      [50000, 36],
      [3333.33, 2],
    ]
    for (const [total, months] of cases) {
      const amounts = computeInstallmentAmounts(total, months)
      expect(amounts).toHaveLength(months)
      for (const amount of amounts) {
        expect(amount).toBeGreaterThan(0)
      }
      const sum = sumOre(amounts)
      expect(sum).toBe(total)
      // No installment differs by more than 1 öre from any other.
      const min = Math.min(...amounts)
      const max = Math.max(...amounts)
      expect(Math.round((max - min) * 100)).toBeLessThanOrEqual(1)
    }
  })

  it('rejects totals too small to give every month an öre', () => {
    expect(() => computeInstallmentAmounts(0.05, 12)).toThrow(/too small/i)
  })
})

describe('computeInstallments', () => {
  it('pairs months with amounts', () => {
    const plan = computeInstallments(12000, '2026-01-15', '2026-12-31')
    expect(plan).toHaveLength(12)
    expect(plan[0]).toEqual({ period_month: '2026-01-01', amount: 1000 })
    expect(plan[11]).toEqual({ period_month: '2026-12-01', amount: 1000 })
  })
})

describe('maxIsoDate / dayAfter', () => {
  it('returns the latest date and ignores null/undefined', () => {
    expect(maxIsoDate('2026-01-01', '2026-03-15', null, undefined)).toBe('2026-03-15')
    expect(maxIsoDate('2026-01-01')).toBe('2026-01-01')
    expect(() => maxIsoDate(null, undefined)).toThrow()
  })

  it('computes the day after across month and year boundaries', () => {
    expect(dayAfter('2026-03-31')).toBe('2026-04-01')
    expect(dayAfter('2026-12-31')).toBe('2027-01-01')
    expect(dayAfter('2026-02-28')).toBe('2026-03-01')
    expect(dayAfter('2028-02-28')).toBe('2028-02-29')
    expect(dayAfter('2026-06-14')).toBe('2026-06-15')
  })
})

describe('deferralReleaseDate', () => {
  it('keeps the first of the month when the schedule names no day', () => {
    expect(deferralReleaseDate('2026-09-01', null)).toBe('2026-09-01')
    expect(deferralReleaseDate('2026-09-01', undefined)).toBe('2026-09-01')
  })

  it('books on the named day of the month', () => {
    expect(deferralReleaseDate('2026-09-01', 14)).toBe('2026-09-14')
    expect(deferralReleaseDate('2026-12-01', 1)).toBe('2026-12-01')
  })

  it('clamps a day the month does not have to its last day (31 is every month end)', () => {
    expect(deferralReleaseDate('2026-02-01', 30)).toBe('2026-02-28')
    expect(deferralReleaseDate('2028-02-01', 31)).toBe('2028-02-29')
    expect(deferralReleaseDate('2026-04-01', 31)).toBe('2026-04-30')
    expect(deferralReleaseDate('2026-01-01', 31)).toBe('2026-01-31')
  })

  it('throws on a day outside 1-31', () => {
    expect(() => deferralReleaseDate('2026-01-01', 0)).toThrow()
    expect(() => deferralReleaseDate('2026-01-01', 32)).toThrow()
    expect(() => deferralReleaseDate('2026-01-01', 1.5)).toThrow()
  })
})

describe('replanPendingInstallments', () => {
  const posted = [
    { period_month: '2026-01-01', amount: 1000 },
    { period_month: '2026-02-01', amount: 1000 },
  ]

  it('splits the remainder equally over the months of the new period that have no posted month', () => {
    // 12 000 over Jan-Dec, Jan and Feb posted: 10 000 left, now over Mar-Jun.
    const plan = replanPendingInstallments({
      totalAmount: 12000,
      periodStart: '2026-01-01',
      periodEnd: '2026-06-30',
      posted,
    })
    expect(plan.map((p) => p.period_month)).toEqual(['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'])
    expect(plan.map((p) => p.amount)).toEqual([2500, 2500, 2500, 2500])
  })

  it('extends the period, and posted plus planned add up to the total to the öre', () => {
    const plan = replanPendingInstallments({
      totalAmount: 1000,
      periodStart: '2026-01-01',
      periodEnd: '2027-01-31',
      posted: [{ period_month: '2026-01-01', amount: 83.34 }],
    })
    expect(plan).toHaveLength(12)
    expect(plan[0].period_month).toBe('2026-02-01')
    expect(plan[11].period_month).toBe('2027-01-01')
    expect(sumOre([83.34, ...plan.map((p) => p.amount)])).toBe(1000)
    const amounts = plan.map((p) => Math.round(p.amount * 100))
    expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1)
  })

  it('plans around a posted month that is not the first (a stuck earlier month)', () => {
    const plan = replanPendingInstallments({
      totalAmount: 3000,
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      posted: [{ period_month: '2026-02-01', amount: 1000 }],
    })
    expect(plan).toEqual([
      { period_month: '2026-01-01', amount: 1000 },
      { period_month: '2026-03-01', amount: 1000 },
    ])
  })

  it('throws when a posted month lies after the new end, or no month is left', () => {
    expect(() =>
      replanPendingInstallments({ totalAmount: 12000, periodStart: '2026-01-01', periodEnd: '2026-01-31', posted }),
    ).toThrow(/after the new period end/)
    expect(() =>
      replanPendingInstallments({ totalAmount: 12000, periodStart: '2026-01-01', periodEnd: '2026-02-28', posted }),
    ).toThrow(/No month is left/)
  })
})
