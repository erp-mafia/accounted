/**
 * runSalaryCalculation orchestration around the engine: the run totals use
 * the effective figures (review-step overrides applied, an F-skatt row
 * ignoring an avgifter override), and a row whose salary_type snapshot is
 * stale is brought in line with the employee before it is priced.
 *
 * The engine itself is mocked (its maths has its own tests): this file pins
 * what run-calculation does with the engine's answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'

vi.mock('../payroll-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../payroll-config')>()
  return { ...actual, loadPayrollConfig: vi.fn().mockResolvedValue({ year: 2026 }) }
})
vi.mock('../tax-tables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tax-tables')>()
  return { ...actual, fetchAllTaxTableRatesForRun: vi.fn().mockResolvedValue({ rates: [], source: 'api' }) }
})
vi.mock('../derive-absence-line-items', () => ({
  loadRunAbsence: vi.fn().mockResolvedValue(new Map()),
  deriveEmployeeAbsence: vi.fn().mockReturnValue({
    lineItems: [],
    aggregated: { sickDays: 0, vabDays: 0, parentalDays: 0 },
    flagLakarintyg: false,
    flagFkReporting: false,
  }),
}))
vi.mock('../ytd', () => ({
  loadOpeningBalances: vi.fn().mockResolvedValue([]),
  computePriorYtd: vi.fn().mockResolvedValue(new Map()),
}))
vi.mock('../calculation-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../calculation-engine')>()
  return { ...actual, calculateSalary: vi.fn() }
})

import { calculateSalary } from '../calculation-engine'
import { runSalaryCalculation } from '../run-calculation'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const COMPANY_ID = '22222222-2222-4222-8222-222222222222'

const RUN = {
  id: RUN_ID,
  company_id: COMPANY_ID,
  status: 'draft',
  period_year: 2026,
  period_month: 9,
  payment_date: '2026-09-25',
  deviation_period_start: null,
  deviation_period_end: null,
}

const EMPLOYEE = {
  id: 'emp-1',
  first_name: 'Test',
  last_name: 'Testsson',
  personnummer: 'enc',
  salary_type: 'monthly',
  employment_type: 'employee',
  employment_degree: 100,
  employment_start: '2020-01-01',
  employment_end: null,
  monthly_salary: 30000,
  hourly_rate: null,
  hours_per_week: 40,
  workdays_per_week: 5,
  f_skatt_status: 'a_skatt',
  is_sidoinkomst: false,
  tax_table_number: 33,
  tax_column: 1,
  vacation_rule: 'procentregeln',
  vacation_days_per_year: 25,
}

function rosterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sre-1',
    salary_run_id: RUN_ID,
    employee_id: 'emp-1',
    company_id: COMPANY_ID,
    salary_type: 'monthly',
    monthly_salary: 30000,
    hours_worked: null,
    tax_withheld_override: null,
    avgifter_amount_override: null,
    line_items: [],
    employee: EMPLOYEE,
    ...overrides,
  }
}

function engineResult(overrides: Record<string, unknown> = {}) {
  return {
    grossSalary: 30000,
    grossDeductions: 0,
    benefitValues: 0,
    taxableIncome: 30000,
    taxWithheld: 7000,
    netDeductions: 0,
    netSalary: 23000,
    avgifterRate: 0.3142,
    avgifterAmount: 9426,
    avgifterBasis: 30000,
    avgifterCategory: 'standard',
    vacationAccrual: 3600,
    vacationAccrualAvgifter: 1131.12,
    vacationCompensation: 0,
    netRounding: 0,
    totalEmployerCost: 44157.12,
    vaxaStodRefund: null,
    steps: [],
    ...overrides,
  }
}

function client(roster: unknown[], lineItemsRead: unknown = []) {
  return createTableMockSupabase({
    salary_runs: [{ data: RUN }, { data: RUN }],
    company_settings: { data: null },
    salary_run_employees: [{ data: roster }, { data: null }],
    shift_premium_rules: { data: [] },
    employee_benefits: { data: [] },
    employee_recurring_lines: { data: [] },
    salary_worked_days: { data: [] },
    // The first salary_line_items await is the stale-snapshot base-line
    // read when there is one; every later await is a write.
    salary_line_items: [{ data: lineItemsRead }, { data: null }],
  })
}

function calculate(mock: ReturnType<typeof createTableMockSupabase>) {
  return runSalaryCalculation({
    supabase: mock.supabase as unknown as SupabaseClient,
    companyId: COMPANY_ID,
    salaryRunId: RUN_ID,
    log: createLogger('test/run-calculation-effective'),
    requestId: 'req_test',
  })
}

function runTotalsWrite(mock: ReturnType<typeof createTableMockSupabase>) {
  return mock.findCall('salary_runs', 'update')?.[0] as Record<string, unknown>
}

/** The calculated roster row: the last update of the roster table. */
function rosterWrite(mock: ReturnType<typeof createTableMockSupabase>) {
  return mock.findCalls('salary_run_employees', 'update').at(-1)?.[0] as Record<string, unknown>
}

