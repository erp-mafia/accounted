import { describe, expect, it } from 'vitest'
import { calendarLeaveDeduction } from '../calendar-leave'
import { SalaryCalculationPolicySchema } from '../calculation-policy'
import { monthlyBaseSalary } from '../calculation-engine'
import type { AbsenceDay } from '../derive-absence-line-items'

const days = (start: string, end: string, hours = 8): AbsenceDay[] => {
  const rows: AbsenceDay[] = []
  for (let ms = Date.parse(start); ms <= Date.parse(end); ms += 86400000) {
    if (new Date(ms).getUTCDay() % 6 !== 0) rows.push({ absence_date: new Date(ms).toISOString().slice(0, 10), absence_type: 'parental', hours })
  }
  return rows
}
const input = { monthlySalary: 50000, hoursPerDay: 8, dailyDivisor: 21, periodStart: '2037-07-01', periodEnd: '2037-07-31' }
describe('explicit calendar-day agreement', () => {
  it('uses working days for five-day leave', () => {
    expect(calendarLeaveDeduction({ ...input, days: days('2037-07-13', '2037-07-17') })).toBe(11904.75)
  })
  it('includes intervening weekends for long leave', () => {
    expect(calendarLeaveDeduction({ ...input, days: days('2037-07-02', '2037-07-17') })).toBe(26301.44)
  })
  it('uses prior-month context without deducting prior-month days again', () => {
    expect(calendarLeaveDeduction({ ...input, days: days('2037-06-15', '2037-07-03') })).toBe(4931.52)
  })
  it('deducts exactly one monthly salary for a complete month', () => {
    expect(calendarLeaveDeduction({ ...input, days: days('2037-06-15', '2037-08-10') })).toBe(50000)
  })
  it('weights a full month of partial leave', () => {
    expect(calendarLeaveDeduction({ ...input, days: days('2037-07-01', '2037-07-31', 2) })).toBe(12500)
  })
  it('does not bridge an unreported working day', () => {
    expect(calendarLeaveDeduction({ ...input, days: [...days('2037-07-02', '2037-07-03'), ...days('2037-07-09', '2037-07-10')] })).toBe(9523.8)
  })

  it('never charges an entire monthly salary for a partial deviation window', () => {
    expect(calendarLeaveDeduction({ ...input, periodStart: '2037-07-13', periodEnd: '2037-07-17', days: days('2037-07-13', '2037-07-17') })).toBe(11904.75)
  })
  it('prorates partial employment by rounded calendar-day rate only when selected', () => {
    const args = { monthlySalary: 42000, employmentDegree: 100, employmentStart: '2037-08-10', periodStart: '2037-08-01', periodEnd: '2037-08-31' }
    expect(monthlyBaseSalary({ ...args, calculationPolicy: SalaryCalculationPolicySchema.parse({ partial_month: 'annual_calendar_days' }) })).toBe(30378.04)
    expect(monthlyBaseSalary(args)).toBe(32000)
    expect(monthlyBaseSalary({ ...args, employmentStart: '2037-08-01' })).toBe(42000)
  })
  it('rejects misspelled or unsupported company conventions', () => {
    expect(() => SalaryCalculationPolicySchema.parse({ partial_month: 'calender' })).toThrow()
    expect(() => SalaryCalculationPolicySchema.parse({ unknown: 1 })).toThrow()
  })
})
