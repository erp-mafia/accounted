/**
 * Divisor helpers for arbetsschema-lite (payroll gap-closure 4.1).
 *
 * The load-bearing assertion is the LEGACY-CONSTANT contract: at the default
 * schedule the helpers return 173/21 exactly (not the exact formulas), so
 * existing companies' pay math is byte-identical after the feature lands.
 */
import { describe, expect, it } from 'vitest'
import {
  dailyDivisor,
  defaultDayHours,
  hourlyDivisor,
  scheduledHoursPerDay,
} from '@/lib/salary/work-schedule'
import { deriveAbsenceLineItems } from '@/lib/salary/derive-absence-line-items'
import type { PayrollConfig } from '@/lib/salary/payroll-config'

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

describe('scheduledHoursPerDay', () => {
  it('is hours per week over workdays per week', () => {
    expect(scheduledHoursPerDay(40, 5)).toBe(8)
    expect(scheduledHoursPerDay(37.5, 5)).toBe(7.5)
    expect(scheduledHoursPerDay(20, 5)).toBe(4)
    expect(scheduledHoursPerDay(4, 1)).toBe(4)
    expect(scheduledHoursPerDay(24, 3)).toBe(8)
  })

  it('falls back per field to the 40 h / 5 d default when missing or not positive', () => {
    expect(scheduledHoursPerDay(null, null)).toBe(8)
    expect(scheduledHoursPerDay(undefined, undefined)).toBe(8)
    expect(scheduledHoursPerDay(0, 0)).toBe(8)
    expect(scheduledHoursPerDay(-4, -1)).toBe(8)
    expect(scheduledHoursPerDay(Number.NaN, Number.NaN)).toBe(8)
    expect(scheduledHoursPerDay(20, null)).toBe(4)
    expect(scheduledHoursPerDay(null, 4)).toBe(10)
  })

  it('is the expression run-calculation.ts used inline before it was shared', () => {
    const inline = (h: number, w: number) => (h > 0 ? h : 40) / (w > 0 ? w : 5)
    for (const h of [0, 4, 7.5, 20, 30, 37.5, 38, 40, 60, 80]) {
      for (const w of [0, 1, 2, 3, 4, 5, 6, 7]) {
        expect(scheduledHoursPerDay(h, w)).toBe(inline(h, w))
      }
    }
  })
})

describe('defaultDayHours', () => {
  it('is 8 at the default schedule and when the schedule is missing', () => {
    expect(defaultDayHours(40, 5)).toBe(8)
    expect(defaultDayHours(null, undefined)).toBe(8)
  })

  it("is the employee's scheduled day, not 8, on a part-time schedule", () => {
    expect(defaultDayHours(4, 1)).toBe(4)
    expect(defaultDayHours(20, 5)).toBe(4)
    expect(defaultDayHours(37.5, 5)).toBe(7.5)
    expect(defaultDayHours(38, 5)).toBe(7.6)
    expect(defaultDayHours(30, 4)).toBe(7.5)
  })

  it('rounds a repeating quotient UP to two decimals, never on float noise', () => {
    expect(defaultDayHours(40, 3)).toBe(13.34)
    expect(defaultDayHours(40, 6)).toBe(6.67)
    expect(defaultDayHours(40, 7)).toBe(5.72)
    // 38 / 5 * 100 is 760.0000000000001 in floating point.
    expect(defaultDayHours(38, 5)).toBe(7.6)
    expect(defaultDayHours(5.5, 5)).toBe(1.1)
  })

  it('never exceeds what the hours columns accept', () => {
    expect(defaultDayHours(80, 1)).toBe(24)
    expect(defaultDayHours(60, 2)).toBe(24)
  })

  it('always weighs as exactly one day in the engine, across schedules', () => {
    for (let hours = 0.5; hours <= 80; hours += 0.5) {
      for (let days = 1; days <= 7; days += 1) {
        const perDay = scheduledHoursPerDay(hours, days)
        if (perDay > 24) continue
        const entered = defaultDayHours(hours, days)
        // The engine's day share: min(1, hours / scheduled hours per day).
        expect(Math.min(1, entered / perDay)).toBe(1)
        expect(entered - perDay).toBeLessThan(0.01)
      }
    }
  })

  it('one default sick day on a 4 h, one-day week is ONE day in the derivation', () => {
    const config = { sjuklonRate: 0.8, karensavdragFactor: 0.2, maxKarensavdragPerYear: 10 } as PayrollConfig
    const result = deriveAbsenceLineItems({
      monthlySalary: 4000,
      payrollConfig: config,
      periodDays: [{ absence_date: '2026-08-12', absence_type: 'sick', hours: defaultDayHours(4, 1) }],
      lookbackSickDates: [],
      vabDaysYtd: 0,
      parentalDaysPregnancyYtd: 0,
      hoursPerDay: scheduledHoursPerDay(4, 1),
      hoursPerWeek: 4,
      workdaysPerWeek: 1,
      dailyDivisor: dailyDivisor(1),
    })
    expect(result.aggregated.sickDays).toBe(1)
    const sickPay = result.lineItems.filter(li => li.item_type === 'sick_day2_14')
    expect(sickPay).toHaveLength(1)
    expect(sickPay[0].quantity).toBe(1)
    expect(result.lineItems.filter(li => li.item_type === 'sick_karens')).toHaveLength(1)
  })
})
