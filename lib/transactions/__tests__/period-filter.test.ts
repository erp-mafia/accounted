import { describe, it, expect } from 'vitest'
import {
  quarterBounds,
  resolvePeriodBounds,
  isWithinBounds,
  QUARTERS,
} from '@/lib/transactions/period-filter'

const calendarYear = { period_start: '2026-01-01', period_end: '2026-12-31' }
// Brutet rakenskapsar: the reporter's July-June case.
const brokenYear = { period_start: '2025-07-01', period_end: '2026-06-30' }
// Shortened first year (6 months).
const shortYear = { period_start: '2026-01-01', period_end: '2026-06-30' }
// Extended first year (18 months).
const extendedYear = { period_start: '2025-01-01', period_end: '2026-06-30' }

describe('quarterBounds', () => {
  it('splits a calendar fiscal year into calendar quarters', () => {
    expect(quarterBounds(calendarYear, 1)).toEqual({ start: '2026-01-01', end: '2026-03-31' })
    expect(quarterBounds(calendarYear, 2)).toEqual({ start: '2026-04-01', end: '2026-06-30' })
    expect(quarterBounds(calendarYear, 3)).toEqual({ start: '2026-07-01', end: '2026-09-30' })
    expect(quarterBounds(calendarYear, 4)).toEqual({ start: '2026-10-01', end: '2026-12-31' })
  })

  it('follows the fiscal year for a brutet rakenskapsar (July-June)', () => {
    expect(quarterBounds(brokenYear, 1)).toEqual({ start: '2025-07-01', end: '2025-09-30' })
    expect(quarterBounds(brokenYear, 2)).toEqual({ start: '2025-10-01', end: '2025-12-31' })
    expect(quarterBounds(brokenYear, 3)).toEqual({ start: '2026-01-01', end: '2026-03-31' })
    expect(quarterBounds(brokenYear, 4)).toEqual({ start: '2026-04-01', end: '2026-06-30' })
  })

  it('returns null for quarters beyond a shortened period', () => {
    expect(quarterBounds(shortYear, 1)).toEqual({ start: '2026-01-01', end: '2026-03-31' })
    expect(quarterBounds(shortYear, 2)).toEqual({ start: '2026-04-01', end: '2026-06-30' })
    expect(quarterBounds(shortYear, 3)).toBeNull()
    expect(quarterBounds(shortYear, 4)).toBeNull()
  })

  it('clamps a quarter end that would pass period_end', () => {
    const fiveMonths = { period_start: '2026-01-01', period_end: '2026-05-31' }
    expect(quarterBounds(fiveMonths, 2)).toEqual({ start: '2026-04-01', end: '2026-05-31' })
  })

  it('lets Q4 absorb the tail of an extended fiscal year', () => {
    expect(quarterBounds(extendedYear, 4)).toEqual({ start: '2025-10-01', end: '2026-06-30' })
  })

  it('covers every day of a regular period across the four quarters', () => {
    for (const period of [calendarYear, brokenYear]) {
      const bounds = QUARTERS.map((q) => quarterBounds(period, q))
      expect(bounds[0]?.start).toBe(period.period_start)
      expect(bounds[3]?.end).toBe(period.period_end)
      for (let i = 1; i < 4; i++) {
        const prevEnd = bounds[i - 1]?.end
        const nextStart = bounds[i]?.start
        expect(prevEnd).toBeDefined()
        expect(nextStart).toBeDefined()
        // Next quarter starts the day after the previous one ends.
        const followingDay = new Date(`${prevEnd}T00:00:00Z`)
        followingDay.setUTCDate(followingDay.getUTCDate() + 1)
        expect(nextStart).toBe(followingDay.toISOString().slice(0, 10))
      }
    }
  })

  it('handles a period start that is not the first of a month', () => {
    const midMonth = { period_start: '2026-01-15', period_end: '2027-01-14' }
    expect(quarterBounds(midMonth, 1)).toEqual({ start: '2026-01-15', end: '2026-04-14' })
    expect(quarterBounds(midMonth, 2)).toEqual({ start: '2026-04-15', end: '2026-07-14' })
  })
})

describe('resolvePeriodBounds', () => {
  it('returns null without a period', () => {
    expect(resolvePeriodBounds(null, null)).toBeNull()
    expect(resolvePeriodBounds(null, 2)).toBeNull()
  })

  it('returns the whole period without a quarter', () => {
    expect(resolvePeriodBounds(brokenYear, null)).toEqual({
      start: '2025-07-01',
      end: '2026-06-30',
    })
  })

  it('returns quarter bounds with a quarter', () => {
    expect(resolvePeriodBounds(calendarYear, 3)).toEqual({
      start: '2026-07-01',
      end: '2026-09-30',
    })
  })

  it('returns null for a quarter outside the period', () => {
    expect(resolvePeriodBounds(shortYear, 4)).toBeNull()
  })
})

describe('isWithinBounds', () => {
  const bounds = { start: '2026-01-01', end: '2026-03-31' }

  it('accepts everything when no bounds are set', () => {
    expect(isWithinBounds('1999-01-01', null)).toBe(true)
  })

  it('includes both endpoints', () => {
    expect(isWithinBounds('2026-01-01', bounds)).toBe(true)
    expect(isWithinBounds('2026-03-31', bounds)).toBe(true)
  })

  it('excludes dates outside the bounds', () => {
    expect(isWithinBounds('2025-12-31', bounds)).toBe(false)
    expect(isWithinBounds('2026-04-01', bounds)).toBe(false)
  })
})
