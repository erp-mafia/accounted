/**
 * Semesterlön för rörliga lönedelar under sammalöneregeln (Semesterlagen
 * 16 a § tredje stycket, 26 § andra stycket, 29 §; issue #60 B).
 *
 * The pure rules first (what counts as variable pay, which payslips earn and
 * which settle it), then the run calculation over the in-memory payroll
 * tables: the first run after the semesterår pays the variable part once, a
 * final pay settles the running year, and an employee without variable pay
 * is calculated exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import { ADDITION_ITEM_TYPES } from '../calculation-engine'
import { clearTaxTableCache } from '../tax-tables'
import { runSalaryCalculation } from '../run-calculation'
import {
  VARIABLE_PAY_ITEM_TYPES,
  breakdownIsSammaloneregeln,
  isVariablePayLine,
  payslipVariableVacationPay,
  summarizePayslip,
  paidWithSalaryIssue,
  settledWithSalary,
  unpaidVariableVacationPayAtYearEnd,
  vacationYearLabel,
  variableVacationPaidWithSalary,
  type VariablePayRun,
} from '../variable-vacation-pay'
import { createPayrollFakeDb, type Row } from './payroll-fake-db'
import { draftRun, employee, line, PAYROLL_CONFIG_2026, rosterRow, skatteverketFetch } from './payroll-fixtures'

const SAMMALONE_BREAKDOWN = { steps: [{ label: 'Semesteravsättning (sammalöneregeln, tillägg 0,43 %)', output: 268.75 }] }
const PROCENT_BREAKDOWN = { steps: [{ label: 'Semesteravsättning (procentregeln 12 %)', output: 3600 }] }

function run(over: Partial<VariablePayRun> & { paymentDate: string }): VariablePayRun {
  return {
    salaryRunId: `run-${over.paymentDate}`,
    status: 'booked',
    sammaloneregeln: true,
    variablePay: 0,
    payout: 0,
    ...over,
  }
}

describe('what counts as variable pay', () => {
  it('is the engine\'s wage additions without semesterersättning', () => {
    expect([...VARIABLE_PAY_ITEM_TYPES].sort()).toEqual(
      ADDITION_ITEM_TYPES.filter((type) => type !== 'semesterersattning').sort(),
    )
  })

  it('needs the semester-base flag and a taxable, non-deduction addition', () => {
    const ob = { itemType: 'ob_night' as const, amount: 100, isTaxable: true, isVacationBasis: true, isGrossDeduction: false, isNetDeduction: false }
    expect(isVariablePayLine(ob)).toBe(true)
    expect(isVariablePayLine({ ...ob, isVacationBasis: false })).toBe(false)
    expect(isVariablePayLine({ ...ob, isTaxable: false })).toBe(false)
    expect(isVariablePayLine({ ...ob, itemType: 'semesterersattning' })).toBe(false)
    expect(isVariablePayLine({ ...ob, itemType: 'sick_day2_14', amount: -100, isGrossDeduction: true })).toBe(false)
  })

  it('leaves out the payslip\'s own Grundlön/Timlön row but counts extra hours at timlön (crm#1331)', () => {
    const stored = (item_type: string, amount: number) => ({
      item_type,
      amount,
      is_taxable: true,
      is_vacation_basis: true,
      is_gross_deduction: false,
      is_net_deduction: false,
    })
    const base = {
      salaryRunId: 'r',
      paymentDate: '2026-01-25',
      status: 'booked',
      calculationBreakdown: SAMMALONE_BREAKDOWN,
      lines: [stored('monthly_salary', 30000), stored('hourly_salary', 2000), stored('ob_night', 500)],
    }
    // Monthly pay: Grundlön shows the fixed base, the Timlön row is mertid.
    expect(summarizePayslip({ ...base, salaryType: 'monthly' }).variablePay).toBe(2500)
    // Hourly pay: Timlön is the display, a Grundlön row would be pay on top.
    expect(summarizePayslip({ ...base, salaryType: 'hourly' }).variablePay).toBe(30500)
    // Pay type unknown: neither base-salary row counts, the reading before crm#1331.
    expect(summarizePayslip(base).variablePay).toBe(500)
  })

  it('counts a payout only on a payslip calculated under sammalöneregeln', () => {
    const payoutLine = {
      item_type: 'semesterersattning',
      amount: 900,
      is_taxable: true,
      is_vacation_basis: false,
      is_gross_deduction: false,
      is_net_deduction: false,
      calculation_source: 'vacation_compensation',
    }
    const base = { salaryRunId: 'r', paymentDate: '2026-01-25', status: 'booked', lines: [payoutLine] }
    expect(summarizePayslip({ ...base, calculationBreakdown: SAMMALONE_BREAKDOWN }).payout).toBe(900)
    // vacation_rule 'semesterersattning': the same provenance is that rule's own payout.
    expect(
      summarizePayslip({ ...base, calculationBreakdown: { steps: [{ label: 'Semesteravsättning (semesterersättning betald direkt)' }] } }).payout,
    ).toBe(0)
  })

  it('reads the rule a payslip was calculated under from its breakdown', () => {
    expect(breakdownIsSammaloneregeln(SAMMALONE_BREAKDOWN)).toBe(true)
    expect(breakdownIsSammaloneregeln(PROCENT_BREAKDOWN)).toBe(false)
    expect(breakdownIsSammaloneregeln(null)).toBe(false)
    expect(breakdownIsSammaloneregeln({ steps: 'nope' })).toBe(false)
  })
})

describe('payslipVariableVacationPay', () => {
  const history = [
    run({ paymentDate: '2025-12-25', variablePay: 9999 }), // two years back: outside
    run({ paymentDate: '2026-03-25', variablePay: 5000 }),
    run({ paymentDate: '2026-06-25', variablePay: 2500 }),
    run({ paymentDate: '2026-07-25', variablePay: 1000, sammaloneregeln: false }), // procentregeln
    run({ paymentDate: '2026-08-25', variablePay: 4000, status: 'review' }), // not fallen due
    run({ paymentDate: '2026-09-25', variablePay: 3000, status: 'corrected' }), // superseded
  ]

  it('pays 12 % of the previous semesterår in the first run after it', () => {
    const result = payslipVariableVacationPay({
      paymentDate: '2027-01-25',
      basis: 'calendar',
      rate: 0.12,
      runs: history,
      finalSettlement: false,
      thisRunVariablePay: 800,
    })
    expect(result.yearStart).toBe('2026-01-01')
    expect(result.owed).toMatchObject({ variablePay: 7500, runCount: 2, owed: 900, alreadyPaid: 0, unpaid: 900 })
  })

  it('pays nothing more once an earlier payslip of the year paid it, whatever its status', () => {
    for (const status of ['draft', 'review', 'approved', 'booked']) {
      const result = payslipVariableVacationPay({
        paymentDate: '2027-02-25',
        basis: 'calendar',
        rate: 0.12,
        runs: [...history, run({ paymentDate: '2027-01-25', payout: 900, status })],
        finalSettlement: false,
        thisRunVariablePay: 0,
      })
      expect(result.owed.unpaid).toBe(0)
    }
  })

  it('a corrected payslip\'s payout does not count: its correction run pays again', () => {
    const result = payslipVariableVacationPay({
      paymentDate: '2027-01-25',
      basis: 'calendar',
      rate: 0.12,
      runs: [...history, run({ paymentDate: '2027-01-25', payout: 900, status: 'corrected' })],
      finalSettlement: false,
      thisRunVariablePay: 0,
    })
    expect(result.owed.unpaid).toBe(900)
  })

  it('tops up when variable pay of the year was approved after the payout', () => {
    const result = payslipVariableVacationPay({
      paymentDate: '2027-02-25',
      basis: 'calendar',
      rate: 0.12,
      runs: [
        ...history,
        run({ paymentDate: '2026-12-25', variablePay: 1000 }),
        run({ paymentDate: '2027-01-25', payout: 900 }),
      ],
      finalSettlement: false,
      thisRunVariablePay: 0,
    })
    expect(result.owed.unpaid).toBe(120)
  })

  it('pays nothing during the year the variable pay is earned', () => {
    const result = payslipVariableVacationPay({
      paymentDate: '2026-10-25',
      basis: 'calendar',
      rate: 0.12,
      runs: history.filter((r) => r.paymentDate >= '2026-01-01'),
      finalSettlement: false,
      thisRunVariablePay: 500,
    })
    expect(result.owed.unpaid).toBe(0)
  })

  it('a final pay settles the running year too, this payslip included (29 §)', () => {
    const result = payslipVariableVacationPay({
      paymentDate: '2026-10-25',
      basis: 'calendar',
      rate: 0.12,
      runs: [...history, run({ paymentDate: '2026-01-25', payout: 300 })],
      finalSettlement: true,
      thisRunVariablePay: 500,
    })
    // 2025-12 (9999) + 2026 due sammalöne pay (7500) + this payslip (500), less 300 paid in 2026.
    expect(result.owed.variablePay).toBe(17999)
    expect(result.owed.unpaid).toBe(Math.round((17999 * 0.12 - 300) * 100) / 100)
  })

  it('follows the April to March semesterår', () => {
    const result = payslipVariableVacationPay({
      paymentDate: '2027-04-25',
      basis: 'statutory_apr_mar',
      rate: 0.12,
      runs: [
        run({ paymentDate: '2026-03-25', variablePay: 5000 }), // previous semesterår
        run({ paymentDate: '2026-04-25', variablePay: 1000 }),
        run({ paymentDate: '2027-03-25', variablePay: 2000 }),
      ],
      finalSettlement: false,
      thisRunVariablePay: 0,
    })
    expect(result.yearStart).toBe('2026-04-01')
    expect(result.owed.unpaid).toBe(360)
    expect(vacationYearLabel('2026-04-01', 'statutory_apr_mar')).toBe('2026/2027')
    expect(vacationYearLabel('2026-01-01', 'calendar')).toBe('2026')
  })
})

describe('unpaidVariableVacationPayAtYearEnd', () => {
  it('is the closing year\'s variable part once the year before was paid', () => {
    const result = unpaidVariableVacationPayAtYearEnd({
      closingYearStart: '2026-01-01',
      rate: 0.12,
      runs: [
        run({ paymentDate: '2025-06-25', variablePay: 3000 }),
        run({ paymentDate: '2026-01-25', payout: 360 }),
        run({ paymentDate: '2026-05-25', variablePay: 5000 }),
        run({ paymentDate: '2027-01-25', payout: 600 }), // after the year end: still unpaid then
      ],
    })
    expect(result.unpaid).toBe(600)
  })

  it('is nothing after a final pay settled the year', () => {
    const result = unpaidVariableVacationPayAtYearEnd({
      closingYearStart: '2026-01-01',
      rate: 0.12,
      runs: [run({ paymentDate: '2026-05-25', variablePay: 5000 }), run({ paymentDate: '2026-06-25', payout: 600 })],
    })
    expect(result.unpaid).toBe(0)
  })
})

describe('semesterlön for rörliga lönedelar paid with the salary under a kollektivavtal', () => {
  const paidRow = (over: Record<string, unknown> = {}) => ({
    item_type: 'semesterersattning',
    amount: 600,
    is_taxable: true,
    is_vacation_basis: false,
    is_gross_deduction: false,
    is_net_deduction: false,
    calculation_source: null,
    settles_variable_vacation_pay: true,
    ...over,
  })

  it('is only the marked semesterersättning rows, never an unmarked one or the engine\'s payout', () => {
    expect(
      variableVacationPaidWithSalary([
        { itemType: 'semesterersattning', amount: 600, settlesVariableVacationPay: true },
        { itemType: 'semesterersattning', amount: 999 },
        { itemType: 'bonus', amount: 5000, settlesVariableVacationPay: true },
      ]),
    ).toBe(600)
    const base = { salaryRunId: 'r', paymentDate: '2026-03-25', status: 'booked', calculationBreakdown: SAMMALONE_BREAKDOWN }
    expect(summarizePayslip({ ...base, lines: [paidRow()] })).toMatchObject({ paidWithSalary: 600, payout: 0, variablePay: 0 })
    // A hand-entered semesterersättning row without the mark settles nothing.
    expect(summarizePayslip({ ...base, lines: [paidRow({ settles_variable_vacation_pay: false })] }).paidWithSalary).toBe(0)
    // Before the migration the column is absent.
    expect(summarizePayslip({ ...base, lines: [paidRow({ settles_variable_vacation_pay: undefined })] }).paidWithSalary).toBe(0)
    // The engine's own row is the payout, never a payment with the salary.
    expect(
      summarizePayslip({ ...base, lines: [paidRow({ calculation_source: 'vacation_compensation' })] }),
    ).toMatchObject({ paidWithSalary: 0, payout: 600 })
    // A payslip calculated under procentregeln settled nothing of this.
    expect(summarizePayslip({ ...base, calculationBreakdown: PROCENT_BREAKDOWN, lines: [paidRow()] }).paidWithSalary).toBe(0)
  })

  it('lowers the payout after the semesterår by what the year\'s payslips paid with the salary', () => {
    const result = payslipVariableVacationPay({
      paymentDate: '2027-01-25',
      basis: 'calendar',
      rate: 0.12,
      runs: [
        run({ paymentDate: '2026-03-25', variablePay: 5000, paidWithSalary: 600 }),
        run({ paymentDate: '2026-06-25', variablePay: 2500, paidWithSalary: 300 }),
      ],
      finalSettlement: false,
      thisRunVariablePay: 0,
    })
    expect(result.owed).toMatchObject({ variablePay: 7500, owed: 900, paidWithSalary: 900, alreadyPaid: 900, unpaid: 0 })
  })

  it('a payment settles its own payslip\'s variable pay and nothing else', () => {
    // 12 % of 5 000 is 600: a larger payment settles 600, a negative one nothing.
    expect(settledWithSalary(600, 5000, 0.12)).toBe(600)
    expect(settledWithSalary(400, 5000, 0.12)).toBe(400)
    expect(settledWithSalary(900, 5000, 0.12)).toBe(600)
    expect(settledWithSalary(600, 0, 0.12)).toBe(0)
    expect(settledWithSalary(-600, 5000, 0.12)).toBe(0)
    // A payment on a later payslip settles nothing of the earlier one's pay:
    // the payout after the semesterår pays December's semesterlön in full.
    const result = payslipVariableVacationPay({
      paymentDate: '2027-01-25',
      basis: 'calendar',
      rate: 0.12,
      runs: [
        run({ paymentDate: '2026-12-25', variablePay: 5000 }),
        run({ paymentDate: '2026-12-28', paidWithSalary: 600 }),
      ],
      finalSettlement: false,
      thisRunVariablePay: 0,
      thisRunPaidWithSalary: 600,
    })
    expect(result.owed).toMatchObject({ owed: 600, paidWithSalary: 0, unpaid: 600 })
  })

  it('the calculation refuses a payment it would pay again, and the mark outside sammalöneregeln', () => {
    const marked = (amount: number) => ({ itemType: 'semesterersattning' as const, amount, settlesVariableVacationPay: true })
    const base = { vacationRule: 'sammaloneregeln', variablePay: 5000, rate: 0.12 }
    expect(paidWithSalaryIssue({ ...base, lines: [marked(600)] })).toBeNull()
    expect(paidWithSalaryIssue({ ...base, lines: [{ itemType: 'semesterersattning', amount: 900 }] })).toBeNull()
    expect(paidWithSalaryIssue({ ...base, lines: [marked(600), marked(0.01)] })).toEqual({ reason: 'above_own', paid: 600.01, own: 600 })
    // Last month's variable pay, paid on this payslip.
    expect(paidWithSalaryIssue({ ...base, variablePay: 0, lines: [marked(600)] })).toEqual({ reason: 'above_own', paid: 600, own: 0 })
    expect(paidWithSalaryIssue({ ...base, lines: [marked(-600)] })).toEqual({ reason: 'not_positive' })
    expect(paidWithSalaryIssue({ ...base, vacationRule: 'procentregeln', lines: [marked(600)] })).toEqual({ reason: 'not_sammaloneregeln' })
  })

  it('counts only payslips that have fallen due, under sammalöneregeln, in the year they settle', () => {
    const result = payslipVariableVacationPay({
      paymentDate: '2027-01-25',
      basis: 'calendar',
      rate: 0.144,
      runs: [
        run({ paymentDate: '2026-03-25', variablePay: 5000, paidWithSalary: 600 }),
        run({ paymentDate: '2026-04-25', paidWithSalary: 200, status: 'draft' }), // not paid yet
        run({ paymentDate: '2026-05-25', paidWithSalary: 200, status: 'corrected' }), // superseded
        run({ paymentDate: '2026-06-25', paidWithSalary: 200, sammaloneregeln: false }), // procentregeln
        run({ paymentDate: '2025-12-25', paidWithSalary: 200 }), // settles 2025, not 2026
        run({ paymentDate: '2027-01-10', paidWithSalary: 200 }), // settles 2027
      ],
      finalSettlement: false,
      thisRunVariablePay: 0,
      // This payslip's own payment settles 2027, which this payout does not cover.
      thisRunPaidWithSalary: 500,
    })
    // 14,4 % of 5 000 = 720, less the 600 paid with the March salary.
    expect(result.owed).toMatchObject({ owed: 720, paidWithSalary: 600, unpaid: 120 })
  })

  it('a final pay counts what it pays with the salary itself (29 §)', () => {
    const result = payslipVariableVacationPay({
      paymentDate: '2026-10-25',
      basis: 'calendar',
      rate: 0.12,
      runs: [run({ paymentDate: '2026-03-25', variablePay: 5000, paidWithSalary: 600 })],
      finalSettlement: true,
      thisRunVariablePay: 1000,
      thisRunPaidWithSalary: 120,
    })
    expect(result.owed).toMatchObject({ variablePay: 6000, owed: 720, paidWithSalary: 720, unpaid: 0 })
  })

  it('lowers the year-end liability the same way', () => {
    const result = unpaidVariableVacationPayAtYearEnd({
      closingYearStart: '2026-01-01',
      rate: 0.12,
      runs: [
        run({ paymentDate: '2026-05-25', variablePay: 5000, paidWithSalary: 600 }),
        run({ paymentDate: '2026-09-25', variablePay: 2500 }),
      ],
    })
    expect(result.unpaid).toBe(300)
  })
})

// ---------------------------------------------------------------------------
// The run calculation over the in-memory payroll tables
// ---------------------------------------------------------------------------

const COMPANY = 'company-variable'
const RUN = 'run-2026-01'
const EMP = 'emp-samma'

function payslipRows(runId: string, paymentDate: string, emp: Row, lines: Row[], over: { status?: string; breakdown?: unknown } = {}) {
  const sre = rosterRow(COMPANY, runId, emp, { calculation_breakdown: over.breakdown ?? SAMMALONE_BREAKDOWN })
  return {
    run: draftRun(COMPANY, runId, {
      period_year: Number(paymentDate.slice(0, 4)),
      period_month: Number(paymentDate.slice(5, 7)),
      payment_date: paymentDate,
      status: over.status ?? 'booked',
    }),
    sre,
    lines: lines.map((fields, idx) => line(COMPANY, sre.id as string, `li-${runId}-${idx}`, fields)),
  }
}

const OB = (amount: number): Row => ({ item_type: 'ob_weekend', description: 'OB helg', amount })
// On the run being calculated, OB is derived from worked days and premium
// rules (a stored OB row is replaced); a hand-entered bonus is the variable
// pay the calculation reads as it is.
const BONUS = (amount: number): Row => ({ item_type: 'bonus', description: 'Bonus', amount })
const GRUNDLON: Row = { item_type: 'monthly_salary', description: 'Grundlön', amount: 30000 }

function seed(emp: Row, history: Array<ReturnType<typeof payslipRows>>, current: { lines?: Row[]; paymentDate?: string } = {}) {
  const paymentDate = current.paymentDate ?? '2026-01-25'
  const draft = payslipRows(RUN, paymentDate, emp, [GRUNDLON, ...(current.lines ?? [])], { status: 'draft', breakdown: null })
  const all = [...history, draft]
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [{ company_id: COMPANY, salary_net_rounding: false, salary_calculation_policy: {} }],
    salary_runs: all.map((p) => p.run),
    employees: [emp],
    salary_run_employees: all.map((p) => p.sre),
    salary_line_items: all.flatMap((p) => p.lines),
    employee_opening_balances: [],
    salary_absence_days: [],
    salary_worked_days: [],
    shift_premium_rules: [],
    employee_benefits: [],
    employee_recurring_lines: [],
  }
}

async function calculate(db: ReturnType<typeof createPayrollFakeDb>) {
  return runSalaryCalculation({
    supabase: db.supabase,
    companyId: COMPANY,
    salaryRunId: RUN,
    log: createLogger('test/variable-vacation-pay'),
    requestId: 'req_variable',
  })
}

const currentLines = (db: ReturnType<typeof createPayrollFakeDb>) =>
  db.rows('salary_line_items').filter((li) => li.salary_run_employee_id === `sre-${RUN}-${EMP}`)
const currentRow = (db: ReturnType<typeof createPayrollFakeDb>) =>
  db.rows('salary_run_employees').find((r) => r.id === `sre-${RUN}-${EMP}`) as Row

describe('runSalaryCalculation: semesterlön för rörliga lönedelar', () => {
  beforeEach(() => {
    clearTaxTableCache()
    vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const samma = employee(COMPANY, EMP, { vacation_rule: 'sammaloneregeln' })
  const history2025 = [
    payslipRows('run-2025-03', '2025-03-25', samma, [GRUNDLON, OB(5000)]),
    payslipRows('run-2025-06', '2025-06-25', samma, [GRUNDLON, OB(2500)]),
  ]

  it('pays 12 % of last semesterår\'s variable pay in the first run after it, once', async () => {
    const db = createPayrollFakeDb(seed(samma, history2025))
    const result = await calculate(db)
    expect(result.ok).toBe(true)
    const payout = currentLines(db).filter((li) => li.item_type === 'semesterersattning')
    expect(payout).toHaveLength(1)
    expect(payout[0]).toMatchObject({
      description: 'Semesterlön rörliga lönedelar 2025',
      amount: 900,
      calculation_source: 'vacation_compensation',
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: false,
    })
    const row = currentRow(db)
    expect(row.gross_salary).toBe(30900)
    // The payout is semesterlön, not semesterlönegrundande: the accrual is the tillägg only.
    expect(row.vacation_accrual).toBe(268.75)
    const steps = (row.calculation_breakdown as { steps: Array<{ label: string; input: Record<string, unknown> }> }).steps
    const step = steps.find((s) => s.label.startsWith('Semesterlön rörliga lönedelar 2025'))
    expect(step?.input).toMatchObject({ variable_pay: 7500, rate: 0.12, payslips: 2, already_paid: 0 })
    if (result.ok) expect(result.warnings.some((w) => w.includes('Semesterlön för rörliga lönedelar'))).toBe(true)

    // Recalculating replaces the row instead of adding a second one.
    const again = await calculate(db)
    expect(again.ok).toBe(true)
    expect(currentLines(db).filter((li) => li.item_type === 'semesterersattning')).toHaveLength(1)
    expect(currentRow(db).gross_salary).toBe(30900)
  })

  it('pays nothing when an earlier run of the year already paid it', async () => {
    const paid = payslipRows('run-2026-01-extra', '2026-01-20', samma, [
      GRUNDLON,
      { item_type: 'semesterersattning', description: 'Semesterlön rörliga lönedelar 2025', amount: 900, is_vacation_basis: false, calculation_source: 'vacation_compensation' },
    ])
    const db = createPayrollFakeDb(seed(samma, [...history2025, paid]))
    const result = await calculate(db)
    expect(result.ok).toBe(true)
    expect(currentLines(db).filter((li) => li.item_type === 'semesterersattning')).toHaveLength(0)
    expect(currentRow(db).gross_salary).toBe(30000)
  })

  it('accrues 12 % of this run\'s variable pay on 2920 during the year', async () => {
    const db = createPayrollFakeDb(seed(samma, [], { paymentDate: '2026-10-25', lines: [BONUS(5000)] }))
    const result = await calculate(db)
    expect(result.ok).toBe(true)
    expect(currentRow(db).vacation_accrual).toBe(868.75)
    expect(currentLines(db).filter((li) => li.item_type === 'semesterersattning')).toHaveLength(0)
  })

  it('a final pay settles the running year with it (29 §)', async () => {
    const leaving = employee(COMPANY, EMP, { vacation_rule: 'sammaloneregeln', employment_end: '2026-01-31' })
    const history = [
      payslipRows('run-2025-03', '2025-03-25', leaving, [GRUNDLON, OB(5000)]),
      payslipRows('run-2025-06', '2025-06-25', leaving, [GRUNDLON, OB(2500)]),
    ]
    const db = createPayrollFakeDb(seed(leaving, history, { lines: [BONUS(1000)] }))
    const result = await calculate(db)
    expect(result.ok).toBe(true)
    const payout = currentLines(db).filter((li) => li.item_type === 'semesterersattning')
    expect(payout).toHaveLength(1)
    expect(payout[0]).toMatchObject({ description: 'Semesterlön rörliga lönedelar 2025 och 2026', amount: 1020 })
  })

  it('leaves payslips calculated under procentregeln out: their 12 % base already had the OB', async () => {
    const switched = [payslipRows('run-2025-03', '2025-03-25', samma, [GRUNDLON, OB(5000)], { breakdown: PROCENT_BREAKDOWN })]
    const db = createPayrollFakeDb(seed(samma, switched))
    const result = await calculate(db)
    expect(result.ok).toBe(true)
    expect(currentLines(db).filter((li) => li.item_type === 'semesterersattning')).toHaveLength(0)
  })

  it('an employee without variable pay is calculated as before, without reading other payslips for procentregeln', async () => {
    const plain = employee(COMPANY, EMP, { vacation_rule: 'sammaloneregeln' })
    const db = createPayrollFakeDb(seed(plain, [payslipRows('run-2025-03', '2025-03-25', plain, [GRUNDLON])]))
    const result = await calculate(db)
    expect(result.ok).toBe(true)
    expect(currentLines(db).filter((li) => li.item_type === 'semesterersattning')).toHaveLength(0)
    expect(currentRow(db).gross_salary).toBe(30000)
    expect(currentRow(db).vacation_accrual).toBe(268.75)
    if (result.ok) expect(result.warnings.some((w) => w.includes('rörliga lönedelar'))).toBe(false)

    const historyReads = (fake: ReturnType<typeof createPayrollFakeDb>) =>
      fake.queries.filter((q) => q.table === 'salary_run_employees' && q.op === 'select').length
    const procentDb = createPayrollFakeDb(seed(employee(COMPANY, EMP), []))
    expect((await calculate(procentDb)).ok).toBe(true)
    clearTaxTableCache()
    const sammaDb = createPayrollFakeDb(seed(plain, []))
    expect((await calculate(sammaDb)).ok).toBe(true)
    // One more read, and only for a roster with someone on sammalöneregeln.
    expect(historyReads(sammaDb)).toBe(historyReads(procentDb) + 1)
  })

  // Semesterlön for the variable pay paid with the salary under a central
  // kollektivavtal (Semesterlagen 2 a § andra stycket): a marked
  // semesterersättning row, entered by hand.
  const PAID_WITH_SALARY = (amount: number, settles = true): Row => ({
    item_type: 'semesterersattning',
    description: 'Semesterlön rörliga lönedelar',
    amount,
    is_vacation_basis: false,
    settles_variable_vacation_pay: settles,
  })

  it('pays nothing after the semesterår when the year\'s payslips paid it with the salary', async () => {
    const paidMonthly = [
      payslipRows('run-2025-03', '2025-03-25', samma, [GRUNDLON, OB(5000), PAID_WITH_SALARY(600)]),
      payslipRows('run-2025-06', '2025-06-25', samma, [GRUNDLON, OB(2500), PAID_WITH_SALARY(300)]),
    ]
    const db = createPayrollFakeDb(seed(samma, paidMonthly))
    const result = await calculate(db)
    expect(result.ok).toBe(true)
    expect(currentLines(db).filter((li) => li.calculation_source === 'vacation_compensation')).toHaveLength(0)
    expect(currentRow(db).gross_salary).toBe(30000)
  })

  it('pays only what the salary did not: an unmarked semesterersättning row settles nothing', async () => {
    const partly = [
      payslipRows('run-2025-03', '2025-03-25', samma, [GRUNDLON, OB(5000), PAID_WITH_SALARY(600)]),
      payslipRows('run-2025-06', '2025-06-25', samma, [GRUNDLON, OB(2500), PAID_WITH_SALARY(300, false)]),
    ]
    const db = createPayrollFakeDb(seed(samma, partly))
    const result = await calculate(db)
    expect(result.ok).toBe(true)
    const payout = currentLines(db).filter((li) => li.calculation_source === 'vacation_compensation')
    expect(payout).toHaveLength(1)
    expect(payout[0].amount).toBe(300)
    const steps = (currentRow(db).calculation_breakdown as { steps: Array<{ label: string; input: Record<string, unknown> }> }).steps
    expect(steps.find((s) => s.label.startsWith('Semesterlön rörliga lönedelar 2025'))?.input).toMatchObject({
      variable_pay: 7500,
      already_paid: 600,
    })
  })

  it('accrues nothing on 2920 for the variable pay this salary pays its semesterlön on', async () => {
    const db = createPayrollFakeDb(seed(samma, [], { paymentDate: '2026-10-25', lines: [BONUS(5000), PAID_WITH_SALARY(600)] }))
    const result = await calculate(db)
    expect(result.ok).toBe(true)
    const row = currentRow(db)
    // The tillägg only: 12 % of the bonus was paid with the salary.
    expect(row.vacation_accrual).toBe(268.75)
    expect(row.gross_salary).toBe(35600)
    // The row is kept as entered, and no payout is derived during the year.
    const rows = currentLines(db).filter((li) => li.item_type === 'semesterersattning')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amount: 600, calculation_source: null, settles_variable_vacation_pay: true })
  })

  it('accrues the rest when the salary pays less than the rate, and never less than the tillägg', async () => {
    const short = createPayrollFakeDb(seed(samma, [], { paymentDate: '2026-10-25', lines: [BONUS(5000), PAID_WITH_SALARY(400)] }))
    expect((await calculate(short)).ok).toBe(true)
    expect(currentRow(short).vacation_accrual).toBe(468.75)


    clearTaxTableCache()
    const unmarked = createPayrollFakeDb(
      seed(samma, [], { paymentDate: '2026-10-25', lines: [BONUS(5000), PAID_WITH_SALARY(600, false)] }),
    )
    expect((await calculate(unmarked)).ok).toBe(true)
    expect(currentRow(unmarked).vacation_accrual).toBe(868.75)
  })

  it('refuses a payslip that pays more than its own variable pay earns, before anything is written', async () => {
    // December's OB unpaid, its semesterlön paid with the January salary: the
    // payout after the semesterår would pay it a second time.
    const december = [payslipRows('run-2025-12', '2025-12-25', samma, [GRUNDLON, OB(5000)])]
    const db = createPayrollFakeDb(seed(samma, december, { lines: [PAID_WITH_SALARY(600)] }))
    const result = await calculate(db)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_RUN_VARIABLE_VACATION_PAY_WITH_SALARY_INVALID')
      expect(result.messageSv).toContain('Lägg raden på samma lönebesked')
    }
    expect(currentLines(db).filter((li) => li.calculation_source === 'vacation_compensation')).toHaveLength(0)
    // Nothing written: the roster row keeps its seeded figures.
    expect(currentRow(db).gross_salary).toBe(0)

    clearTaxTableCache()
    const more = createPayrollFakeDb(seed(samma, [], { paymentDate: '2026-10-25', lines: [BONUS(1000), PAID_WITH_SALARY(600)] }))
    const refused = await calculate(more)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('SALARY_RUN_VARIABLE_VACATION_PAY_WITH_SALARY_INVALID')
  })

  it('refuses the mark on an employee who is no longer on sammalöneregeln', async () => {
    const procent = employee(COMPANY, EMP, { vacation_rule: 'procentregeln' })
    const db = createPayrollFakeDb(seed(procent, [], { paymentDate: '2026-10-25', lines: [BONUS(5000), PAID_WITH_SALARY(600)] }))
    const result = await calculate(db)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_RUN_VARIABLE_VACATION_PAY_WITH_SALARY_INVALID')
  })
})
