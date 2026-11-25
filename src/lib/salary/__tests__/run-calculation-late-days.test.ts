/**
 * Late days in the calculation: register days from an earlier, already paid
 * or declared period, carried to a later run (carried_to_run_id,
 * lib/salary/late-days.ts).
 *
 * The case behind it: parental leave in October became known after the
 * October run was paid. The days could not be registered (the October
 * window was locked), so the November pay carried a deduction typed in by
 * hand and the November AGI had no frånvarouppgifter for them, which belong
 * in the period whose pay the absence reduces (Skatteverket, Teknisk
 * beskrivning 1.1.18.2, 5.6). Now the days are registered on their October
 * dates and carried to November: November deducts them like its own days and
 * names them on the payslip, and no run reading October's window does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import { clearTaxTableCache } from '../tax-tables'
import { createPayrollFakeDb, type Row } from './payroll-fake-db'
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
import { runSalaryCalculation } from '../run-calculation'

const C = 'company-late'
const OCTOBER = 'run-2026-10'
const NOVEMBER = 'run-2026-11'

/** Parental leave Monday 5 to Friday 23 October: 15 working days, registered late. */
const LATE_PARENTAL: Array<[string, string]> = [
  '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
  '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16',
  '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23',
].map((date) => [date, 'parental'])

function carried(rows: Row[], runId: string): Row[] {
  return rows.map((row) => ({ ...row, carried_to_run_id: runId }))
}

/**
 * A company with a booked October (window October) and a November draft
 * (window November). `extra` adds rows to any table.
 */
function scenario(opts: {
  emp?: Row
  absences?: Row[]
  workedDays?: Row[]
  runs?: Row[]
  calculate?: string
  policy?: Record<string, unknown>
  lines?: Row[]
}): { seed: Record<string, Row[]>; runId: string; sreId: string } {
  const emp = opts.emp ?? employee(C, 'emp-anna', { first_name: 'Anna', monthly_salary: 42000 })
  const runId = opts.calculate ?? NOVEMBER
  const runs = opts.runs ?? [
    draftRun(C, OCTOBER, {
      status: 'booked',
      period_year: 2026,
      period_month: 10,
      payment_date: '2026-10-23',
      deviation_period_start: '2026-10-01',
      deviation_period_end: '2026-10-31',
    }),
    draftRun(C, NOVEMBER, {
      period_year: 2026,
      period_month: 11,
      payment_date: '2026-11-25',
      deviation_period_start: '2026-11-01',
      deviation_period_end: '2026-11-30',
    }),
  ]
  const sre = rosterRow(C, runId, emp)
  return {
    runId,
    sreId: sre.id as string,
    seed: {
      salary_payroll_config: [PAYROLL_CONFIG_2026],
      company_settings: [{ company_id: C, salary_net_rounding: false, salary_calculation_policy: opts.policy ?? {} }],
      salary_runs: runs,
      employees: [emp],
      salary_run_employees: [sre],
      salary_line_items: opts.lines ?? [
        line(C, sre.id as string, 'li-base', {
          item_type: emp.salary_type === 'hourly' ? 'hourly_salary' : 'monthly_salary',
          description: emp.salary_type === 'hourly' ? 'Timlön' : 'Grundlön',
          amount: emp.salary_type === 'hourly' ? 0 : emp.monthly_salary,
        }),
      ],
      employee_opening_balances: [],
      salary_absence_days: opts.absences ?? [],
      salary_worked_days: opts.workedDays ?? [],
      shift_premium_rules: [],
      employee_benefits: [],
      employee_recurring_lines: [],
    },
  }
}

async function calculate(s: ReturnType<typeof scenario>) {
  const db = createPayrollFakeDb(s.seed)
  const result = await runSalaryCalculation({
    supabase: db.supabase,
    companyId: C,
    salaryRunId: s.runId,
    log: createLogger('test/run-calculation-late-days'),
    requestId: 'req_late_days',
  })
  const sre = db.rows('salary_run_employees').find((row) => row.id === s.sreId)!
  const lines = db
    .rows('salary_line_items')
    .filter((li) => li.salary_run_employee_id === s.sreId && li.item_type !== 'monthly_salary')
    .map(({ item_type, description, quantity, amount }) => ({ item_type, description, quantity, amount }))
  return { db, result, sre, lines }
}

