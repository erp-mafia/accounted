/**
 * Vacation days taken (a manual item_type 'vacation' line, quantity = days)
 * through the real runSalaryCalculation (crm#1331, issue #85). Same harness
 * as run-calculation-text-rows.test.ts: the real orchestration, engine and
 * tax-table parsing over payroll-fake-db.ts.
 *
 * Semesterlagen (1977:480), read on riksdagen.se 2026-10-23
 * (docs/research/payroll-semester-derived-pay.md):
 *   - 16 a §: under sammalöneregeln the monthly salary runs on and every
 *     paid day earns a semestertillägg, 0,43 % of the månadslön by law (a
 *     kollektivavtal may raise it: employees.semestertillagg_rate).
 *   - 16 b §: under procentregeln the semesterlön is 12 % of the pay of the
 *     intjänandeår, per paid day that total over the days earned (7 §); the
 *     salary for the days goes.
 *   - 8 §: obetalda dagar carry no semesterlön: one dagslön off per day.
 *
 * A vacation line without an amount is priced by the calculation; a line
 * with an amount is paid as entered. The derived rows carry
 * calculation_source 'vacation_pay' and are replaced on every calculation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import { clearTaxTableCache } from '../tax-tables'
import { createPayrollFakeDb, type Row } from './payroll-fake-db'
import { draftRun, employee, line, PAYROLL_CONFIG_2026, rosterRow, skatteverketFetch } from './payroll-fixtures'

vi.mock('../calculation-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../calculation-engine')>()
  return { ...actual, calculateSalary: vi.fn(actual.calculateSalary) }
})

import { calculateSalary } from '../calculation-engine'
import { runSalaryCalculation } from '../run-calculation'

const CO = 'company-vacation'
const RUN = 'run-vacation-2026-07'
const EMP = 'emp-vera'
const SRE = `sre-${RUN}-${EMP}`
const MONTHLY = 40000

/** The flags "Lägg till rad" gives a vacation line (manual-payslip-lines.ts). */
const VACATION_FLAGS = {
  is_taxable: true,
  is_avgift_basis: true,
  is_vacation_basis: false,
  is_gross_deduction: false,
  is_net_deduction: false,
}

type Rule = 'sammaloneregeln' | 'procentregeln'

interface Scenario {
  rule: Rule
  vacationLines: Row[]
  employee?: Row
  basis?: 'calendar' | 'statutory_apr_mar'
  /** Earlier payslips of the employee (booked runs with their breakdowns). */
  history?: { runs: Row[]; roster: Row[] }
  runStatus?: string
}

function seed(scenario: Scenario): Record<string, Row[]> {
  const vera = employee(CO, EMP, {
    first_name: 'Vera',
    monthly_salary: MONTHLY,
    vacation_rule: scenario.rule,
    vacation_days_per_year: 25,
    semestertillagg_rate: 0.0043,
    ...scenario.employee,
  })
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [
      {
        company_id: CO,
        salary_net_rounding: false,
        salary_calculation_policy: {},
        salary_vacation_year_basis: scenario.basis ?? 'statutory_apr_mar',
      },
    ],
    salary_runs: [
      draftRun(CO, RUN, { period_year: 2026, period_month: 7, payment_date: '2026-07-25', status: scenario.runStatus ?? 'draft' }),
      ...(scenario.history?.runs ?? []),
    ],
    employees: [vera],
    salary_run_employees: [rosterRow(CO, RUN, vera), ...(scenario.history?.roster ?? [])],
    salary_line_items: [
      line(CO, SRE, 'li-base', { item_type: 'monthly_salary', description: 'Grundlön', amount: vera.monthly_salary }),
      ...scenario.vacationLines,
    ],
    employee_opening_balances: [],
    salary_absence_days: [],
    salary_worked_days: [],
    shift_premium_rules: [],
    employee_benefits: [],
    employee_recurring_lines: [],
  }
}

/**
 * Booked payslips paid on the 25th from `from` (YYYY-MM) for `count` months,
 * each calculated under procentregeln on a semesterunderlag of `basis`: the
 * breakdown step the base is read from (calculation-engine.ts step 9).
 */