describe('runSalaryCalculation: run totals use the effective figures', () => {
  beforeEach(() => {
    vi.mocked(calculateSalary).mockReset()
  })

  it('applies a tax and an avgifter override to total_tax, total_net, total_avgifter and total_employer_cost', async () => {
    vi.mocked(calculateSalary).mockReturnValue(engineResult() as never)
    const mock = client([rosterRow({ tax_withheld_override: 9000, avgifter_amount_override: 8000 })])

    const result = await calculate(mock)

    expect(result.ok).toBe(true)
    expect(runTotalsWrite(mock)).toMatchObject({
      total_gross: 30000,
      total_tax: 9000,
      total_net: 21000,
      total_avgifter: 8000,
      total_vacation_accrual: 3600,
      total_employer_cost: 42731.12, // 30 000 + 8 000 + 3 600 + 1 131,12
    })
    // The row keeps the engine's raw figures (the calculation trace).
    expect(rosterWrite(mock)).toMatchObject({ tax_withheld: 7000, net_salary: 23000, avgifter_amount: 9426 })
  })

  it('ignores an avgifter override on an F-skatt row, as the AGI and the booking do', async () => {
    vi.mocked(calculateSalary).mockReturnValue(
      engineResult({
        grossSalary: 15000,
        taxableIncome: 15000,
        taxWithheld: 0,
        netSalary: 15000,
        avgifterRate: 0,
        avgifterAmount: 0,
        avgifterBasis: 0,
        vacationAccrual: 0,
        vacationAccrualAvgifter: 0,
        totalEmployerCost: 15000,
      }) as never,
    )
    const mock = client([
      rosterRow({
        avgifter_amount_override: 5000,
        employee: { ...EMPLOYEE, f_skatt_status: 'f_skatt', tax_table_number: null },
      }),
    ])

    const result = await calculate(mock)

    expect(result.ok).toBe(true)
    expect(runTotalsWrite(mock)).toMatchObject({
      total_gross: 15000,
      total_avgifter: 0,
      total_employer_cost: 15000,
    })
  })
})

describe('runSalaryCalculation: a stale salary_type snapshot (agent feedback seq 869949)', () => {
  beforeEach(() => {
    vi.mocked(calculateSalary).mockReset()
    vi.mocked(calculateSalary).mockReturnValue(engineResult() as never)
  })

  it('swaps the base line and the snapshot for an employee now paid monthly, then prices the new line', async () => {
    const mock = client(
      [rosterRow({ salary_type: 'hourly', line_items: [{ id: 'li-old', item_type: 'hourly_salary', amount: 0 }] })],
      [{ id: 'li-old', item_type: 'hourly_salary' }],
    )

    const result = await calculate(mock)

    expect(result.ok).toBe(true)
    const order = mock.calls
      .filter(
        (c) =>
          (c.table === 'salary_line_items' && ['insert', 'delete', 'update'].includes(c.method)) ||
          (c.table === 'salary_run_employees' && c.method === 'update'),
      )
      .map((c) => `${c.table}.${c.method}`)
    // New Grundlön first, then the stale Timlön goes, then the snapshot,
    // then the monthly branch prices the new line; the calculated row last.
    expect(order.slice(0, 4)).toEqual([
      'salary_line_items.insert',
      'salary_line_items.delete',
      'salary_run_employees.update',
      'salary_line_items.update',
    ])
    expect(order.at(-1)).toBe('salary_run_employees.update')
    expect(mock.findCall('salary_line_items', 'insert')?.[0]).toMatchObject({
      item_type: 'monthly_salary',
      description: 'Grundlön',
    })
    expect(mock.findCalls('salary_line_items', 'in')[1]).toEqual(['item_type', ['hourly_salary']])
    expect(mock.findCalls('salary_run_employees', 'update')[0][0]).toEqual({ salary_type: 'monthly' })
    expect(mock.findCall('salary_line_items', 'update')?.[0]).toEqual({ amount: 30000 })
    // The engine priced the live pay type, and the row write keeps the
    // snapshot in line with it.
    expect(vi.mocked(calculateSalary).mock.calls[0][0]).toMatchObject({ salaryType: 'monthly', monthlySalary: 30000 })
    expect(rosterWrite(mock).salary_type).toBe('monthly')
  })

  it('leaves the base line alone when the snapshot matches the employee', async () => {
    const mock = client([rosterRow()])

    const result = await calculate(mock)

    expect(result.ok).toBe(true)
    expect(mock.findCalls('salary_line_items', 'insert')).toHaveLength(0)
    expect(mock.findCalls('salary_run_employees', 'update')).toHaveLength(1) // the row write only
  })
})
