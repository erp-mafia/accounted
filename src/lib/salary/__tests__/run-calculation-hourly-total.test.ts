/**
 * An hourly employee's hours as one total for the period (accounted#1).
 *
 * The payslip takes the period's worked hours either per day in the
 * calendar or as one total on the run row (salary_run_employees.hours_worked,
 * set through setRunEmployeeSalary). The calculation must not care which: the
 * same hours give the same pay, the same tax and the same Timlön line, so
 * a company that keeps hours in its own sheet does not have to split them
 * over days.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import { clearTaxTableCache } from '../tax-tables'
import { createPayrollFakeDb, type Row } from './payroll-fake-db'
import {
  draftRun,
  employee,
  line,
  PAYROLL_CONFIG_2026,
  rosterRow,
  skatteverketFetch,
  worked,
} from './payroll-fixtures'
import { runSalaryCalculation } from '../run-calculation'

const H = 'company-h'
const RUN = 'run-h-2026-09'
const SRE = `sre-${RUN}-emp-tim`

/** 26 hours in September: per day (20 + 6) or as one total on the run row. */
function scenario(mode: 'calendar' | 'total'): Record<string, Row[]> {
  const tim = employee(H, 'emp-tim', {
    first_name: 'Tim',
    salary_type: 'hourly',
    monthly_salary: 0,
    hourly_rate: 187.5,
    hours_per_week: 40,
    workdays_per_week: 5,
  })
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [{ company_id: H, salary_net_rounding: false, salary_calculation_policy: {} }],
    salary_runs: [draftRun(H, RUN, { period_year: 2026, period_month: 9, payment_date: '2026-09-25' })],
    employees: [tim],
    salary_run_employees: [rosterRow(H, RUN, tim, mode === 'total' ? { hours_worked: 26 } : {})],
    // The Timlön line as each path leaves it before a calculation: seeded
    // empty when the employee joined the run, or priced by the total.
    salary_line_items: [
      line(H, SRE, 'li-tim-base', {
        item_type: 'hourly_salary',
        description: 'Timlön',
        ...(mode === 'total' ? { quantity: 26, unit_price: 187.5, amount: 4875 } : { amount: 0 }),
      }),
    ],
    employee_opening_balances: [],
    salary_absence_days: [],
    salary_worked_days:
      mode === 'calendar'
        ? worked(H, 'emp-tim', [
            ['2026-09-07', 20, null, null],
            ['2026-09-08', 6, null, null],
          ])
        : [],
    shift_premium_rules: [],
    employee_benefits: [],
    employee_recurring_lines: [],
  }
}

async function calculate(seed: Record<string, Row[]>) {
  const db = createPayrollFakeDb(seed)
  const result = await runSalaryCalculation({
    supabase: db.supabase,
    companyId: H,
    salaryRunId: RUN,
    log: createLogger('test/run-calculation-hourly-total'),
    requestId: 'req_hourly_total',
  })
  return { db, result }
}

const PAY_COLUMNS = [
  'hours_worked',
  'gross_salary',
  'taxable_income',
  'tax_withheld',
  'net_salary',
  'avgifter_amount',
  'avgifter_basis',
  'vacation_accrual',
  'vacation_accrual_avgifter',
] as const

function payslip(db: Awaited<ReturnType<typeof calculate>>['db']) {
  const sre = db.rows('salary_run_employees').find((row) => row.id === SRE)!
  const lines = db
    .rows('salary_line_items')
    .filter((li) => li.salary_run_employee_id === SRE)
    .map(({ item_type, description, quantity, unit_price, amount, account_number }) => ({
      item_type,
      description,
      quantity,
      unit_price,
      amount,
      account_number,
    }))
    .sort((a, b) => String(a.item_type).localeCompare(String(b.item_type)))
  return {
    pay: Object.fromEntries(PAY_COLUMNS.map((column) => [column, sre[column]])),
    lines,
  }
}

describe('runSalaryCalculation: hourly hours as one total', () => {
  beforeEach(() => {
    clearTaxTableCache()
    vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pays the total on the run row exactly as the same hours entered per day', async () => {
    const perDay = await calculate(scenario('calendar'))
    const total = await calculate(scenario('total'))
    expect(perDay.result.ok).toBe(true)
    expect(total.result.ok).toBe(true)

    const a = payslip(perDay.db)
    const b = payslip(total.db)
    expect(b).toEqual(a)

    // 26 h x 187,50 kr = 4 875 kr, on one Timlön line with the total.
    expect(a.pay.hours_worked).toBe(26)
    expect(a.pay.gross_salary).toBe(4875)
    expect(a.lines.filter((li) => li.item_type === 'hourly_salary')).toEqual([
      { item_type: 'hourly_salary', description: 'Timlön', quantity: 26, unit_price: 187.5, amount: 4875, account_number: null },
    ])
  })

  it('reprices the Timlön line from the total at the current timlön', async () => {
    // The line was priced when the total was set; the timlön changed since.
    const seed = scenario('total')
    seed.employees[0]!.hourly_rate = 200
    const { db, result } = await calculate(seed)
    expect(result.ok).toBe(true)

    const { pay, lines } = payslip(db)
    expect(pay.gross_salary).toBe(5200)
    expect(lines.filter((li) => li.item_type === 'hourly_salary')).toEqual([
      { item_type: 'hourly_salary', description: 'Timlön', quantity: 26, unit_price: 200, amount: 5200, account_number: null },
    ])
  })

  it('keeps an account chosen on the Timlön line when it reprices it', async () => {
    const seed = scenario('total')
    seed.salary_line_items[0]!.account_number = '7011'
    const { db, result } = await calculate(seed)
    expect(result.ok).toBe(true)

    expect(payslip(db).lines.filter((li) => li.item_type === 'hourly_salary')).toEqual([
      { item_type: 'hourly_salary', description: 'Timlön', quantity: 26, unit_price: 187.5, amount: 4875, account_number: '7011' },
    ])
  })

  it('lets calendar days win over a total on the run row', async () => {
    // Both present (the total was set before days were entered): the
    // calendar is the source, as setRunEmployeeSalary promises.
    const seed = scenario('total')
    seed.salary_worked_days = worked(H, 'emp-tim', [['2026-09-07', 8, null, null]])
    const { db, result } = await calculate(seed)
    expect(result.ok).toBe(true)

    const { pay, lines } = payslip(db)
    expect(pay.hours_worked).toBe(8)
    expect(pay.gross_salary).toBe(1500)
    expect(lines.filter((li) => li.item_type === 'hourly_salary')).toEqual([
      { item_type: 'hourly_salary', description: 'Timlön', quantity: 8, unit_price: 187.5, amount: 1500, account_number: null },
    ])
  })
})
