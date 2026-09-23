/**
 * employees.monthly_salary is the FULL-TIME salary; employment_degree says
 * how much of it the employee earns. The engine's Step 1 always applied the
 * degree, but the absence derivation, the premium hourly rate and the
 * vacation day value read the column raw (issue #2879): a 10 % employee on
 * 50 000 had a karensavdrag of 1 846,15 taken off a 5 000 payslip.
 *
 * degreeAdjustedMonthlySalary is the one definition every money consumer of
 * monthly_salary goes through. The source pins keep the three raw readers
 * from coming back, and the end-to-end case is the customer's report.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveAbsenceLineItems, type DeriveInput } from '@/lib/salary/derive-absence-line-items'
import { dayValueSek } from '@/lib/salary/semesterberedning'
import {
  dailyDivisor,
  degreeAdjustedMonthlySalary,
  scheduledHoursPerDay,
} from '@/lib/salary/work-schedule'
import type { PayrollConfig } from '@/lib/salary/payroll-config'

const ROOT = join(__dirname, '..', '..', '..')
const source = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

describe('degreeAdjustedMonthlySalary', () => {
  it('is monthly x degree / 100, rounded to öre', () => {
    expect(degreeAdjustedMonthlySalary(50000, 10)).toBe(5000)
    expect(degreeAdjustedMonthlySalary(30000, 50)).toBe(15000)
    expect(degreeAdjustedMonthlySalary(33333, 33)).toBe(10999.89)
    expect(degreeAdjustedMonthlySalary(35000, 75)).toBe(26250)
  })

  it('is the identity at 100 % and when the degree is missing', () => {
    expect(degreeAdjustedMonthlySalary(30000, 100)).toBe(30000)
    expect(degreeAdjustedMonthlySalary(30000, null)).toBe(30000)
    expect(degreeAdjustedMonthlySalary(30000, undefined)).toBe(30000)
  })

  it('treats a missing salary as 0', () => {
    expect(degreeAdjustedMonthlySalary(null, 50)).toBe(0)
    expect(degreeAdjustedMonthlySalary(undefined, 100)).toBe(0)
    expect(degreeAdjustedMonthlySalary(0, 10)).toBe(0)
  })

  it('is the expression the engine and create-run used inline before it was shared', () => {
    const inline = (m: number, d: number) => Math.round(m * (d / 100) * 100) / 100
    for (const m of [0, 1, 12345.67, 25000, 30000, 33333, 50000, 99999.99]) {
      for (const d of [1, 10, 25, 33, 50, 62.5, 75, 80, 100]) {
        expect(degreeAdjustedMonthlySalary(m, d)).toBe(inline(m, d))
      }
    }
  })
})

describe('the customer case: 50 000 at 10 %, scheduled 4 h on 1 day a week', () => {
  const config = {
    sjuklonRate: 0.8,
    karensavdragFactor: 0.2,
    maxKarensavdragPerYear: 10,
  } as PayrollConfig

  const input = (monthlySalary: number): DeriveInput => ({
    monthlySalary,
    payrollConfig: config,
    periodDays: [{ absence_date: '2026-09-07', absence_type: 'sick', hours: 4 }],
    lookbackSickDates: [],
    vabDaysYtd: 0,
    parentalDaysPregnancyYtd: 0,
    hoursPerDay: scheduledHoursPerDay(4, 1),
    dailyDivisor: dailyDivisor(1),
    hoursPerWeek: 4,
    workdaysPerWeek: 1,
  })

  it('takes the karensavdrag off the pay she earns, not the full-time salary', () => {
    const fixed = deriveAbsenceLineItems(input(degreeAdjustedMonthlySalary(50000, 10)))
    const karens = fixed.lineItems.find((li) => li.item_type === 'sick_karens')!
    // 20 % of one week's sjuklön on 5 000: r(r(5000 x 12 / 52 x 0.8) x 0.2).
    expect(Math.abs(karens.amount)).toBe(184.62)

    // What the raw column produced: the same deduction on 50 000, ten times
    // the base salary line the payslip pays.
    const raw = deriveAbsenceLineItems(input(50000))
    const rawKarens = raw.lineItems.find((li) => li.item_type === 'sick_karens')!
    expect(Math.abs(rawKarens.amount)).toBe(1846.15)
  })

  it('prices her hour like a full-timer on the same monthly salary', () => {
    // 5 000 x 12 / (52 x 4) and 50 000 x 12 / (52 x 40) are the same hour.
    const partTime = (degreeAdjustedMonthlySalary(50000, 10) * 12) / (52 * 4)
    const fullTime = (degreeAdjustedMonthlySalary(50000, 100) * 12) / (52 * 40)
    expect(partTime).toBeCloseTo(fullTime, 6)
  })
})

describe('dayValueSek applies the degree', () => {
  const emp = {
    vacation_rule: 'procentregeln' as const,
    vacation_days_per_year: 25,
    vacation_pay_rate: null,
    salary_type: 'monthly' as const,
    monthly_salary: 30000,
    employment_degree: 50,
    hourly_rate: null,
    hours_per_week: 20,
    workdays_per_week: 5,
  }

  it('procentregeln: 12 % of the annual pay actually earned', () => {
    // 15000 x 12 x 0.12 / 25 = 864 (was 1728 from the full-time salary).
    expect(dayValueSek(emp)).toBe(864)
    expect(dayValueSek({ ...emp, employment_degree: 100 })).toBe(1728)
  })

  it('sammalöneregeln: a day of the pay actually earned plus tillägg on it', () => {
    // 15000 / 21 + 15000 x 0.0043 = 714.29 + 64.5 = 778.79
    expect(dayValueSek({ ...emp, vacation_rule: 'sammaloneregeln' })).toBe(778.79)
  })
})

describe('source pins: no consumer reads monthly_salary raw as money', () => {
  const runCalculation = source('lib/salary/run-calculation.ts')
  const semesterberedning = source('lib/salary/semesterberedning.ts')

  it('the absence derivation is fed the degree-adjusted salary', () => {
    const call = runCalculation.match(/loadAndDeriveAbsence\(\{[\s\S]*?\n\s*\}\)/)
    expect(call, 'loadAndDeriveAbsence call not found').not.toBeNull()
    expect(call![0]).toContain(
      'monthlySalary: degreeAdjustedMonthlySalary(sre.monthly_salary, emp.employment_degree)',
    )
    expect(call![0]).not.toMatch(/monthlySalary:\s*sre\.monthly_salary/)
  })

  it('the premium hourly rate is derived from the degree-adjusted salary', () => {
    // The param type closes with "}): number {", the body with "}\n".
    const fn = runCalculation.match(/function effectiveHourlyRate\([\s\S]*?\n\}\n/)
    expect(fn, 'effectiveHourlyRate not found').not.toBeNull()
    expect(fn![0]).toContain('degreeAdjustedMonthlySalary(emp.monthly_salary, emp.employment_degree)')
    expect(fn![0]).not.toMatch(/const monthly = emp\.monthly_salary/)
  })

  it('the vacation day value is derived from the degree-adjusted salary', () => {
    const fn = semesterberedning.match(/export function dayValueSek\([\s\S]*?\n\}/)
    expect(fn, 'dayValueSek not found').not.toBeNull()
    expect(fn![0]).toContain('degreeAdjustedMonthlySalary(emp.monthly_salary, emp.employment_degree)')
    expect(fn![0]).not.toMatch(/const monthly = emp\.monthly_salary/)
  })

  it('every employee select that feeds dayValueSek carries employment_degree', () => {
    // The callers cast their row to DayValueEmployee, so a select without the
    // column would type-check and silently value part-timers at 100 %.
    const files = [
      'lib/salary/semesterberedning.ts',
      'app/api/v1/companies/[companyId]/employees/[id]/vacation-balance/route.ts',
      'extensions/general/mcp-server/server.ts',
    ].filter((rel) => existsSync(join(ROOT, rel)))
    expect(files.length).toBeGreaterThanOrEqual(2)
    for (const rel of files) {
      const text = source(rel)
      if (!text.includes('dayValueSek(')) continue
      const selects = text.match(/\.select\(\s*'[^']*\bvacation_rule\b[^']*'/g) ?? []
      expect(selects.length, `${rel}: no vacation_rule select`).toBeGreaterThan(0)
      for (const s of selects) {
        expect(s, `${rel}: ${s}`).toContain('employment_degree')
      }
    }
  })
})
