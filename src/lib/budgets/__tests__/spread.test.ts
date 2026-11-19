import { describe, expect, it } from 'vitest'
import { roundOre } from '@/lib/money'
import { fiscalYearMonths } from '../months'
import { profileFromActuals, spreadByProfile, spreadEvenly } from '../spread'

const YEAR_2027 = fiscalYearMonths('2027-01-01', '2027-12-31')
const sum = (xs: { amount: number }[]) => roundOre(xs.reduce((s, x) => s + x.amount, 0))

describe('spreadEvenly', () => {
  it('gives every month the same öre amount and the remainder to the last month', () => {
    const months = spreadEvenly(100, YEAR_2027)
    expect(months).toHaveLength(12)
    expect(months.slice(0, 11).every((m) => m.amount === 8.33)).toBe(true)
    expect(months[11]).toEqual({ month: '2027-12', amount: 8.37 })
    expect(sum(months)).toBe(100)
  })

  it('adds up exactly for revenue (negative, SIE sign) and odd amounts', () => {
    for (const total of [-1_200_000, -1_000_000.01, 0.05, 999_999.99, -7]) {
      const months = spreadEvenly(total, YEAR_2027)
      expect(sum(months), String(total)).toBe(total)
      for (const m of months) expect(roundOre(m.amount)).toBe(m.amount)
    }
  })

  it('spreads over the months a short or long year holds', () => {
    const short = spreadEvenly(700, fiscalYearMonths('2026-06-15', '2026-12-31'))
    expect(short.map((m) => m.month)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'])
    expect(short.every((m) => m.amount === 100)).toBe(true)
    expect(spreadEvenly(1800, fiscalYearMonths('2026-07-01', '2027-12-31'))).toHaveLength(18)
  })

  it('answers no months for no months', () => {
    expect(spreadEvenly(100, [])).toEqual([])
  })
})

describe('spreadByProfile', () => {
  it('follows last year\'s season by calendar month, remainder last', () => {
    // Last year: all revenue in the summer.
    const profile = profileFromActuals([
      { month: '2026-06', amount: -300 },
      { month: '2026-07', amount: -600 },
      { month: '2026-08', amount: -100 },
    ])
    const { months, fellBackToEven } = spreadByProfile(-1000, YEAR_2027, profile)
    expect(fellBackToEven).toBe(false)
    const byMonth = Object.fromEntries(months.map((m) => [m.month, m.amount]))
    expect(byMonth['2027-06']).toBe(-300)
    expect(byMonth['2027-07']).toBe(-600)
    expect(byMonth['2027-08']).toBe(-100)
    // December, the last month, takes the remainder: none here.
    expect(byMonth['2027-12']).toBe(0)
    expect(byMonth['2027-01']).toBe(0)
    expect(sum(months)).toBe(-1000)
  })

  it('rounds each month to öre and puts the öre remainder in the last month', () => {
    const profile = profileFromActuals(YEAR_2027.map((m) => ({ month: m.replace('2027', '2026'), amount: 1 })))
    const { months } = spreadByProfile(100, YEAR_2027, profile)
    expect(months.slice(0, 11).every((m) => m.amount === 8.33)).toBe(true)
    expect(months[11]!.amount).toBe(8.37)
  })

  it('falls back to even when last year sums to zero', () => {
    const profile = profileFromActuals([
      { month: '2026-03', amount: 500 },
      { month: '2026-04', amount: -500 },
    ])
    const result = spreadByProfile(1200, YEAR_2027, profile)
    expect(result.fellBackToEven).toBe(true)
    expect(result.months.every((m) => m.amount === 100)).toBe(true)
  })

  it('gives a month booked against the year no share, so a near-cancelling year cannot blow up', () => {
    // A cost account with a credit note month: +5000, -4990. Weights by
    // r / sum would make January 500 times the yearly amount.
    const profile = profileFromActuals([
      { month: '2026-01', amount: 5000 },
      { month: '2026-02', amount: -4990 },
    ])
    const { months, fellBackToEven } = spreadByProfile(12000, YEAR_2027, profile)
    expect(fellBackToEven).toBe(false)
    expect(months.find((m) => m.month === '2027-01')!.amount).toBe(12000)
    expect(months.find((m) => m.month === '2027-02')!.amount).toBe(0)
    expect(Math.max(...months.map((m) => Math.abs(m.amount)))).toBe(12000)
    expect(sum(months)).toBe(12000)
  })

  it('falls back to even without any history', () => {
    const result = spreadByProfile(1200, YEAR_2027, new Map())
    expect(result.fellBackToEven).toBe(true)
    expect(sum(result.months)).toBe(1200)
  })

  it('normalises over the budget year\'s own months when the source year was longer', () => {
    // An 18-month source year holds January twice; the later one wins.
    const profile = profileFromActuals([
      { month: '2025-01', amount: 999 },
      { month: '2026-01', amount: 100 },
      { month: '2026-02', amount: 100 },
    ])
    expect(profile.get('01')).toBe(100)
    const { months } = spreadByProfile(1000, YEAR_2027, profile)
    expect(months.find((m) => m.month === '2027-01')!.amount).toBe(500)
    expect(sum(months)).toBe(1000)
  })
})
