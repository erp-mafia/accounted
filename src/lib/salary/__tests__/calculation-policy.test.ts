import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SALARY_CALCULATION_POLICY,
  SALARY_CALCULATION_POLICY_KEYS,
  SALARY_CALCULATION_POLICY_OPTIONS,
  SalaryCalculationPolicyPatchSchema,
  SalaryCalculationPolicySchema,
} from '../calculation-policy'
import {
  groupOneOffBasesByRate,
  oneOffTaxForGroup,
  validateOneOffTaxLine,
} from '../one-off-tax'
import { calendarLeaveDeduction } from '../calendar-leave'
import { monthlyBaseSalary } from '../calculation-engine'
import type { AbsenceDay } from '../derive-absence-line-items'

describe('SalaryCalculationPolicySchema', () => {
  it('fills every convention with its default from an empty object (the historical engine)', () => {
    expect(SalaryCalculationPolicySchema.parse({})).toEqual({
      partial_month: 'workdays',
      sick_rate: 'daily_divisor',
      long_leave: 'workdays',
      leave_context: 'all_registered',
      net_rounding: 'up',
      one_off_tax_rounding: 'truncate',
    })
    expect(DEFAULT_SALARY_CALCULATION_POLICY).toEqual(SalaryCalculationPolicySchema.parse({}))
  })

  it('keeps the first option of every convention as its default', () => {
    for (const key of SALARY_CALCULATION_POLICY_KEYS) {
      expect(DEFAULT_SALARY_CALCULATION_POLICY[key]).toBe(SALARY_CALCULATION_POLICY_OPTIONS[key][0])
    }
  })

  it('rejects misspelled or unsupported conventions and unknown keys', () => {
    expect(() => SalaryCalculationPolicySchema.parse({ partial_month: 'calender' })).toThrow()
    expect(() => SalaryCalculationPolicySchema.parse({ unknown: 1 })).toThrow()
    expect(() => SalaryCalculationPolicySchema.parse({ sick_rate: 'daily' })).toThrow()
    expect(() => SalaryCalculationPolicySchema.parse([])).toThrow()
  })

  it('patch schema carries only the supplied keys, without defaults', () => {
    expect(SalaryCalculationPolicyPatchSchema.parse({ sick_rate: 'annual_hourly' })).toEqual({
      sick_rate: 'annual_hourly',
    })
    expect(SalaryCalculationPolicyPatchSchema.parse({})).toEqual({})
    expect(SalaryCalculationPolicyPatchSchema.safeParse({ net_rounding: 'down' }).success).toBe(false)
    expect(SalaryCalculationPolicyPatchSchema.safeParse({ extra: 'x' }).success).toBe(false)
  })
})

