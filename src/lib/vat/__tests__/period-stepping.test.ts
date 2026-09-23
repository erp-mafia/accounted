import { describe, it, expect } from 'vitest'
import { compareVatPeriods, currentVatPeriod, nextVatPeriod } from '../period-defaults'

// Local-time Date(y, m, d) on purpose: see period-defaults.test.ts.

describe('currentVatPeriod', () => {
  it('returns the running quarter and month', () => {
    const today = new Date(2026, 8, 17) // 2026-09-17
    expect(currentVatPeriod('quarterly', today)).toEqual({ year: 2026, period: 3 })
    expect(currentVatPeriod('monthly', today)).toEqual({ year: 2026, period: 9 })
  })
})

describe('nextVatPeriod', () => {
  it('steps within the year', () => {
    expect(nextVatPeriod('quarterly', { year: 2026, period: 2 })).toEqual({ year: 2026, period: 3 })
    expect(nextVatPeriod('monthly', { year: 2026, period: 6 })).toEqual({ year: 2026, period: 7 })
  })

  it('rolls over the year boundary', () => {
    expect(nextVatPeriod('quarterly', { year: 2025, period: 4 })).toEqual({ year: 2026, period: 1 })
    expect(nextVatPeriod('monthly', { year: 2025, period: 12 })).toEqual({ year: 2026, period: 1 })
  })
})

describe('compareVatPeriods', () => {
  it('orders by year, then period', () => {
    expect(compareVatPeriods({ year: 2025, period: 4 }, { year: 2026, period: 1 })).toBeLessThan(0)
    expect(compareVatPeriods({ year: 2026, period: 2 }, { year: 2026, period: 2 })).toBe(0)
    expect(compareVatPeriods({ year: 2026, period: 3 }, { year: 2026, period: 2 })).toBeGreaterThan(0)
  })
})
