import { describe, it, expect } from 'vitest'
import { computePremiumLines } from '../shift-premium-engine'
import type { ShiftPremiumRule } from '@/types'

const baseRule = (overrides: Partial<ShiftPremiumRule> = {}): ShiftPremiumRule => ({
  id: 'rule-1',
  company_id: 'co-1',
  name: '',
  applies_to_all_employees: true,
  applies_to_employee_ids: [],
  day_of_week: [1, 2, 3, 4, 5, 6, 7],
  start_time: '00:00',
  end_time: '00:00',
  premium_percent: 25,
  item_type: 'ob_weekday_evening',
  priority: 0,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: null,
  ...overrides,
})

const r2 = (n: number) => Math.round(n * 100) / 100

describe('computePremiumLines — basic semantics', () => {
  it('returns no lines when there are no rules', () => {
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      workedDays: [{ work_date: '2026-05-25', hours: 8, start_time: '09:00', end_time: '17:00' }],
      rules: [],
    })
    expect(result).toEqual([])
  })

  it('returns no lines when there are no worked days', () => {
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      workedDays: [],
      rules: [baseRule()],
    })
    expect(result).toEqual([])
  })

  it('standard weekday 09:00-17:00 with no matching rule yields no premium', () => {
    const eveningRule = baseRule({
      id: 'r-evening',
      day_of_week: [1, 2, 3, 4, 5],
      start_time: '18:00',
      end_time: '22:00',
      premium_percent: 25,
      item_type: 'ob_weekday_evening',
    })
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      // 2026-05-25 is a Monday
      workedDays: [{ work_date: '2026-05-25', hours: 8, start_time: '09:00', end_time: '17:00' }],
      rules: [eveningRule],
    })
    expect(result).toEqual([])
  })
})

describe('computePremiumLines — weekend rule', () => {
  it('Saturday 06:00-22:00 with 33% rule generates 8h × 33% premium', () => {
    const weekendRule = baseRule({
      id: 'r-weekend',
      name: 'Lördag',
      day_of_week: [6],
      start_time: '06:00',
      end_time: '22:00',
      premium_percent: 33,
      item_type: 'ob_weekend',
    })
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 250,
      // 2026-05-23 = Saturday (Sat 23 May 2026)
      workedDays: [{ work_date: '2026-05-23', hours: 8, start_time: '08:00', end_time: '16:00' }],
      rules: [weekendRule],
    })
    expect(result).toHaveLength(1)
    expect(result[0].itemType).toBe('ob_weekend')
    expect(result[0].hours).toBe(8)
    // 250 × 8 × 0.33 = 660
    expect(result[0].amount).toBe(r2(250 * 8 * 0.33))
    expect(result[0].sourceRuleId).toBe('r-weekend')
  })

  it('Sunday full-day with 100% rule pays full premium', () => {
    const sundayRule = baseRule({
      id: 'r-sunday',
      day_of_week: [7],
      start_time: '00:00',
      end_time: '00:00', // full-day special-case (00:00 to 00:00 = 24h)
      premium_percent: 100,
      item_type: 'ob_holiday',
    })
    // 2026-05-24 = Sunday
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      workedDays: [{ work_date: '2026-05-24', hours: 8, start_time: '09:00', end_time: '17:00' }],
      rules: [sundayRule],
    })
    expect(result).toHaveLength(1)
    expect(result[0].itemType).toBe('ob_holiday')
    expect(result[0].hours).toBe(8)
    expect(result[0].amount).toBe(r2(200 * 8 * 1.0))
  })
})

describe('computePremiumLines — holiday gating for ob_holiday', () => {
  it('ob_holiday fires on Midsommarafton 2025 (Friday, June 20) but not on a regular Sunday', () => {
    const holidayRule = baseRule({
      id: 'r-holiday',
      name: 'OB helgdag',
      day_of_week: [1, 2, 3, 4, 5, 6, 7], // all days — gating is by holiday calendar, not weekday
      start_time: '00:00',
      end_time: '00:00', // full 24h window
      premium_percent: 100,
      item_type: 'ob_holiday',
    })

    // Midsommarafton 2025 is Friday 20 June — a Swedish public holiday despite being a weekday.
    const midsommarafton = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 250,
      workedDays: [{ work_date: '2025-06-20', hours: 8, start_time: '08:00', end_time: '16:00' }],
      rules: [holidayRule],
    })
    expect(midsommarafton).toHaveLength(1)
    expect(midsommarafton[0].itemType).toBe('ob_holiday')
    expect(midsommarafton[0].hours).toBe(8)
    expect(midsommarafton[0].amount).toBe(r2(250 * 8 * 1.0))

    // A regular Sunday — 2026-05-31 is a plain Sunday (after Pingstdagen on the 24th), not a holiday.
    // The same rule must NOT fire because day_of_week matching alone is not enough for ob_holiday.
    const regularSunday = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 250,
      workedDays: [{ work_date: '2026-05-31', hours: 8, start_time: '08:00', end_time: '16:00' }],
      rules: [holidayRule],
    })
    expect(regularSunday).toEqual([])
  })
})

