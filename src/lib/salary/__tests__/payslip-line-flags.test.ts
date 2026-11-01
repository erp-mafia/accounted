/**
 * The flags of a payslip row follow from what the row is: a row of one type
 * means the same whichever door wrote it. The table below is written out by
 * hand from the dashboard's catalogue, the copy that was right: the API and
 * MCP doors used to default every type to pay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateSalaryLineItemSchema, UpdateSalaryLineItemSchema } from '@/lib/api/schemas'
import { createLogger } from '@/lib/logger'
import { createPayslipLine, updatePayslipLine } from '../payslip-lines'
import { runSalaryCalculation } from '../run-calculation'
import { clearTaxTableCache } from '../tax-tables'
import { createPayrollFakeDb, type Row } from './payroll-fake-db'
import { PAYROLL_CONFIG_2026, draftRun, employee, line, rosterRow, skatteverketFetch } from './payroll-fixtures'

vi.mock('../personnummer', async (original) => ({
  ...(await original<typeof import('../personnummer')>()),
  decryptPersonnummer: () => '198504120000',
}))

const C = 'company-1'
const RUN = 'run-1'

const flags = (t: 0 | 1, a: 0 | 1, v: 0 | 1, g: 0 | 1, n: 0 | 1) => ({
  is_taxable: t === 1,
  is_avgift_basis: a === 1,
  is_vacation_basis: v === 1,
  is_gross_deduction: g === 1,
  is_net_deduction: n === 1,
})

const CASES: Array<[type: string, amount: number, expected: ReturnType<typeof flags>]> = [
  ['bonus', 1000, flags(1, 1, 1, 0, 0)],
  ['commission', 1000, flags(1, 1, 1, 0, 0)],
  ['overtime', 1000, flags(1, 1, 1, 0, 0)],
  ['other', 1000, flags(1, 1, 1, 0, 0)],
  ['correction', -1000, flags(1, 1, 1, 0, 0)],
  ['semesterersattning', 1000, flags(1, 1, 0, 0, 0)],
  ['traktamente_taxable', 1000, flags(1, 1, 0, 0, 0)],
  ['mileage_taxable', 1000, flags(1, 1, 0, 0, 0)],
  ['traktamente_taxfree', 1000, flags(0, 0, 0, 0, 0)],
  ['mileage_taxfree', 1000, flags(0, 0, 0, 0, 0)],
  ['benefit_meals', 1000, flags(1, 1, 0, 0, 0)],
  ['benefit_other', 1000, flags(1, 1, 0, 0, 0)],
  ['gross_deduction_other', -1000, flags(1, 1, 0, 1, 0)],
  ['gross_deduction_pension', -1000, flags(1, 1, 0, 1, 0)],
  ['net_deduction_advance', -1000, flags(0, 0, 0, 0, 1)],
  ['net_deduction_union', -1000, flags(0, 0, 0, 0, 1)],
  ['net_deduction_other', -1000, flags(0, 0, 0, 0, 1)],
  ['vacation', 1000, flags(1, 1, 0, 0, 0)],
]

function calculatedRun(extraLines: Row[] = []) {
  const emp = employee(C, 'anna', { monthly_salary: 40000, tax_table_number: 33, personnummer: 'x' })
  const sre = rosterRow(C, RUN, emp)
  return createPayrollFakeDb({
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [{ company_id: C, salary_net_rounding: false, salary_calculation_policy: {}, salary_vacation_year_basis: 'calendar' }],
    salary_runs: [draftRun(C, RUN, { period_year: 2026, period_month: 9, payment_date: '2026-09-25', voucher_series: 'A' })],
    employees: [emp],
    salary_run_employees: [sre],
    salary_line_items: [
      line(C, sre.id as string, 'base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 40000 }),
      ...extraLines.map((row, i) => line(C, sre.id as string, `line-${i}`, row)),
    ],
    employee_opening_balances: [],
    salary_absence_days: [],
    salary_worked_days: [],
    employee_benefits: [],
    employee_recurring_lines: [],
    shift_premium_rules: [],
  })
}

const lineInput = (itemType: string, amount: number, overrides: Row = {}) =>
  ({ item_type: itemType, description: 'x', amount, sort_order: 0, ...overrides }) as never

describe('a row written through the line commands', () => {
  it.each(CASES)('%s carries the flags of its type', async (itemType, amount, expected) => {
    const db = calculatedRun()
    const result = await createPayslipLine(db.supabase, {
      companyId: C,
      salaryRunId: RUN,
      target: { employeeId: 'anna' },
      input: lineInput(itemType, amount),
    })
    expect(result).toMatchObject({ ok: true, data: expected })
  })

  it.each(CASES)('%s ignores flags the caller sends', async (itemType, amount, expected) => {
    const db = calculatedRun()
    const contradicting = {
      is_taxable: !expected.is_taxable,
      is_avgift_basis: !expected.is_avgift_basis,
      is_vacation_basis: !expected.is_vacation_basis,
      is_gross_deduction: !expected.is_gross_deduction,
      is_net_deduction: !expected.is_net_deduction,
    }
    const result = await createPayslipLine(db.supabase, {
      companyId: C,
      salaryRunId: RUN,
      target: { employeeId: 'anna' },
      input: lineInput(itemType, amount, contradicting),
    })
    expect(result).toMatchObject({ ok: true, data: expected })
  })

  it('the API takes no flags', () => {
    expect(CreateSalaryLineItemSchema.parse({
      salary_run_employee_id: '11111111-1111-4111-8111-111111111111',
      item_type: 'bonus',
      description: 'x',
      is_taxable: false,
    })).not.toHaveProperty('is_taxable')
    expect(UpdateSalaryLineItemSchema.parse({ is_net_deduction: true })).not.toHaveProperty('is_net_deduction')
  })

  it('a patch cannot change the flags, a change of type brings the new type\'s', async () => {
    const db = calculatedRun([{ item_type: 'bonus', description: 'Bonus', amount: 1000 }])
    const flagged = await updatePayslipLine(db.supabase, {
      companyId: C,
      salaryRunId: RUN,
      lineId: 'line-0',
      patch: { is_taxable: false, is_net_deduction: true } as never,
    })
    expect(flagged).toMatchObject({ ok: true, data: flags(1, 1, 1, 0, 0) })

    const retyped = await updatePayslipLine(db.supabase, {
      companyId: C,
      salaryRunId: RUN,
      lineId: 'line-0',
      patch: { item_type: 'net_deduction_other', amount: -1000 } as never,
    })
    expect(retyped).toMatchObject({ ok: true, data: flags(0, 0, 0, 0, 1) })
    expect(db.rows('salary_line_items').find((row) => row.id === 'line-0')).toMatchObject(flags(0, 0, 0, 0, 1))
  })
})

describe('a row stored before the rule', () => {
  beforeEach(() => {
    clearTaxTableCache()
    vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
  })
  afterEach(() => vi.unstubAllGlobals())

  const calculate = (db: ReturnType<typeof calculatedRun>) =>
    runSalaryCalculation({ supabase: db.supabase, companyId: C, salaryRunId: RUN, log: createLogger('test'), requestId: 'r' })
  const roster = (db: ReturnType<typeof calculatedRun>) =>
    db.rows('salary_run_employees')[0] as { net_salary: number; vacation_accrual: number; gross_salary: number }

  // The door defaults the audit proved, stored as they are on prod.
  const doorDefaults = { is_taxable: true, is_avgift_basis: true, is_vacation_basis: true, is_gross_deduction: false, is_net_deduction: false }

  it.each([
    // No flags from the door: the deduction never left the pay.
    ['net_deduction_other', -500, flags(0, 0, 0, 0, 1), 'net_salary', 31_098],
    // semesterlön earns no semesterlön: 12 % of 40 000.
    ['vacation', 5000, flags(1, 1, 0, 0, 0), 'vacation_accrual', 4800],
    ['benefit_other', 2000, flags(1, 1, 0, 0, 0), 'vacation_accrual', 4800],
    ['mileage_taxfree', 500, flags(0, 0, 0, 0, 0), 'vacation_accrual', 4800],
    ['traktamente_taxable', 900, flags(1, 1, 0, 0, 0), 'vacation_accrual', 4800],
  ] as const)('%s is calculated as its type and stored right again', async (itemType, amount, expected, column, figure) => {
    const db = calculatedRun([{ item_type: itemType, description: 'x', amount, ...doorDefaults }])
    expect(await calculate(db)).toMatchObject({ ok: true })
    expect(roster(db)[column]).toBe(figure)
    expect(db.rows('salary_line_items').find((row) => row.id === 'line-0')).toMatchObject(expected)
  })
})