function bookedHistory(from: string, count: number, basis = MONTHLY): { runs: Row[]; roster: Row[] } {
  const runs: Row[] = []
  const roster: Row[] = []
  let year = Number(from.slice(0, 4))
  let month = Number(from.slice(5, 7))
  for (let i = 0; i < count; i++) {
    const period = `${year}-${String(month).padStart(2, '0')}`
    const runId = `run-history-${period}`
    runs.push(draftRun(CO, runId, { period_year: year, period_month: month, payment_date: `${period}-25`, status: 'booked' }))
    roster.push({
      ...rosterRow(CO, runId, { id: EMP, employment_degree: 100, salary_type: 'monthly', monthly_salary: MONTHLY }),
      gross_salary: MONTHLY,
      calculation_breakdown: {
        steps: [
          { label: 'Grundlön', formula: '', input: {}, output: MONTHLY },
          {
            label: 'Semesteravsättning (procentregeln 12 %)',
            formula: 'semesterunderlag × 12 %',
            input: { vacation_basis: basis, rate: 0.12 },
            output: basis * 0.12,
          },
        ],
      },
    })
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return { runs, roster }
}

function vacationLine(id: string, quantity: number, fields: Row = {}): Row {
  return line(CO, SRE, id, {
    item_type: 'vacation',
    description: 'Semester',
    quantity,
    amount: 0,
    ...VACATION_FLAGS,
    vacation_category: 'paid',
    sort_order: 30,
    ...fields,
  })
}

/** Five days off in July, the days alone. */
const DAYS_ONLY = vacationLine('li-vacation', 5)

/** The same days with the semestertillägg typed on the line: 5 x 0,43 % x 40 000 kr. */
const WITH_TILLAGG = { ...DAYS_ONLY, description: 'Semestertillägg 5 dagar', unit_price: 172, amount: 860 }

async function run(scenario: Scenario) {
  vi.mocked(calculateSalary).mockClear()
  const db = createPayrollFakeDb(seed(scenario))
  const result = await runSalaryCalculation({
    supabase: db.supabase,
    companyId: CO,
    salaryRunId: RUN,
    log: createLogger('test/run-calculation-vacation-days'),
    requestId: 'req_vacation_days',
  })
  const roster = db.rows('salary_run_employees').find((row) => row.id === SRE) as Row
  const derived = db.rows('salary_line_items').filter((row) => row.calculation_source === 'vacation_pay')
  return { db, result, roster, derived }
}

async function calculate(scenario: Scenario) {
  const out = await run(scenario)
  expect(out.result.ok).toBe(true)
  return out
}

type Step = { label: string; input: Record<string, unknown>; output: number | null }

function steps(roster: Row): Step[] {
  return (roster.calculation_breakdown as { steps: Step[] }).steps
}

describe('runSalaryCalculation: vacation days taken (crm#1331, #85)', () => {
  beforeEach(() => {
    vi.mocked(calculateSalary).mockClear()
    clearTaxTableCache()
    vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('sammalöneregeln', () => {
    it('5 paid days derive a semestertillägg of 5 x 0,43 % x 40 000 = 860 kr on top of the running salary', async () => {
      const plain = await calculate({ rule: 'sammaloneregeln', vacationLines: [] })
      const { roster, derived, db, result } = await calculate({ rule: 'sammaloneregeln', vacationLines: [DAYS_ONLY] })

      expect(derived).toEqual([
        expect.objectContaining({
          salary_run_employee_id: SRE,
          item_type: 'vacation',
          calculation_source: 'vacation_pay',
          description: 'Semestertillägg 5 dagar × 172,00 kr (0,43 % av 40 000,00 kr)',
          quantity: null,
          amount: 860,
          is_taxable: true,
          is_avgift_basis: true,
          is_vacation_basis: false,
          is_gross_deduction: false,
          account_number: null,
        }),
      ])
      // Månadslön unchanged (16 a §), the tillägg on top: taxed and in the avgiftsunderlag.
      expect(roster.gross_salary).toBe(MONTHLY + 860)
      expect(roster.avgifter_basis).toBe(MONTHLY + 860)
      expect(roster.tax_withheld).toBeGreaterThan(plain.roster.tax_withheld as number)
      // The days stay on the operator's line for the ledger; the derived row carries none.
      expect(roster.vacation_days_taken).toBe(5)
      expect(db.rows('salary_line_items').find((row) => row.id === 'li-vacation')).toEqual(DAYS_ONLY)
      // Semesteravsättning 40 000 x 0,43 % x 25 / 12 = 358,33, as without days: the tillägg is no wage addition.
      expect(roster.vacation_accrual).toBe(358.33)
      expect(roster.vacation_accrual).toBe(plain.roster.vacation_accrual)
      // Every input is on the breakdown, before Bruttolön.
      const labels = steps(roster).map((s) => s.label)
      expect(labels.indexOf('Semestertillägg (Semesterlagen 16 a §, 0,43 %)')).toBeGreaterThan(-1)
      expect(labels.indexOf('Semestertillägg (Semesterlagen 16 a §, 0,43 %)')).toBeLessThan(labels.indexOf('Bruttolön'))
      expect(steps(roster).find((s) => s.label.startsWith('Semestertillägg'))?.input).toMatchObject({
        paid_days: 5,
        monthly_salary: 40000,
        semestertillagg_rate: 0.0043,
        per_day: 172,
      })
      if (!result.ok) return
      expect(result.warnings).toContainEqual(expect.stringContaining('Semesterlön för uttagna semesterdagar har räknats fram för Vera Testsson'))
    }, 30_000)

    it('a second calculation replaces the derived row instead of adding one', async () => {
      const first = await calculate({ rule: 'sammaloneregeln', vacationLines: [DAYS_ONLY] })
      const again = await runSalaryCalculation({
        supabase: first.db.supabase,
        companyId: CO,
        salaryRunId: RUN,
        log: createLogger('test/run-calculation-vacation-days'),
        requestId: 'req_vacation_days_again',
      })
      expect(again.ok).toBe(true)
      const derived = first.db.rows('salary_line_items').filter((row) => row.calculation_source === 'vacation_pay')
      expect(derived.map((row) => row.amount)).toEqual([860])
      expect(first.db.rows('salary_run_employees').find((row) => row.id === SRE)?.gross_salary).toBe(MONTHLY + 860)
    }, 30_000)

    it('a line with an amount is paid as entered and derives nothing: the tillägg is never paid twice', async () => {
      const { roster, derived } = await calculate({ rule: 'sammaloneregeln', vacationLines: [WITH_TILLAGG] })
      expect(derived).toEqual([])
      expect(roster.gross_salary).toBe(MONTHLY + 860)
      expect(roster.vacation_days_taken).toBe(5)
    }, 30_000)

    it('sparade dagar at a kollektivavtal 0,8 %: 3 days x 0,8 % x 40 000 = 960 kr (22 §)', async () => {
      const saved = vacationLine('li-saved', 3, { vacation_category: 'saved', vacation_saved_year: '2024' })
      const { roster, derived } = await calculate({
        rule: 'sammaloneregeln',
        vacationLines: [saved],
        employee: { semestertillagg_rate: 0.008 },
      })
      expect(derived.map((row) => row.amount)).toEqual([960])
      expect(roster.gross_salary).toBe(MONTHLY + 960)
    }, 30_000)

    it('part time at four days a week: 60 % of 30 000 = 18 000 kr, 4 days off = 5 paid days x 77,40 = 387 kr (12 a §)', async () => {
      const fourDays = vacationLine('li-vacation', 4)
      const { roster, derived } = await calculate({
        rule: 'sammaloneregeln',
        vacationLines: [fourDays],
        employee: { monthly_salary: 30000, employment_degree: 60, workdays_per_week: 4, hours_per_week: 24 },
      })
      expect(derived).toEqual([
        expect.objectContaining({
          description: 'Semestertillägg 5 betalda dagar (4 lediga) × 77,40 kr (0,43 % av 18 000,00 kr)',
          amount: 387,
        }),
      ])
      expect(roster.gross_salary).toBe(18000 + 387)
      expect(roster.vacation_paid_days_per_day_off).toBe(1.25)
    }, 30_000)

    it('obetalda dagar: 2 x 40 000 / 21 = 2 x 1 904,76 = -3 809,52 kr off the salary', async () => {
      const unpaid = vacationLine('li-unpaid', 2, { vacation_category: 'unpaid' })
      const { roster, derived } = await calculate({ rule: 'sammaloneregeln', vacationLines: [unpaid] })
      expect(derived).toEqual([
        expect.objectContaining({
          description: 'Obetald semester 2 dagar × 1 904,76 kr',
          amount: -3809.52,
          is_vacation_basis: true,
          is_gross_deduction: true,
        }),
      ])
      expect(roster.gross_salary).toBe(36190.48)
    }, 30_000)

    it('förskott derives nothing: the salary runs on and the breakdown says why', async () => {
      const advance = vacationLine('li-advance', 2, { vacation_category: 'advance' })
      const { roster, derived } = await calculate({ rule: 'sammaloneregeln', vacationLines: [advance] })
      expect(derived).toEqual([])
      expect(roster.gross_salary).toBe(MONTHLY)
      expect(steps(roster).find((s) => s.label === 'Förskottssemester')).toMatchObject({ output: null })
    }, 30_000)
  })

  describe('procentregeln', () => {
    it('with the intjänandeår in Accounted: avdrag 5 x 1 904,76, semesterlön 5 x 12 % x 480 000 / 25 = 11 520 kr', async () => {
      const { roster, derived } = await calculate({
        rule: 'procentregeln',
        vacationLines: [DAYS_ONLY],
        history: bookedHistory('2025-04', 12),
      })
      expect(derived.map((row) => [row.description, row.amount, row.is_vacation_basis, row.is_gross_deduction])).toEqual([
        ['Semesterlöneavdrag 5 dagar × 1 904,76 kr', -9523.8, true, true],
        ['Semesterlön 5 dagar × 2 304,00 kr (12 % av 480 000,00 kr / 25 dagar, 2025/2026)', 11520, false, false],
      ])
      // 40 000 - 9 523,80 + 11 520 = 41 996,20 kr.
      expect(roster.gross_salary).toBe(41996.2)
      // The month accrues on worked pay only (16 b § andra stycket 1): 12 % x 30 476,20 = 3 657,14 kr.
      expect(roster.vacation_accrual).toBe(3657.14)
      expect(roster.vacation_days_taken).toBe(5)
      expect(steps(roster).find((s) => s.label.startsWith('Semesterlön ('))?.input).toMatchObject({
        vacation_basis: 480000,
        earned_days: 25,
        payslips: 12,
        earning_year: '2025/2026',
      })
    }, 30_000)

    it('calendar basis reads the previous calendar year: 2025 in full, the same 2 304 kr a day', async () => {
      const { roster } = await calculate({
        rule: 'procentregeln',
        basis: 'calendar',
        vacationLines: [DAYS_ONLY],
        history: bookedHistory('2025-01', 12),
      })
      expect(roster.gross_salary).toBe(41996.2)
    }, 30_000)

    it('without the base year in Accounted the run is refused by name and nothing is written', async () => {
      const { result, roster, derived, db } = await run({
        rule: 'procentregeln',
        vacationLines: [DAYS_ONLY],
        history: bookedHistory('2026-01', 6),
      })
      expect(result).toMatchObject({
        ok: false,
        code: 'SALARY_RUN_VACATION_PAY_UNDETERMINED',
        details: {
          reason: 'vacation_pay_undetermined',
          issues: [
            {
              employee: 'Vera Testsson',
              message: expect.stringContaining('saknar godkända lönebesked för 9 månader mellan 2025-04 och 2025-12'),
              message_en: expect.stringContaining('no approved, paid or booked payslip'),
            },
          ],
        },
        messageSv: expect.stringMatching(/^Vera Testsson: semesterlönen enligt procentregeln är 12 %/),
      })
      expect(derived).toEqual([])
      expect(roster.gross_salary).toBe(0)
      expect(roster.calculation_breakdown).toBeNull()
      expect(db.rows('salary_line_items').map((row) => row.id)).toEqual(['li-base', 'li-vacation'])
    }, 30_000)

    it('a line with an amount needs no base: the operator priced it', async () => {
      const priced = { ...DAYS_ONLY, description: 'Semesterlön 5 dagar', amount: 2000 }
      const { roster, derived } = await calculate({ rule: 'procentregeln', vacationLines: [priced] })
      expect(derived).toEqual([])
      expect(roster.gross_salary).toBe(MONTHLY + 2000)
    }, 30_000)

    it('obetalda dagar deduct without any base, and lower the month\'s base', async () => {
      const unpaid = vacationLine('li-unpaid', 1, { vacation_category: 'unpaid' })
      const { roster } = await calculate({ rule: 'procentregeln', vacationLines: [unpaid] })
      expect(roster.gross_salary).toBe(38095.24)
      // Pay never earned lowers the base: 12 % x 38 095,24 = 4 571,43 kr.
      expect(roster.vacation_accrual).toBe(4571.43)
    }, 30_000)
  })

  it('a booked run is never recalculated: its stored lines and figures stay as booked', async () => {
    const { result, derived, db } = await run({ rule: 'sammaloneregeln', vacationLines: [DAYS_ONLY], runStatus: 'booked' })
    expect(result).toEqual({
      ok: false,
      code: 'SALARY_RUN_CALCULATE_FAILED',
      details: { currentStatus: 'booked', reason: 'not_draft' },
    })
    expect(derived).toEqual([])
    expect(db.rows('salary_line_items').map((row) => row.id)).toEqual(['li-base', 'li-vacation'])
  }, 30_000)
})
