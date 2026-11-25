/**
 * An absence or worked day without stated hours is one scheduled day of that
 * employee, hours_per_week / workdays_per_week, from every door: one unpaid
 * day of a 40 000 kr salary on 40 h over 4 days is 2 308,14 kr, and the old
 * 8 h default at the doors took 1 846,51 kr off it.
 */
import { describe, expect, it } from 'vitest'
import {
  BatchUpsertWorkedDaysSchema,
  UpsertAbsenceDaySchema,
  UpsertWorkedDaySchema,
} from '@/lib/api/schemas'
import { upsertAbsenceDay, upsertAbsenceRange } from '../absence'
import { deriveAbsenceLineItems, type DeriveInput } from '../derive-absence-line-items'
import type { PayrollConfig } from '../payroll-config'
import { dailyDivisor, scheduledHoursPerDay } from '../work-schedule'
import { replaceWorkedDay } from '../worked-days'
import { createPayrollFakeDb } from './payroll-fake-db'
import { employee } from './payroll-fixtures'

const C = 'company-1'
const SHORT_WEEK = { hours_per_week: 40, workdays_per_week: 4 }

function db(schedule: Record<string, number>) {
  return createPayrollFakeDb({
    employees: [employee(C, 'anna', schedule)],
    salary_runs: [],
    salary_run_employees: [],
    salary_absence_days: [],
    salary_worked_days: [],
  })
}

const config = { sjuklonRate: 0.8, karensavdragFactor: 0.2, maxKarensavdragPerYear: 10, prisbasbelopp: 59200 } as unknown as PayrollConfig

function unpaidDay(hours: number) {
  return deriveAbsenceLineItems({
    monthlySalary: 40000,
    payrollConfig: config,
    periodDays: [{ absence_date: '2026-09-07', absence_type: 'unpaid_leave', hours }],
    lookbackSickDates: [],
    vabDaysYtd: 0,
    parentalDaysPregnancyYtd: 0,
    hoursPerDay: scheduledHoursPerDay(40, 4),
    dailyDivisor: dailyDivisor(4),
    hoursPerWeek: 40,
    workdaysPerWeek: 4,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
  } as DeriveInput).lineItems[0]
}

describe('a day without stated hours', () => {
  it.each([
    [{ hours_per_week: 40, workdays_per_week: 5 }, 8],
    [SHORT_WEEK, 10],
    [{ hours_per_week: 20, workdays_per_week: 5 }, 4],
    [{ hours_per_week: 37.5, workdays_per_week: 5 }, 7.5],
    // Rounded up: 13.33 h would weigh 0.99975 of a day.
    [{ hours_per_week: 40, workdays_per_week: 3 }, 13.34],
  ])('is one scheduled day of %j through the range door', async (schedule, hours) => {
    const fake = db(schedule)
    const result = await upsertAbsenceRange(fake.supabase, { companyId: C, employeeId: 'anna', from: '2026-09-07', to: '2026-09-07', absenceType: 'unpaid_leave' })
    expect(result).toMatchObject({ ok: true })
    expect(fake.rows('salary_absence_days')[0].hours).toBe(hours)
  })

  it('states the same hours in the dry run the caller approves', async () => {
    const result = await upsertAbsenceRange(db(SHORT_WEEK).supabase, { companyId: C, employeeId: 'anna', from: '2026-09-07', to: '2026-09-08', absenceType: 'sick', dryRun: true })
    expect(result).toMatchObject({ ok: true, data: { hours_per_day: 10, days: [{ hours: 10 }, { hours: 10 }] } })
  })

  it('keeps stated hours: the schedule only fills a gap', async () => {
    const fake = db(SHORT_WEEK)
    await upsertAbsenceRange(fake.supabase, { companyId: C, employeeId: 'anna', from: '2026-09-07', to: '2026-09-07', absenceType: 'sick', hoursPerDay: 3 })
    expect(fake.rows('salary_absence_days')[0].hours).toBe(3)
  })

  it('is one scheduled day through the single-day door', async () => {
    const fake = db(SHORT_WEEK)
    await upsertAbsenceDay(fake.supabase, { companyId: C, employeeId: 'anna', day: { absence_date: '2026-09-07', absence_type: 'sick' } })
    expect(fake.rows('salary_absence_days')[0].hours).toBe(10)
  })

  it('is one scheduled day through the worked-day door', async () => {
    const fake = db(SHORT_WEEK)
    await replaceWorkedDay(fake.supabase, { companyId: C, employeeId: 'anna', day: { work_date: '2026-09-07' } })
    expect(fake.rows('salary_worked_days')[0].hours).toBe(10)
  })

  it('takes the full day off the pay', () => {
    expect(unpaidDay(10)).toMatchObject({ amount: -2308.14, quantity: 1 })
  })
})

describe('the schemas do not decide the length of a day', () => {
  it('leaves absence hours out when the caller did', () => {
    expect(UpsertAbsenceDaySchema.parse({ absence_date: '2026-09-07', absence_type: 'sick' }).hours).toBeUndefined()
  })
  it('leaves worked hours out when the caller did', () => {
    expect(UpsertWorkedDaySchema.parse({ work_date: '2026-09-07' }).hours).toBeUndefined()
    expect(BatchUpsertWorkedDaysSchema.parse({ dates: ['2026-09-07'] }).hours).toBeUndefined()
  })
})
