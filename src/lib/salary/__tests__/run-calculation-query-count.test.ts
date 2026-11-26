/**
 * How a salary calculation talks to the database as the roster grows, and
 * what it leaves behind when it stops part-way.
 *
 * A run used to read absence, worked days, förmåner and recurring lines and
 * write every derived payslip line once per employee: 27 statements for one
 * employee, 925 for fifty. The inputs are now read once per run and the
 * derived lines written in bulk. What still grows with the roster is one
 * update per roster row (only the computed columns, so an edit made
 * meanwhile survives) and the writes that touch rows only when something
 * changed (the Grundlön amount, a stale pay-type snapshot).
 *
 * The figures themselves are pinned by run-calculation-golden.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import { clearTaxTableCache } from '../tax-tables'
import { runSalaryCalculation } from '../run-calculation'
import { createPayrollFakeDb, type PayrollFakeDbOptions, type Row } from './payroll-fake-db'
import {
  absence,
  draftRun,
  employee,
  line,
  PAYROLL_CONFIG_2026,
  rosterRow,
  skatteverketFetch,
  worked,
} from './payroll-fixtures'

const COMPANY = 'company-count'
const RUN = 'run-count-2026-09'

/**
 * N employees, every `hourlyEvery`-th one hourly with three registered
 * shifts; each monthly employee has a förmån, a recurring line, a sick day
 * and a Grundlön line already at this month's amount. Four tax tables, two
 * columns, one OB rule.
 */
function roster(n: number, hourlyEvery = 3): Record<string, Row[]> {
  const employees: Row[] = []
  const rows: Row[] = []
  const lines: Row[] = []
  const absences: Row[] = []
  const workedDays: Row[] = []
  const benefits: Row[] = []
  const recurring: Row[] = []
  for (let i = 0; i < n; i++) {
    const id = `emp-${String(i).padStart(3, '0')}`
    const hourly = i % hourlyEvery === hourlyEvery - 1
    const emp = employee(COMPANY, id, {
      salary_type: hourly ? 'hourly' : 'monthly',
      monthly_salary: hourly ? null : 30000 + i * 100,
      hourly_rate: hourly ? 190 : null,
      tax_table_number: 30 + (i % 4),
      tax_column: i % 5 === 4 ? 2 : 1,
    })
    employees.push(emp)
    const sre = rosterRow(COMPANY, RUN, emp)
    rows.push(sre)
    lines.push(
      line(COMPANY, sre.id as string, `li-${id}-base`, {
        item_type: hourly ? 'hourly_salary' : 'monthly_salary',
        description: hourly ? 'Timlön' : 'Grundlön',
        amount: hourly ? 0 : 30000 + i * 100,
      }),
    )
    if (hourly) {
      workedDays.push(
        ...worked(COMPANY, id, [
          ['2026-09-01', 8, '08:00:00', '16:00:00'],
          ['2026-09-02', 8, '14:00:00', '22:00:00'],
          ['2026-09-05', 6, '10:00:00', '16:00:00'],
        ]),
      )
    } else {
      absences.push(...absence(COMPANY, id, [['2026-09-08', 'sick']]))
      benefits.push({
        id: `ben-${id}`,
        company_id: COMPANY,
        employee_id: id,
        benefit_type: 'meals',
        description: 'Kostförmån',
        monthly_value: 1240,
        is_active: true,
        valid_from: '2026-01-01',
        valid_to: null,
        created_at: '2026-01-02T08:00:00Z',
      })
      recurring.push({
        id: `rec-${id}`,
        company_id: COMPANY,
        employee_id: id,
        item_type: 'net_deduction_union',
        description: 'Fackavgift',
        amount: -450,
        account_number: null,
        is_active: true,
        valid_from: '2026-01-01',
        valid_to: null,
        created_at: '2026-01-02T08:00:00Z',
      })
    }
  }
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [{ company_id: COMPANY, salary_net_rounding: true, salary_calculation_policy: {} }],
    salary_runs: [draftRun(COMPANY, RUN, { period_year: 2026, period_month: 9, payment_date: '2026-09-25' })],
    employees,
    salary_run_employees: rows,
    salary_line_items: lines,
    employee_opening_balances: [],
    salary_absence_days: absences,
    salary_worked_days: workedDays,
    shift_premium_rules: [
      {
        id: 'rule-weekend',
        company_id: COMPANY,
        name: 'OB helg',
        applies_to_all_employees: true,
        applies_to_employee_ids: [],
        day_of_week: [6, 7],
        start_time: '00:00:00',
        end_time: '00:00:00',
        premium_percent: 50,
        item_type: 'ob_weekend',
        priority: 1,
        is_active: true,
      },
    ],
    employee_benefits: benefits,
    employee_recurring_lines: recurring,
  }
}

async function calculate(seed: Record<string, Row[]>, options?: PayrollFakeDbOptions) {
  const db = createPayrollFakeDb(seed, options)
  const result = await runSalaryCalculation({
    supabase: db.supabase,
    companyId: COMPANY,
    salaryRunId: RUN,
    log: createLogger('test/run-calculation-query-count'),
    requestId: 'req_count',
  })
  return { db, result }
}

const writes = (db: ReturnType<typeof createPayrollFakeDb>) => db.queries.filter((q) => q.op !== 'select')