describe('computePremiumLines — night shift crossing midnight', () => {
  it('22:00-06:00 night rule covers both halves correctly', () => {
    const nightRule = baseRule({
      id: 'r-night',
      day_of_week: [1, 2, 3, 4, 5, 6, 7],
      start_time: '22:00',
      end_time: '06:00',
      premium_percent: 50,
      item_type: 'ob_night',
    })
    // Shift 22:00-06:00 on Monday → wraps into Tuesday
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 300,
      workedDays: [{ work_date: '2026-05-25', hours: 8, start_time: '22:00', end_time: '06:00' }],
      rules: [nightRule],
    })
    expect(result).toHaveLength(1)
    expect(result[0].hours).toBe(8)
    // 300 × 8 × 0.5 = 1200
    expect(result[0].amount).toBe(r2(300 * 8 * 0.5))
  })

  it('shift 18:00-04:00 with night rule 22:00-06:00 only awards 6h (22-04)', () => {
    const nightRule = baseRule({
      id: 'r-night',
      day_of_week: [1, 2, 3, 4, 5, 6, 7],
      start_time: '22:00',
      end_time: '06:00',
      premium_percent: 50,
      item_type: 'ob_night',
    })
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      workedDays: [{ work_date: '2026-05-25', hours: 10, start_time: '18:00', end_time: '04:00' }],
      rules: [nightRule],
    })
    expect(result).toHaveLength(1)
    // 22:00→24:00 = 2h, 00:00→04:00 = 4h, total 6h
    expect(result[0].hours).toBe(6)
    expect(result[0].amount).toBe(r2(200 * 6 * 0.5))
  })
})

describe('computePremiumLines — partial overlap', () => {
  it('weekday rule 18:00-22:00 with shift 16:00-22:00 generates 4h premium', () => {
    const eveningRule = baseRule({
      id: 'r-eve',
      day_of_week: [1, 2, 3, 4, 5],
      start_time: '18:00',
      end_time: '22:00',
      premium_percent: 25,
      item_type: 'ob_weekday_evening',
    })
    // 2026-05-25 = Monday
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 250,
      workedDays: [{ work_date: '2026-05-25', hours: 6, start_time: '16:00', end_time: '22:00' }],
      rules: [eveningRule],
    })
    expect(result).toHaveLength(1)
    expect(result[0].hours).toBe(4)
    expect(result[0].amount).toBe(r2(250 * 4 * 0.25))
  })
})

describe('computePremiumLines — overlapping rules', () => {
  it('priority wins when two rules cover the same interval', () => {
    const lowPriority = baseRule({
      id: 'r-low',
      day_of_week: [6],
      start_time: '08:00',
      end_time: '18:00',
      premium_percent: 33,
      item_type: 'ob_weekend',
      priority: 0,
    })
    const highPriority = baseRule({
      id: 'r-high',
      day_of_week: [6],
      start_time: '10:00',
      end_time: '14:00',
      premium_percent: 100,
      item_type: 'ob_holiday',
      priority: 10,
    })
    // 2026-10-31 = Saturday AND Alla helgons dag → both ob_weekend and ob_holiday rules are eligible.
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      workedDays: [{ work_date: '2026-10-31', hours: 10, start_time: '08:00', end_time: '18:00' }],
      rules: [lowPriority, highPriority],
    })
    // Expect: 6h low (08-10 + 14-18) + 4h high (10-14).
    expect(result).toHaveLength(2)
    const low = result.find((r) => r.sourceRuleId === 'r-low')
    const high = result.find((r) => r.sourceRuleId === 'r-high')
    expect(low?.hours).toBe(6)
    expect(high?.hours).toBe(4)
    // Total premium hours = 6 + 4 = 10 (no double count)
    expect((low?.hours ?? 0) + (high?.hours ?? 0)).toBe(10)
  })

  it('ties broken by higher premium_percent when priority equal', () => {
    const a = baseRule({
      id: 'r-a',
      day_of_week: [6],
      start_time: '08:00',
      end_time: '18:00',
      premium_percent: 33,
      item_type: 'ob_weekend',
      priority: 0,
    })
    const b = baseRule({
      id: 'r-b',
      day_of_week: [6],
      start_time: '08:00',
      end_time: '18:00',
      premium_percent: 50,
      item_type: 'ob_weekend',
      priority: 0,
    })
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      workedDays: [{ work_date: '2026-05-23', hours: 10, start_time: '08:00', end_time: '18:00' }],
      rules: [a, b],
    })
    expect(result).toHaveLength(1)
    expect(result[0].sourceRuleId).toBe('r-b')
    expect(result[0].hours).toBe(10)
  })
})