describe('runSalaryCalculation: late days carried to the run', () => {
  beforeEach(() => {
    clearTaxTableCache()
    vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("deducts October's late parental leave in November like November's own days, and names the dates", async () => {
    const { result, sre, lines } = await calculate(
      scenario({ absences: carried(absence(C, 'emp-anna', LATE_PARENTAL), NOVEMBER) }),
    )

    expect(result.ok).toBe(true)
    // 15 days x 42 000 / 21 (2 000 kr a day) = 30 000 kr.
    expect(lines).toEqual([
      {
        item_type: 'parental_leave',
        description: 'Föräldraledighet (15 dagar), från tidigare period: 2026-10-05 till 2026-10-23',
        quantity: 15,
        amount: -30000,
      },
    ])
    expect(sre.gross_salary).toBe(12000)
    expect(sre.parental_days).toBe(15)
  })

  it("deducts the same amount as the run's own days would: a late day costs what a timely one does", async () => {
    // The same 15 days, had they been in the run's own window.
    const timely = scenario({
      absences: absence(C, 'emp-anna', LATE_PARENTAL),
      runs: [
        draftRun(C, NOVEMBER, {
          period_year: 2026,
          period_month: 11,
          payment_date: '2026-11-25',
          deviation_period_start: '2026-10-01',
          deviation_period_end: '2026-10-31',
        }),
      ],
    })
    const late = scenario({ absences: carried(absence(C, 'emp-anna', LATE_PARENTAL), NOVEMBER) })
    const a = await calculate(timely)
    const b = await calculate(late)
    expect(b.sre.gross_salary).toBe(a.sre.gross_salary)
    expect(b.sre.tax_withheld).toBe(a.sre.tax_withheld)
    expect(b.sre.net_salary).toBe(a.sre.net_salary)
    expect(b.lines.map((li) => li.amount)).toEqual(a.lines.map((li) => li.amount))
  })

  it('adds late days to the window\'s own days, saying which came from the earlier period', async () => {
    const { lines } = await calculate(
      scenario({
        absences: [
          ...carried(absence(C, 'emp-anna', [['2026-10-29', 'parental'], ['2026-10-30', 'parental']]), NOVEMBER),
          ...absence(C, 'emp-anna', [['2026-11-02', 'parental']]),
        ],
      }),
    )
    expect(lines).toEqual([
      {
        item_type: 'parental_leave',
        description: 'Föräldraledighet (3 dagar), varav från tidigare period: 2026-10-29 till 2026-10-30',
        quantity: 3,
        amount: -6000,
      },
    ])
  })

  it('never deducts a late day in a run whose window holds its date: the correction of October leaves it to November', async () => {
    // October corrected: its correction draft re-reads October's window.
    const s = scenario({
      calculate: 'run-2026-10-correction',
      absences: carried(absence(C, 'emp-anna', LATE_PARENTAL), NOVEMBER),
      runs: [
        draftRun(C, OCTOBER, {
          status: 'corrected',
          period_year: 2026,
          period_month: 10,
          payment_date: '2026-10-23',
          deviation_period_start: '2026-10-01',
          deviation_period_end: '2026-10-31',
        }),
        draftRun(C, 'run-2026-10-correction', {
          period_year: 2026,
          period_month: 10,
          payment_date: '2026-10-23',
          deviation_period_start: '2026-10-01',
          deviation_period_end: '2026-10-31',
          is_correction: true,
          corrects_run_id: OCTOBER,
        }),
        draftRun(C, NOVEMBER, {
          period_year: 2026,
          period_month: 11,
          payment_date: '2026-11-25',
          deviation_period_start: '2026-11-01',
          deviation_period_end: '2026-11-30',
        }),
      ],
    })
    const { result, lines, sre } = await calculate(s)
    expect(result.ok).toBe(true)
    expect(lines).toEqual([])
    expect(sre.gross_salary).toBe(42000)
  })

  it('warns that late days in a correction must replace a deduction typed by hand into the paid run', async () => {
    const s = scenario({
      calculate: 'run-2026-11-correction',
      absences: carried(absence(C, 'emp-anna', LATE_PARENTAL), 'run-2026-11-correction'),
      runs: [
        draftRun(C, NOVEMBER, {
          status: 'corrected',
          period_year: 2026,
          period_month: 11,
          payment_date: '2026-11-25',
          deviation_period_start: '2026-11-01',
          deviation_period_end: '2026-11-30',
        }),
        draftRun(C, 'run-2026-11-correction', {
          period_year: 2026,
          period_month: 11,
          payment_date: '2026-11-25',
          deviation_period_start: '2026-11-01',
          deviation_period_end: '2026-11-30',
          is_correction: true,
          corrects_run_id: NOVEMBER,
        }),
      ],
    })
    const { result } = await calculate(s)
    expect(result.ok).toBe(true)
    expect((result as { warnings: string[] }).warnings).toContainEqual(
      expect.stringContaining('dras här i en rättelse av en utbetald körning'),
    )

    const ordinary = await calculate(scenario({ absences: carried(absence(C, 'emp-anna', LATE_PARENTAL), NOVEMBER) }))
    expect((ordinary.result as { warnings: string[] }).warnings.join(' ')).not.toContain('rättelse')
  })

  it('names the hand-typed deduction a correction copied from the paid run while late days sit beside it', async () => {
    const correctionRuns = [
      draftRun(C, NOVEMBER, {
        status: 'corrected',
        period_year: 2026,
        period_month: 11,
        payment_date: '2026-11-25',
        deviation_period_start: '2026-11-01',
        deviation_period_end: '2026-11-30',
      }),
      draftRun(C, 'run-2026-11-correction', {
        period_year: 2026,
        period_month: 11,
        payment_date: '2026-11-25',
        deviation_period_start: '2026-11-01',
        deviation_period_end: '2026-11-30',
        is_correction: true,
        corrects_run_id: NOVEMBER,
      }),
    ]
    const s = scenario({
      calculate: 'run-2026-11-correction',
      absences: carried(absence(C, 'emp-anna', LATE_PARENTAL), 'run-2026-11-correction'),
      runs: correctionRuns,
    })
    const sreId = s.sreId
    s.seed.salary_line_items.push(
      line(C, sreId, 'li-hand', { item_type: 'gross_deduction_other', description: 'Löneavdrag föräldraledighet oktober', amount: -30000 }),
    )
    const { result, lines } = await calculate(s)
    expect(result.ok).toBe(true)
    expect((result as { warnings: string[] }).warnings).toContainEqual(
      expect.stringContaining('Anna Testsson ("Löneavdrag föräldraledighet oktober")'),
    )
    // Both still deduct: the warning is what stops the double deduction.
    expect(lines.filter((li) => li.amount === -30000).map((li) => li.item_type).sort()).toEqual(['gross_deduction_other', 'parental_leave'])

    // Removed, the warning goes.
    const without = scenario({
      calculate: 'run-2026-11-correction',
      absences: carried(absence(C, 'emp-anna', LATE_PARENTAL), 'run-2026-11-correction'),
      runs: correctionRuns,
    })
    const clean = await calculate(without)
    expect((clean.result as { warnings: string[] }).warnings.join(' ')).not.toContain('handskrivna avdragsraden')
  })

  it('a correction of November still deducts the days carried to the run it corrects', async () => {
    const s = scenario({
      calculate: 'run-2026-11-correction',
      absences: carried(absence(C, 'emp-anna', LATE_PARENTAL), NOVEMBER),
      runs: [
        draftRun(C, NOVEMBER, {
          status: 'corrected',
          period_year: 2026,
          period_month: 11,
          payment_date: '2026-11-25',
          deviation_period_start: '2026-11-01',
          deviation_period_end: '2026-11-30',
        }),
        draftRun(C, 'run-2026-11-correction', {
          period_year: 2026,
          period_month: 11,
          payment_date: '2026-11-25',
          deviation_period_start: '2026-11-01',
          deviation_period_end: '2026-11-30',
          is_correction: true,
          corrects_run_id: NOVEMBER,
        }),
      ],
    })
    const { result, lines } = await calculate(s)
    expect(result.ok).toBe(true)
    expect(lines).toEqual([expect.objectContaining({ item_type: 'parental_leave', amount: -30000 })])
  })

  it('continues a sjuklöneperiod an earlier run priced: a late sick day after it is a day 2-14 day, no second karens', async () => {
    const { result, lines } = await calculate(
      scenario({
        absences: [
          // Tuesday and Wednesday, paid in October with the karensavdrag.
          ...absence(C, 'emp-anna', [['2026-10-13', 'sick'], ['2026-10-14', 'sick']]),
          // Thursday, known late.
          ...carried(absence(C, 'emp-anna', [['2026-10-15', 'sick']]), NOVEMBER),
        ],
      }),
    )
    expect(result.ok).toBe(true)
    expect(lines.map((li) => li.item_type)).toEqual(['sick_day2_14'])
    expect(lines[0]).toMatchObject({
      description: 'Sjuklön dag 1-14 (1 dagar), från tidigare period: 2026-10-15',
      quantity: 1,
      // 20 % of a day's pay: the employer pays 80 % of it as sjuklön.
      amount: -400,
    })
  })

  it('refuses a late sick day placed before sick days an earlier run already priced in the same period', async () => {
    const { result, db } = await calculate(
      scenario({
        absences: [
          ...absence(C, 'emp-anna', [['2026-10-14', 'sick'], ['2026-10-15', 'sick']]),
          ...carried(absence(C, 'emp-anna', [['2026-10-13', 'sick']]), NOVEMBER),
        ],
      }),
    )
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { reason: 'absence_input_incomplete' } })
    const issue = (result as { details: { issues: string[] } }).details.issues[0]
    expect(issue).toContain('Sjukdagen 2026-10-13')
    expect(issue).toContain('2026-10-14')
    // Nothing was written.
    expect(db.rows('salary_line_items').filter((li) => li.item_type !== 'monthly_salary')).toEqual([])
  })

  it('refuses late long leave under the calendar-day convention, naming the days', async () => {
    const { result } = await calculate(
      scenario({
        policy: { long_leave: 'calendar_after_five_workdays' },
        absences: carried(absence(C, 'emp-anna', LATE_PARENTAL), NOVEMBER),
      }),
    )
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect((result as { details: { issues: string[] } }).details.issues[0]).toContain('2026-10-05 till 2026-10-23')
  })

  it('pays late hours on top of the period\'s own and keeps them out of its hours_worked', async () => {
    const tim = employee(C, 'emp-tim', {
      first_name: 'Tim',
      salary_type: 'hourly',
      monthly_salary: null,
      hourly_rate: 200,
    })
    const { result, sre, lines } = await calculate(
      scenario({
        emp: tim,
        workedDays: [
          ...carried(
            worked(C, 'emp-tim', [
              ['2026-10-28', 8, null, null],
              ['2026-10-29', 8, null, null],
              ['2026-10-30', 8, null, null],
            ]),
            NOVEMBER,
          ),
          ...worked(C, 'emp-tim', [
            ['2026-11-02', 8, null, null],
            ['2026-11-03', 8, null, null],
          ]),
        ],
      }),
    )
    expect(result.ok).toBe(true)
    expect(lines.filter((li) => li.item_type === 'hourly_salary')).toEqual([
      {
        item_type: 'hourly_salary',
        description: 'Timlön, varav från tidigare period: 2026-10-28 till 2026-10-30',
        quantity: 40,
        amount: 8000,
      },
    ])
    expect(sre.gross_salary).toBe(8000)
    // The period's own hours: the late ones belong to October.
    expect(sre.hours_worked).toBe(16)
  })

  it('adds late hours to a period kept as one total on the run row', async () => {
    const tim = employee(C, 'emp-tim', { salary_type: 'hourly', monthly_salary: null, hourly_rate: 200 })
    const s = scenario({
      emp: tim,
      workedDays: carried(worked(C, 'emp-tim', [['2026-10-30', 8, null, null]]), NOVEMBER),
    })
    s.seed.salary_run_employees[0]!.hours_worked = 10
    const { result, sre } = await calculate(s)
    expect(result.ok).toBe(true)
    expect(sre.gross_salary).toBe(3600)
    expect(sre.hours_worked).toBe(10)
  })

  it('says the late days are priced with this run\'s pay, and names the employee', async () => {
    const { result } = await calculate(
      scenario({ absences: carried(absence(C, 'emp-anna', LATE_PARENTAL), NOVEMBER) }),
    )
    expect(result.ok).toBe(true)
    expect((result as { warnings: string[] }).warnings).toContainEqual(
      expect.stringContaining('Dagar från en tidigare period räknas med den här körningens lön, lönetyp, sysselsättningsgrad och schema: Anna'),
    )

    const timely = await calculate(scenario({ absences: absence(C, 'emp-anna', [['2026-11-02', 'parental']]) }))
    expect((timely.result as { warnings: string[] }).warnings.join(' ')).not.toContain('tidigare period')
  })

  it("a karensavdrag line names its own period's first day and never the late dates of another", async () => {
    const { result, lines } = await calculate(
      scenario({
        absences: [
          // An isolated late sick day, Tuesday 20 October.
          ...carried(absence(C, 'emp-anna', [['2026-10-20', 'sick']]), NOVEMBER),
          // November's own sick days, Tuesday and Wednesday.
          ...absence(C, 'emp-anna', [['2026-11-03', 'sick'], ['2026-11-04', 'sick']]),
        ],
      }),
    )
    expect(result.ok).toBe(true)
    const karens = lines.filter((li) => li.item_type === 'sick_karens').map((li) => li.description)
    expect(karens).toEqual(['Karensavdrag (2026-10-20)', 'Karensavdrag (2026-11-03)'])
    expect(lines.find((li) => li.item_type === 'sick_day2_14')?.description).toBe(
      'Sjuklön dag 1-14 (3 dagar), varav från tidigare period: 2026-10-20',
    )
  })

  it('refuses a late VAB day of an hourly employee: no pay of this run is reduced by it', async () => {
    const tim = employee(C, 'emp-tim', { first_name: 'Tim', salary_type: 'hourly', monthly_salary: null, hourly_rate: 200 })
    const { result } = await calculate(
      scenario({
        emp: tim,
        absences: carried(absence(C, 'emp-tim', [['2026-10-20', 'vab']]), NOVEMBER),
      }),
    )
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { reason: 'absence_input_incomplete' } })
    const issue = (result as { details: { issues: string[] } }).details.issues[0]
    expect(issue).toContain('2026-10-20')
    expect(issue).toContain('timlön')
  })

  it('refuses late parental leave when this run pays no monthly salary', async () => {
    const s = scenario({ absences: carried(absence(C, 'emp-anna', LATE_PARENTAL), NOVEMBER) })
    s.seed.salary_run_employees[0]!.monthly_salary = 0
    const { result } = await calculate(s)
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect((result as { details: { issues: string[] } }).details.issues[0]).toContain('månadslönen är 0 kr')
  })

  it('refuses a run whose late days belong to an employee no longer on it, naming them and the days', async () => {
    const bo = employee(C, 'emp-bo', { first_name: 'Bo', last_name: 'Berg', monthly_salary: 30000 })
    const s = scenario({
      absences: carried(absence(C, 'emp-bo', [['2026-10-20', 'vab']]), NOVEMBER),
      workedDays: carried(worked(C, 'emp-bo', [['2026-10-21', 8, null, null]]), NOVEMBER),
    })
    s.seed.employees.push(bo)
    const { result, db } = await calculate(s)
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { reason: 'late_days_without_payslip' } })
    const issue = (result as { details: { issues: string[] } }).details.issues[0]
    expect(issue).toContain('Bo Berg')
    expect(issue).toContain('2026-10-20 till 2026-10-21')
    // Nothing was written.
    expect(db.rows('salary_line_items').filter((li) => li.item_type !== 'monthly_salary')).toEqual([])
  })

  it('a day carried to another run is not one of this window\'s days', async () => {
    // October's correction draft again, now with an hourly employee whose
    // late October hours went to November.
    const tim = employee(C, 'emp-tim', { salary_type: 'hourly', monthly_salary: null, hourly_rate: 200 })
    const s = scenario({
      emp: tim,
      calculate: 'run-2026-10-correction',
      workedDays: [
        ...worked(C, 'emp-tim', [['2026-10-05', 8, null, null]]),
        ...carried(worked(C, 'emp-tim', [['2026-10-30', 8, null, null]]), NOVEMBER),
      ],
      runs: [
        draftRun(C, OCTOBER, {
          status: 'corrected',
          period_year: 2026,
          period_month: 10,
          payment_date: '2026-10-23',
          deviation_period_start: '2026-10-01',
          deviation_period_end: '2026-10-31',
        }),
        draftRun(C, 'run-2026-10-correction', {
          period_year: 2026,
          period_month: 10,
          payment_date: '2026-10-23',
          deviation_period_start: '2026-10-01',
          deviation_period_end: '2026-10-31',
          is_correction: true,
          corrects_run_id: OCTOBER,
        }),
      ],
    })
    const { result, sre } = await calculate(s)
    expect(result.ok).toBe(true)
    expect(sre.gross_salary).toBe(1600)
    expect(sre.hours_worked).toBe(8)
  })
})
