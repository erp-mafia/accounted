/**
 * Divisor helpers for arbetsschema-lite (payroll gap-closure 4.1).
 *
 * The load-bearing assertion is the LEGACY-CONSTANT contract: at the default
 * schedule the helpers return 173/21 exactly (not the exact formulas), so
 * existing companies' pay math is byte-identical after the feature lands.
 */
import { describe, expect, it } from 'vitest'
import { dailyDivisor, hourlyDivisor } from '@/lib/salary/work-schedule'

describe('hourlyDivisor', () => {
  it('returns the legacy constant 173 at the 40h default (compat contract)', () => {
    expect(hourlyDivisor(40)).toBe(173)
    // Exact formula would be 173.33: asserting the difference keeps the
    // discontinuity deliberate rather than accidental.
    expect(hourlyDivisor(40)).not.toBeCloseTo((40 * 52) / 12, 2)
  })

  it('uses the exact formula for non-default schedules', () => {
    expect(hourlyDivisor(32)).toBe(138.67)
    expect(hourlyDivisor(20)).toBe(86.67)
    expect(hourlyDivisor(60)).toBe(260)
  })

  it('treats null/undefined as the default schedule', () => {
    expect(hourlyDivisor(null)).toBe(173)
    expect(hourlyDivisor(undefined)).toBe(173)
  })
})

describe('dailyDivisor', () => {
  it('returns the legacy constant 21 at the 5-day default (compat contract)', () => {
    expect(dailyDivisor(5)).toBe(21)
    expect(dailyDivisor(5)).not.toBeCloseTo((5 * 52) / 12, 2)
  })

  it('uses the exact formula for non-default schedules', () => {
    expect(dailyDivisor(4)).toBe(17.33)
    expect(dailyDivisor(3)).toBe(13)
    expect(dailyDivisor(6)).toBe(26)
  })

  it('treats null/undefined as the default schedule', () => {
    expect(dailyDivisor(null)).toBe(21)
    expect(dailyDivisor(undefined)).toBe(21)
  })
})