describe('runSalaryCalculation statements', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  beforeEach(() => {
    clearTaxTableCache()
    fetchSpy = vi.fn(skatteverketFetch)
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends a fixed set of statements plus one roster update per employee', async () => {
    const small = await calculate(roster(10))
    clearTaxTableCache()
    const large = await calculate(roster(90))

    expect(small.result.ok).toBe(true)
    expect(large.result.ok).toBe(true)
    // 22: the 20 run-level statements, plus the late days carried to the
    // run (lib/salary/late-days.ts) read once for absence and once for
    // worked days, whatever the roster size.
    expect(small.db.queries.length).toBe(22 + 10)
    expect(large.db.queries.length).toBe(22 + 90)
    const rosterUpdates = large.db.queries.filter((q) => q.table === 'salary_run_employees' && q.op === 'update')
    expect(rosterUpdates).toHaveLength(90)
    expect(rosterUpdates.every((q) => q.rows === 1)).toBe(true)
    // One insert carries every derived line.
    expect(large.db.queries.filter((q) => q.table === 'salary_line_items' && q.op === 'insert')).toHaveLength(1)
  })

  it("keeps an edit of this month's salary made while the run was calculated", async () => {
    const control = await calculate(roster(3))
    clearTaxTableCache()
    const rowId = `sre-${RUN}-emp-000`
    let edited = false
    const db = createPayrollFakeDb(roster(3), {
      // After every read, before the first write: another session edits
      // this month's salary on the draft.
      beforeStatement: ({ op }) => {
        if (edited || op === 'select') return
        edited = true
        db.edit('salary_run_employees', rowId, { monthly_salary: 45000 })
      },
    })
    const result = await runSalaryCalculation({
      supabase: db.supabase,
      companyId: COMPANY,
      salaryRunId: RUN,
      log: createLogger('test/run-calculation-query-count'),
      requestId: 'req_count',
    })

    expect(result.ok).toBe(true)
    expect(edited).toBe(true)
    const row = db.rows('salary_run_employees').find((r) => r.id === rowId)!
    const controlRow = control.db.rows('salary_run_employees').find((r) => r.id === rowId)!
    // The edit survives; every computed column is the calculation's.
    expect(row.monthly_salary).toBe(45000)
    expect(controlRow.monthly_salary).toBe(30000)
    expect({ ...row, monthly_salary: null }).toEqual({ ...controlRow, monthly_salary: null })
    expect(row.calculation_breakdown).not.toBeNull()
    expect(row.gross_salary).toBeGreaterThan(0)
  })

  it('fetches each tax table once, whatever the number of columns used', async () => {
    await calculate(roster(10))
    // Tables 30-33 with columns 1 and 2: two section requests per table.
    expect(fetchSpy).toHaveBeenCalledTimes(8)
  })

  it('pages the run-level reads past the 1000-row cap', async () => {
    // 350 hourly employees x 3 shifts = 1050 worked-day rows.
    const { db, result } = await calculate(roster(350, 1))

    expect(result.ok).toBe(true)
    expect(db.queries.filter((q) => q.table === 'salary_worked_days')).toEqual([
      { table: 'salary_worked_days', op: 'select', rows: 1000 },
      // The late days carried to the run: none, one page.
      { table: 'salary_worked_days', op: 'select', rows: 0 },
      { table: 'salary_worked_days', op: 'select', rows: 50 },
    ])
    const hours = db.rows('salary_run_employees').map((row) => row.hours_worked)
    expect(hours).toHaveLength(350)
    expect(new Set(hours)).toEqual(new Set([22]))
  })

  it('writes nothing when an employee is refused part-way through the roster', async () => {
    const seed = roster(6)
    // emp-004: a second förmån type next to a payment for a förmån.
    seed.employee_benefits.push({
      id: 'ben-emp-004-housing',
      company_id: COMPANY,
      employee_id: 'emp-004',
      benefit_type: 'housing',
      description: 'Bostadsförmån',
      monthly_value: 2500,
      is_active: true,
      valid_from: '2026-01-01',
      valid_to: null,
      created_at: '2026-01-03T08:00:00Z',
    })
    seed.employee_recurring_lines.push({
      id: 'rec-emp-004-payment',
      company_id: COMPANY,
      employee_id: 'emp-004',
      item_type: 'net_deduction_benefit_payment',
      description: 'Egen betalning',
      amount: -500,
      account_number: null,
      is_active: true,
      valid_from: '2026-01-01',
      valid_to: null,
      created_at: '2026-01-03T08:00:00Z',
    })

    const { db, result } = await calculate(seed)

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(writes(db)).toEqual([])
  })

  it('stops at a failed line insert before the roster rows and the run totals', async () => {
    const { db, result } = await calculate(roster(6), {
      failOn: ({ table, op }) => table === 'salary_line_items' && op === 'insert',
    })

    expect(result).toMatchObject({ ok: false, code: 'DATABASE_ERROR' })
    expect(writes(db).map((q) => `${q.table}.${q.op}`)).not.toContain('salary_run_employees.update')
    expect(writes(db).map((q) => `${q.table}.${q.op}`)).not.toContain('salary_runs.update')
    expect(db.rows('salary_run_employees').every((row) => row.calculation_breakdown === null)).toBe(true)
    expect(db.rows('salary_runs')[0].calculation_params).toBeNull()
  })

  it('answers DATABASE_ERROR and writes nothing when a run-level read fails', async () => {
    const { db, result } = await calculate(roster(6), {
      failOn: ({ table, op }) => table === 'employee_benefits' && op === 'select',
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'DATABASE_ERROR',
      details: { message: 'injected failure: select employee_benefits', code: 'XX000' },
    })
    expect(writes(db)).toEqual([])
  })

  it('lets a failed absence read propagate, as before', async () => {
    await expect(
      calculate(roster(6), { failOn: ({ table }) => table === 'salary_absence_days' }),
    ).rejects.toThrow(/Failed to load absence/)
  })
})
