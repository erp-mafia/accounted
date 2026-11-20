/**
 * One rule behind every door: a write that changes an input the engine reads
 * leaves the run stale, so approval and booking refuse figures the engine did
 * not produce for the current inputs (calculation-state.ts).
 *
 * The first calculation below prints a 10 000 kr bonus that the voucher never
 * pays when the line door forgets this: 7210 stays at 40 000.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import { upsertAbsenceDay, upsertAbsenceRange, deleteAbsenceRange } from '../absence'
import { runCalculationState, rosterRowsWithoutCalculation } from '../calculation-state'
import { createEmployeeBenefit, deleteEmployeeBenefit, updateEmployeeBenefit } from '../employee-benefits'
import { updateEmployee } from '../employee-commands'
import {
  createEmployeeRecurringLine,
  deleteEmployeeRecurringLine,
  updateEmployeeRecurringLine,
} from '../employee-recurring-lines'
import { addOpenExpenseClaimsToPayslip } from '../expense-claim-lines'
import { changesCalculationInput } from '../invalidate-calculation'
import { setOpeningBalancesBulk } from '../opening-balances'
import { createPayslipLine, deletePayslipLine, updatePayslipLine } from '../payslip-lines'
import { runSalaryCalculation } from '../run-calculation'
import { addEmployeeToRun, removeEmployeeFromRun, setRunEmployeeSalary } from '../run-employees'
import { revertSalaryRunToDraft } from '../run-status-recall'
import { buildSalaryRunEntryLines, salaryRunDataFromRows, type SalaryRosterRow } from '../salary-entries'
import { createShiftPremiumRule, deleteShiftPremiumRule, updateShiftPremiumRule } from '../shift-premium-rules'
import { clearTaxTableCache } from '../tax-tables'
import { updateDraftSalaryRun } from '../update-run'
import { deleteWorkedDaysRange, replaceWorkedDay, upsertWorkedDays } from '../worked-days'
import { createPayrollFakeDb, type Row } from './payroll-fake-db'
import { PAYROLL_CONFIG_2026, draftRun, employee, line, rosterRow, skatteverketFetch } from './payroll-fixtures'

vi.mock('../personnummer', async (original) => ({
  ...(await original<typeof import('../personnummer')>()),
  decryptPersonnummer: () => '198504120000',
}))

const C = 'company-1'
const RUN = 'run-sep'
const APPROVED = 'run-aug'
const CALCULATED = { steps: [{ label: 'Bruttolön', formula: '', input: {}, output: 40000 }] }

const BENEFIT_INPUT = { benefit_type: 'other', description: 'Parkering', monthly_value: 500, valid_from: '2026-01-01' }
const RECURRING_INPUT = { item_type: 'gross_deduction_other', description: 'Cykel', amount: -500, valid_from: '2026-01-01' }
const RULE_INPUT = {
  name: 'OB kväll',
  day_of_week: [1, 2, 3, 4, 5],
  start_time: '18:00',
  end_time: '22:00',
  amount_form: 'percent_of_hourly',
  premium_percent: 50,
  valid_from: '2026-01-01',
  item_type: 'ob_weekday_evening',
  priority: 1,
  applies_to_all_employees: true,
  applies_to_employee_ids: [],
  is_active: true,
}

function seed() {
  const anna = employee(C, 'anna', { monthly_salary: 40000, personnummer: 'x' })
  const bo = employee(C, 'bo', { monthly_salary: 30000, personnummer: 'x' })
  const calculated = (runId: string, emp: Row) =>
    rosterRow(C, runId, emp, { calculation_breakdown: CALCULATED, gross_salary: emp.monthly_salary })
  const annaOnRun = calculated(RUN, anna)
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [{ company_id: C }],
    salary_runs: [
      draftRun(C, RUN, { period_year: 2026, period_month: 9, payment_date: '2026-09-25', calculation_params: {} }),
      draftRun(C, APPROVED, { status: 'approved', period_year: 2026, period_month: 8, payment_date: '2026-08-25', calculation_params: {} }),
    ],
    employees: [anna, bo],
    salary_run_employees: [annaOnRun, calculated(RUN, bo), calculated(APPROVED, anna)],
    salary_line_items: [
      line(C, annaOnRun.id as string, 'base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 40000 }),
      line(C, annaOnRun.id as string, 'bonus', { item_type: 'bonus', description: 'Bonus', amount: 1000 }),
    ],
    salary_absence_days: [],
    salary_worked_days: [],
    employee_benefits: [{ id: 'benefit-1', company_id: C, employee_id: 'anna', ...BENEFIT_INPUT, valid_to: null, metadata: {}, is_active: true }],
    employee_recurring_lines: [{ id: 'recurring-1', company_id: C, employee_id: 'anna', ...RECURRING_INPUT, account_number: null, benefit_type: null, valid_to: null, metadata: {}, is_active: true }],
    employee_opening_balances: [],
    expense_claims: [{ id: 'claim-1', company_id: C, employee_id: 'anna', status: 'registered', description: 'Tåg', expense_date: '2026-09-02', amount_sek: 420, liability_account: '2820' }],
    shift_premium_rules: [{ id: 'rule-1', company_id: C, ...RULE_INPUT }],
  }
}

type Db = ReturnType<typeof createPayrollFakeDb>

const fresh = () => createPayrollFakeDb(seed())
const rosterOf = (db: Db, runId: string) =>
  db.rows('salary_run_employees').filter((row) => row.salary_run_id === runId)
const stateOf = (db: Db, runId: string) =>
  runCalculationState(
    db.rows('salary_runs').find((run) => run.id === runId) as never,
    rosterOf(db, runId) as never,
  )
const staleEmployees = (db: Db, runId: string) =>
  rosterRowsWithoutCalculation(rosterOf(db, runId)).map((row) => row.employee_id).sort()

type Door = [name: string, write: (db: Db) => PromiseLike<{ ok: boolean }>, expected: string[]]
const lineTarget = { companyId: C, salaryRunId: RUN }
const annaOnly = ['anna']
const everyone = ['anna', 'bo']

// Every write to an input the engine reads, by door module.
const DOORS: Door[] = [
  ['createPayslipLine', (db) => createPayslipLine(db.supabase, { ...lineTarget, target: { employeeId: 'anna' }, input: { item_type: 'bonus', description: 'Bonus', amount: 10000, sort_order: 0 } as never }), annaOnly],
  ['updatePayslipLine', (db) => updatePayslipLine(db.supabase, { ...lineTarget, lineId: 'bonus', patch: { amount: 12000 } }), annaOnly],
  ['deletePayslipLine', (db) => deletePayslipLine(db.supabase, { ...lineTarget, lineId: 'bonus' }), annaOnly],
  ['addOpenExpenseClaimsToPayslip', (db) => addOpenExpenseClaimsToPayslip(db.supabase, { ...lineTarget, employeeId: 'anna' }), annaOnly],
  ['setRunEmployeeSalary', (db) => setRunEmployeeSalary(db.supabase, { ...lineTarget, employeeId: 'anna', monthlySalary: 41000 }), annaOnly],
  ['updateDraftSalaryRun', (db) => updateDraftSalaryRun(db.supabase, { ...lineTarget, patch: { payment_date: '2026-09-26' } }), everyone],
  ['removeEmployeeFromRun', (db) => removeEmployeeFromRun(db.supabase, { ...lineTarget, employeeId: 'bo' }), annaOnly],
  ['upsertAbsenceDay', (db) => upsertAbsenceDay(db.supabase, { companyId: C, employeeId: 'anna', day: { absence_date: '2026-09-07', absence_type: 'sick', hours: 8 } }), annaOnly],
  ['upsertAbsenceRange', (db) => upsertAbsenceRange(db.supabase, { companyId: C, employeeId: 'anna', from: '2026-09-07', to: '2026-09-08', absenceType: 'sick', hoursPerDay: 8 }), annaOnly],
  ['deleteAbsenceRange', (db) => deleteAbsenceRange(db.supabase, { companyId: C, employeeId: 'anna', from: '2026-09-07', to: '2026-09-08' }), annaOnly],
  ['replaceWorkedDay', (db) => replaceWorkedDay(db.supabase, { companyId: C, employeeId: 'anna', day: { work_date: '2026-09-07', hours: 8 } }), annaOnly],
  ['upsertWorkedDays', (db) => upsertWorkedDays(db.supabase, { companyId: C, employeeId: 'anna', days: [{ work_date: '2026-09-07', hours: 8 }] }), annaOnly],
  ['deleteWorkedDaysRange', (db) => deleteWorkedDaysRange(db.supabase, { companyId: C, employeeId: 'anna', from: '2026-09-07', to: '2026-09-08' }), annaOnly],
  ['createEmployeeBenefit', (db) => createEmployeeBenefit(db.supabase, { companyId: C, employeeId: 'anna', userId: 'u', input: BENEFIT_INPUT as never }), annaOnly],
  ['updateEmployeeBenefit', (db) => updateEmployeeBenefit(db.supabase, { companyId: C, employeeId: 'anna', benefitId: 'benefit-1', patch: { monthly_value: 700 } as never }), annaOnly],
  ['deleteEmployeeBenefit', (db) => deleteEmployeeBenefit(db.supabase, { companyId: C, employeeId: 'anna', benefitId: 'benefit-1' }), annaOnly],
  ['createEmployeeRecurringLine', (db) => createEmployeeRecurringLine(db.supabase, { companyId: C, employeeId: 'anna', userId: 'u', input: RECURRING_INPUT as never }), annaOnly],
  ['updateEmployeeRecurringLine', (db) => updateEmployeeRecurringLine(db.supabase, { companyId: C, employeeId: 'anna', lineId: 'recurring-1', patch: { amount: -700 } as never }), annaOnly],
  ['deleteEmployeeRecurringLine', (db) => deleteEmployeeRecurringLine(db.supabase, { companyId: C, employeeId: 'anna', lineId: 'recurring-1' }), annaOnly],
  ['updateEmployee, the tax table', (db) => updateEmployee(db.supabase, { companyId: C, employeeId: 'anna', patch: { tax_table_number: 34 } }), annaOnly],
  ['updateEmployee, F-skatt', (db) => updateEmployee(db.supabase, { companyId: C, employeeId: 'anna', patch: { f_skatt_status: 'f_skatt' } }), annaOnly],
  ['updateEmployee, the vacation rule', (db) => updateEmployee(db.supabase, { companyId: C, employeeId: 'anna', patch: { vacation_rule: 'sammaloneregeln' } }), annaOnly],
  ['updateEmployee, the salary', (db) => updateEmployee(db.supabase, { companyId: C, employeeId: 'anna', patch: { monthly_salary: 41000 } }), annaOnly],
  ['setOpeningBalancesBulk', (db) => setOpeningBalancesBulk(db.supabase, { companyId: C, userId: 'u', items: [{ employee_id: 'anna', cutover_date: '2026-01-01', ytd_gross: 0, ytd_tax: 0, ytd_net: 0, vacation_paid_days_remaining: 0, vacation_days_taken_this_year: 0, vacation_saved_days_by_year: {}, opening_semester_liability: 0, opening_semester_liability_avgifter: 0, karens_periods_adjustment: 2 }] }), annaOnly],
  ['createShiftPremiumRule', (db) => createShiftPremiumRule(db.supabase, { companyId: C, userId: 'u', input: RULE_INPUT as never }), everyone],
  ['updateShiftPremiumRule', (db) => updateShiftPremiumRule(db.supabase, { companyId: C, ruleId: 'rule-1', input: { name: 'OB natt' } as never }), everyone],
  ['deleteShiftPremiumRule', (db) => deleteShiftPremiumRule(db.supabase, { companyId: C, ruleId: 'rule-1' }), everyone],
]

describe('every write to an engine input leaves the run stale', () => {
  it.each(DOORS)('%s', async (_name, write, expected) => {
    const db = fresh()
    const result = await write(db)
    expect(result).toMatchObject({ ok: true })
    expect(stateOf(db, RUN)).toBe('stale')
    expect(staleEmployees(db, RUN)).toEqual(expected)
    // An approved run keeps what it was calculated with.
    expect(stateOf(db, APPROVED)).toBe('current')
    expect(staleEmployees(db, APPROVED)).toEqual([])
  })
})

/** One employee on a draft the engine can really calculate. */
function oneEmployeeDraft() {
  const emp = employee(C, 'anna', { monthly_salary: 40000, tax_table_number: 33, personnummer: 'x' })
  const sre = rosterRow(C, RUN, emp)
  return createPayrollFakeDb({
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [{ company_id: C, salary_net_rounding: false, salary_calculation_policy: {}, salary_vacation_year_basis: 'calendar' }],
    salary_runs: [draftRun(C, RUN, { period_year: 2026, period_month: 9, payment_date: '2026-09-25', voucher_series: 'A' })],
    employees: [emp],
    salary_run_employees: [sre],
    salary_line_items: [line(C, sre.id as string, 'base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 40000 })],
    employee_opening_balances: [],
    salary_absence_days: [],
    salary_worked_days: [],
    employee_benefits: [],
    employee_recurring_lines: [],
    shift_premium_rules: [],
  })
}

const calculateIn = (db: Db) => () =>
  runSalaryCalculation({ supabase: db.supabase, companyId: C, salaryRunId: RUN, log: createLogger('test'), requestId: 'r' })

describe('the line door, end to end', () => {
  beforeEach(() => {
    clearTaxTableCache()
    vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('a bonus added after the calculation is refused its old voucher: only a recalculation makes the run current', async () => {
    const db = oneEmployeeDraft()
    const calculate = calculateIn(db)

    expect(await calculate()).toMatchObject({ ok: true })
    expect(stateOf(db, RUN)).toBe('current')

    await createPayslipLine(db.supabase, { ...lineTarget, target: { employeeId: 'anna' }, input: { item_type: 'bonus', description: 'Bonus', amount: 10000, sort_order: 0 } as never })
    expect(stateOf(db, RUN)).toBe('stale')

    expect(await calculate()).toMatchObject({ ok: true })
    expect(stateOf(db, RUN)).toBe('current')
    const row = db.rows('salary_run_employees')[0] as unknown as SalaryRosterRow & { gross_salary: number }
    expect(row.gross_salary).toBe(50000)
    const booked = buildSalaryRunEntryLines(
      salaryRunDataFromRows(
        { id: RUN, period_year: 2026, period_month: 9, payment_date: '2026-09-25', voucher_series: 'A', total_gross: 50000, total_tax: 0, total_net: 0, total_avgifter: 0, total_vacation_accrual: 0, calculation_params: { avgifterTotal: 0.3142 } },
        [{ ...row, line_items: db.rows('salary_line_items'), employee: { employment_type: 'employee', personnel_category: 'tjansteman', default_dimensions: null, f_skatt_status: 'a_skatt' } } as never],
      ),
      'Lön',
      '1930',
    )
    expect(booked.salaryLines.find((l) => l.account_number === '7210')?.debit_amount).toBe(50000)
  })
})

describe('what does not touch the calculation', () => {
  it('a dry run leaves the run current', async () => {
    const db = fresh()
    await createPayslipLine(db.supabase, { ...lineTarget, target: { employeeId: 'anna' }, input: { item_type: 'bonus', description: 'Bonus', amount: 10000, sort_order: 0 } as never, dryRun: true })
    await updatePayslipLine(db.supabase, { ...lineTarget, lineId: 'bonus', patch: { amount: 12000 }, dryRun: true })
    await deletePayslipLine(db.supabase, { ...lineTarget, lineId: 'bonus', dryRun: true })
    await upsertAbsenceRange(db.supabase, { companyId: C, employeeId: 'anna', from: '2026-09-07', to: '2026-09-08', absenceType: 'sick', dryRun: true })
    await upsertWorkedDays(db.supabase, { companyId: C, employeeId: 'anna', days: [{ work_date: '2026-09-07', hours: 8 }], dryRun: true })
    await updateEmployee(db.supabase, { companyId: C, employeeId: 'anna', patch: { tax_table_number: 34 }, dryRun: true })
    expect(stateOf(db, RUN)).toBe('current')
  })

  it('an employee field the engine does not read leaves the run current', async () => {
    const db = fresh()
    await updateEmployee(db.supabase, { companyId: C, employeeId: 'anna', patch: { email: 'ny@example.se', clearing_number: '8327' } })
    expect(stateOf(db, RUN)).toBe('current')
  })

  it('an employee field saved unchanged leaves the run current', async () => {
    const db = fresh()
    await updateEmployee(db.supabase, { companyId: C, employeeId: 'anna', patch: { tax_table_number: 33, hours_per_week: 40 } })
    expect(stateOf(db, RUN)).toBe('current')
  })

  it('hours registered after the window leave the run current: a timesheet filled in daily does not undo it', async () => {
    const db = fresh()
    await upsertWorkedDays(db.supabase, { companyId: C, employeeId: 'anna', days: [{ work_date: '2026-10-01', hours: 8 }] })
    expect(stateOf(db, RUN)).toBe('current')
  })

  it('a sick day before the window reaches the run: the sjuklöneperiod looks back', async () => {
    const db = fresh()
    await upsertAbsenceDay(db.supabase, { companyId: C, employeeId: 'anna', day: { absence_date: '2026-07-30', absence_type: 'sick', hours: 8 } })
    expect(stateOf(db, RUN)).toBe('stale')
  })

  it('an absence after the window leaves the run current: next month\'s sick days are next month\'s', async () => {
    const db = fresh()
    await upsertAbsenceDay(db.supabase, { companyId: C, employeeId: 'anna', day: { absence_date: '2026-10-02', absence_type: 'sick', hours: 8 } })
    expect(stateOf(db, RUN)).toBe('current')
  })

  it('the convention that measures an episode past the window reads the month after it, and no further', async () => {
    const db = fresh()
    db.edit('salary_runs', RUN, {
      calculation_params: { salary_calculation_policy: { long_leave: 'calendar_after_five_workdays', leave_context: 'all_registered' } },
    })
    await upsertAbsenceDay(db.supabase, { companyId: C, employeeId: 'anna', day: { absence_date: '2026-11-02', absence_type: 'sick', hours: 8 } })
    expect(stateOf(db, RUN)).toBe('current')
    await upsertAbsenceDay(db.supabase, { companyId: C, employeeId: 'anna', day: { absence_date: '2026-10-02', absence_type: 'sick', hours: 8 } })
    expect(stateOf(db, RUN)).toBe('stale')
  })

  it('a window of the previous month is read as stored', async () => {
    const db = fresh()
    db.edit('salary_runs', RUN, { deviation_period_start: '2026-07-01', deviation_period_end: '2026-07-31' })
    await upsertWorkedDays(db.supabase, { companyId: C, employeeId: 'anna', days: [{ work_date: '2026-09-07', hours: 8 }] })
    expect(stateOf(db, RUN)).toBe('current')
    await upsertWorkedDays(db.supabase, { companyId: C, employeeId: 'anna', days: [{ work_date: '2026-07-31', hours: 8 }] })
    expect(stateOf(db, RUN)).toBe('stale')
  })
})

describe('a run in review', () => {
  const inReview = () => {
    const db = fresh()
    db.edit('salary_runs', RUN, { status: 'review' })
    return db
  }

  it('goes stale when an employee input changes', async () => {
    const db = inReview()
    await updateEmployee(db.supabase, { companyId: C, employeeId: 'anna', patch: { tax_table_number: 34 } })
    expect(stateOf(db, RUN)).toBe('stale')
  })

  describe('the way back', () => {
    beforeEach(() => {
      clearTaxTableCache()
      vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
    })
    afterEach(() => vi.unstubAllGlobals())

    it('runs through draft: review refuses the calculation, a revert and a calculation make the run current', async () => {
      const db = oneEmployeeDraft()
      const calculate = calculateIn(db)
      await calculate()
      db.edit('salary_runs', RUN, { status: 'review' })
      await updateEmployee(db.supabase, { companyId: C, employeeId: 'anna', patch: { tax_table_number: 34 } })
      expect(stateOf(db, RUN)).toBe('stale')

      expect(await calculate()).toMatchObject({
        ok: false,
        code: 'SALARY_RUN_CALCULATE_FAILED',
        details: { currentStatus: 'review', reason: 'not_draft' },
      })

      const ctx = { supabase: db.supabase, companyId: C, userId: 'u', log: createLogger('test') }
      expect(await revertSalaryRunToDraft(ctx, RUN)).toMatchObject({ ok: true })
      expect(await calculate()).toMatchObject({ ok: true })
      expect(stateOf(db, RUN)).toBe('current')
    })
  })
})

describe('the invalidation fails', () => {
  it('writes nothing: a run must never read current over an input it did not see', async () => {
    const db = createPayrollFakeDb(seed(), {
      failOn: ({ table, op }) => table === 'salary_run_employees' && op === 'update',
    })
    const before = db.rows('salary_line_items').length
    const result = await createPayslipLine(db.supabase, { ...lineTarget, target: { employeeId: 'anna' }, input: { item_type: 'bonus', description: 'Bonus', amount: 10000, sort_order: 0 } as never })
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
    expect(db.rows('salary_line_items')).toHaveLength(before)
  })
})

describe('adding an employee', () => {
  it('arrives without a calculation, as it always has', async () => {
    const db = fresh()
    db.edit('salary_run_employees', `sre-${RUN}-bo`, { employee_id: 'other' })
    expect(await addEmployeeToRun(db.supabase, { ...lineTarget, employeeId: 'bo' })).toMatchObject({ ok: true })
    expect(stateOf(db, RUN)).toBe('stale')
    expect(staleEmployees(db, RUN)).toEqual(['bo'])
  })
})

describe('the inputs, read from the code', () => {
  /** A file that writes an engine input table, by the table names of its write statements. */
  const INPUT_TABLES = [
    'salary_line_items',
    'salary_absence_days',
    'salary_worked_days',
    'employee_benefits',
    'employee_recurring_lines',
    'employee_opening_balances',
    'shift_premium_rules',
  ]
  // Writers that hold no calculated row. A new file is a door until it says otherwise.
  const NOT_A_DOOR = new Set([
    'src/lib/salary/run-calculation.ts', // the calculation itself
    'src/lib/salary/create-run.ts', // a new run: nothing calculated yet
    'src/lib/salary/correct-run.ts', // a new correction run: its breakdowns stay behind
    'src/lib/salary/base-salary-line.ts', // through setRunEmployeeSalary and the calculation
    'src/app/api/sandbox/seed/route.ts', // a seed writes whole runs
  ])

  it('every file that writes an input table takes the step', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], { encoding: 'utf8' })
      .split('\n')
      .filter((file) => /\.tsx?$/.test(file) && !file.includes('__tests__'))
    const writes = new RegExp(`from\\('(?:${INPUT_TABLES.join('|')})'\\)\\s*\\.(?:insert|update|upsert|delete)\\(`)
    const doors = files.filter((file) => writes.test(readFileSync(file, 'utf8')))
    expect(doors.length).toBeGreaterThan(5)
    expect(
      doors.filter((file) => !NOT_A_DOOR.has(file) && !readFileSync(file, 'utf8').includes('invalidateRunCalculation')),
    ).toEqual([])
  }, 30_000) // reads all of src: a shared runner's disk took more than the default 5 s

  it('every employee column the calculation reads invalidates it', () => {
    const source = readFileSync('src/lib/salary/run-calculation.ts', 'utf8')
    const read = new Set([...source.matchAll(/\bemp\.([a-z_]+)/g)].map((match) => match[1]))
    for (const display of ['id', 'first_name', 'last_name']) read.delete(display)
    expect(read.size).toBeGreaterThan(20)
    const stale = [...read].filter((column) => !changesCalculationInput({ [column]: 1 }, { [column]: 2 }))
    expect(stale).toEqual([])
  })
})