describe('computePremiumLines — hours-only fallback', () => {
  it('hours-only worked day uses default 08:00-17:00 — only weekday-daytime rules match', () => {
    const eveningRule = baseRule({
      id: 'r-eve',
      day_of_week: [1, 2, 3, 4, 5],
      start_time: '18:00',
      end_time: '22:00',
      premium_percent: 25,
      item_type: 'ob_weekday_evening',
    })
    const middayRule = baseRule({
      id: 'r-day',
      day_of_week: [1, 2, 3, 4, 5],
      start_time: '10:00',
      end_time: '14:00',
      premium_percent: 10,
      item_type: 'ob_weekday_evening',
    })
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      workedDays: [{ work_date: '2026-05-25', hours: 8 }], // no times → default 08-17
      rules: [eveningRule, middayRule],
    })
    // Evening rule must NOT match (18-22 outside 08-17). Mid-day rule matches 10-14.
    expect(result).toHaveLength(1)
    expect(result[0].sourceRuleId).toBe('r-day')
    expect(result[0].hours).toBe(4)
  })
})

describe('computePremiumLines — employee filtering', () => {
  it('employee-specific rule does not apply to other employees', () => {
    const rule = baseRule({
      id: 'r-specific',
      applies_to_all_employees: false,
      applies_to_employee_ids: ['emp-2'],
      day_of_week: [6],
      start_time: '06:00',
      end_time: '22:00',
      premium_percent: 33,
      item_type: 'ob_weekend',
    })
    const wrongEmp = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      workedDays: [{ work_date: '2026-05-23', hours: 8, start_time: '09:00', end_time: '17:00' }],
      rules: [rule],
    })
    expect(wrongEmp).toEqual([])

    const rightEmp = computePremiumLines({
      employeeId: 'emp-2',
      baseHourlyRate: 200,
      workedDays: [{ work_date: '2026-05-23', hours: 8, start_time: '09:00', end_time: '17:00' }],
      rules: [rule],
    })
    expect(rightEmp).toHaveLength(1)
    expect(rightEmp[0].hours).toBe(8)
  })

  it('inactive rules are ignored', () => {
    const rule = baseRule({
      id: 'r-inactive',
      day_of_week: [6],
      start_time: '06:00',
      end_time: '22:00',
      premium_percent: 33,
      item_type: 'ob_weekend',
      is_active: false,
    })
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      workedDays: [{ work_date: '2026-05-23', hours: 8, start_time: '09:00', end_time: '17:00' }],
      rules: [rule],
    })
    expect(result).toEqual([])
  })
})

describe('computePremiumLines — multiple worked days', () => {
  it('emits one line per (workDate × winning rule)', () => {
    const weekendRule = baseRule({
      id: 'r-weekend',
      day_of_week: [6, 7],
      start_time: '00:00',
      end_time: '00:00',
      premium_percent: 50,
      item_type: 'ob_weekend',
    })
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      workedDays: [
        { work_date: '2026-05-23', hours: 8, start_time: '08:00', end_time: '16:00' },
        { work_date: '2026-05-24', hours: 8, start_time: '08:00', end_time: '16:00' },
      ],
      rules: [weekendRule],
    })
    expect(result).toHaveLength(2)
    expect(result[0].workDate).toBe('2026-05-23')
    expect(result[1].workDate).toBe('2026-05-24')
    expect(result.every((r) => r.hours === 8)).toBe(true)
  })
})

describe('computePremiumLines — invalid inputs', () => {
  it('zero hourly rate yields no premium', () => {
    const rule = baseRule({ day_of_week: [6], start_time: '06:00', end_time: '22:00', item_type: 'ob_weekend' })
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 0,
      workedDays: [{ work_date: '2026-05-23', hours: 8, start_time: '08:00', end_time: '16:00' }],
      rules: [rule],
    })
    expect(result).toEqual([])
  })

  it('worked day with zero hours is ignored', () => {
    const rule = baseRule({ day_of_week: [6], start_time: '06:00', end_time: '22:00', item_type: 'ob_weekend' })
    const result = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      workedDays: [{ work_date: '2026-05-23', hours: 0, start_time: '08:00', end_time: '16:00' }],
      rules: [rule],
    })
    expect(result).toEqual([])
  })
})