describe('one-off tax helpers', () => {
  const base = {
    item_type: 'bonus',
    amount: 5000,
    is_taxable: true,
    is_gross_deduction: false,
    is_net_deduction: false,
  }

  it('accepts a percentage on a positive taxable addition of an eligible type', () => {
    for (const item_type of ['bonus', 'commission', 'other', 'correction', 'semesterersattning']) {
      expect(validateOneOffTaxLine({ ...base, item_type, one_off_tax_percent: 30 })).toBeNull()
    }
    expect(validateOneOffTaxLine({ ...base, one_off_tax_percent: 0 })).toBeNull()
    expect(validateOneOffTaxLine({ ...base, one_off_tax_percent: 100 })).toBeNull()
  })

  it('a line without a percentage is always acceptable', () => {
    expect(validateOneOffTaxLine({ ...base, one_off_tax_percent: null })).toBeNull()
    expect(validateOneOffTaxLine({ ...base, item_type: 'benefit_car', amount: -1, is_net_deduction: true })).toBeNull()
  })

  it('rejects the percentage on deductions, benefits, non-taxable rows, non-positive amounts and out-of-range rates', () => {
    const bad = [
      { ...base, one_off_tax_percent: 101 },
      { ...base, one_off_tax_percent: -0.5 },
      { ...base, one_off_tax_percent: Number.NaN },
      { ...base, one_off_tax_percent: 30, amount: 0 },
      { ...base, one_off_tax_percent: 30, amount: -2500 },
      { ...base, one_off_tax_percent: 30, is_taxable: false },
      { ...base, one_off_tax_percent: 30, is_gross_deduction: true },
      { ...base, one_off_tax_percent: 30, is_net_deduction: true },
      { ...base, one_off_tax_percent: 30, item_type: 'benefit_car' },
      { ...base, one_off_tax_percent: 30, item_type: 'overtime' },
    ]
    for (const line of bad) expect(validateOneOffTaxLine(line)).toMatch(/Engångsskatt/)
  })

  it('groups bases per rate in öre-exact arithmetic', () => {
    const grouped = groupOneOffBasesByRate([
      { amount: 0.1, oneOffTaxPercent: 30 },
      { amount: 0.2, oneOffTaxPercent: 30 },
      { amount: 1000, oneOffTaxPercent: 34 },
      { amount: 999, oneOffTaxPercent: null },
      { amount: 5 },
    ])
    expect([...grouped]).toEqual([
      [30, 0.3],
      [34, 1000],
    ])
  })

  it('truncates by statute and rounds to nearest only as the compatibility convention', () => {
    expect(oneOffTaxForGroup(1001.99, 32, 'truncate')).toBe(320)
    expect(oneOffTaxForGroup(1001.99, 32, 'nearest')).toBe(321)
    expect(oneOffTaxForGroup(4, 34, 'truncate')).toBe(1)
    expect(oneOffTaxForGroup(2, 34, 'truncate')).toBe(0)
    expect(oneOffTaxForGroup(0.4, 34, 'nearest')).toBe(0)
  })
})

/** Mon-Fri rows between two dates, one leave type, same hours. */
const weekdays = (start: string, end: string, hours = 8, type: AbsenceDay['absence_type'] = 'parental'): AbsenceDay[] => {
  const rows: AbsenceDay[] = []
  for (let ms = Date.parse(`${start}T00:00:00Z`); ms <= Date.parse(`${end}T00:00:00Z`); ms += 86_400_000) {
    if (new Date(ms).getUTCDay() % 6 !== 0) {
      rows.push({ absence_date: new Date(ms).toISOString().slice(0, 10), absence_type: type, hours })
    }
  }
  return rows
}

describe('calendarLeaveDeduction (long_leave = calendar_after_five_workdays)', () => {
  // July 2037: the 1st is a Wednesday, the 13th a Monday. 50 000 kr: daily
  // rate 2 380,95 (/21), calendar rate 1 643,84 (× 12 / 365).
  const input = { monthlySalary: 50000, hoursPerDay: 8, dailyDivisor: 21, periodStart: '2037-07-01', periodEnd: '2037-07-31' }

  it('prices an episode of at most five working days per working day', () => {
    expect(calendarLeaveDeduction({ ...input, days: weekdays('2037-07-13', '2037-07-17') })).toBe(11904.75)
  })

  it('prices a longer episode per calendar day, intervening weekends included', () => {
    expect(calendarLeaveDeduction({ ...input, days: weekdays('2037-07-02', '2037-07-17') })).toBe(26301.44)
  })

  it('lets prior-month context lengthen the episode without deducting the prior-month days again', () => {
    expect(calendarLeaveDeduction({ ...input, days: weekdays('2037-06-15', '2037-07-03') })).toBe(4931.52)
  })

  it('deducts exactly one monthly salary for a complete calendar month', () => {
    expect(calendarLeaveDeduction({ ...input, days: weekdays('2037-06-15', '2037-08-10') })).toBe(50000)
  })

  it('weights a complete month of partial leave by its extent', () => {
    expect(calendarLeaveDeduction({ ...input, days: weekdays('2037-07-01', '2037-07-31', 2) })).toBe(12500)
  })

  it('does not bridge an unreported working day', () => {
    expect(
      calendarLeaveDeduction({ ...input, days: [...weekdays('2037-07-02', '2037-07-03'), ...weekdays('2037-07-09', '2037-07-10')] }),
    ).toBe(9523.8)
  })

  it('never charges a whole monthly salary for a partial deviation window', () => {
    expect(
      calendarLeaveDeduction({ ...input, periodStart: '2037-07-13', periodEnd: '2037-07-17', days: weekdays('2037-07-13', '2037-07-17') }),
    ).toBe(11904.75)
  })

  it('prices sick day 15+ per calendar day from the first day (calendarFromStart)', () => {
    expect(calendarLeaveDeduction({ ...input, days: weekdays('2037-07-13', '2037-07-15', 8, 'sick'), calendarFromStart: true })).toBe(
      4931.52,
    )
  })

  it('caps several rows on one date at a full day and treats a row without hours as a full day', () => {
    const doubled = [...weekdays('2037-07-13', '2037-07-17'), ...weekdays('2037-07-13', '2037-07-17')]
    expect(calendarLeaveDeduction({ ...input, days: doubled })).toBe(11904.75)
    const noHours = weekdays('2037-07-13', '2037-07-17').map(d => ({ ...d, hours: 0 }))
    expect(calendarLeaveDeduction({ ...input, days: noHours })).toBe(11904.75)
  })

  it('returns 0 for no rows and refuses an impossible schedule or period', () => {
    expect(calendarLeaveDeduction({ ...input, days: [] })).toBe(0)
    expect(() => calendarLeaveDeduction({ ...input, hoursPerDay: 0, days: [] })).toThrow()
    expect(() => calendarLeaveDeduction({ ...input, periodStart: '2037-08-01', days: [] })).toThrow()
  })
})

describe('monthlyBaseSalary (partial_month)', () => {
  // August 2037: the 1st is a Saturday, the 10th a Monday. 16 of 21 workdays
  // employed, 22 of 31 calendar days.
  const args = { monthlySalary: 42000, employmentDegree: 100, employmentStart: '2037-08-10', periodStart: '2037-08-01', periodEnd: '2037-08-31' }

  it('prorates by workdays by default and by rounded calendar-day rate under annual_calendar_days', () => {
    expect(monthlyBaseSalary(args)).toBe(32000)
    expect(monthlyBaseSalary({ ...args, calculationPolicy: DEFAULT_SALARY_CALCULATION_POLICY })).toBe(32000)
    expect(
      monthlyBaseSalary({ ...args, calculationPolicy: SalaryCalculationPolicySchema.parse({ partial_month: 'annual_calendar_days' }) }),
    ).toBe(30378.04)
  })

  it('pays the full salary for a full month under both conventions, even when the month starts on a weekend', () => {
    const full = { ...args, employmentStart: '2037-08-01' }
    expect(monthlyBaseSalary(full)).toBe(42000)
    expect(monthlyBaseSalary({ ...full, calculationPolicy: SalaryCalculationPolicySchema.parse({ partial_month: 'annual_calendar_days' }) })).toBe(
      42000,
    )
    // Employment from Monday the 3rd covers every workday (ratio 1 by
    // workdays) but only 29 of 31 calendar days.
    const monday = { ...args, employmentStart: '2037-08-03' }
    expect(monthlyBaseSalary(monday)).toBe(42000)
    expect(monthlyBaseSalary({ ...monday, calculationPolicy: SalaryCalculationPolicySchema.parse({ partial_month: 'annual_calendar_days' }) })).toBe(
      40043.78,
    )
  })

  it('applies the employment degree before prorating and pays nothing outside the employment', () => {
    const half = { ...args, employmentDegree: 50, calculationPolicy: SalaryCalculationPolicySchema.parse({ partial_month: 'annual_calendar_days' }) }
    expect(monthlyBaseSalary(half)).toBe(15189.02)
    expect(monthlyBaseSalary({ ...half, employmentEnd: '2037-07-31' })).toBe(0)
  })
})
