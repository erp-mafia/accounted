/**
 * Vacation days taken (a manual item_type 'vacation' line, quantity = days)
 * through the real runSalaryCalculation, under both semesterlön rules
 * (crm#1331). Same harness as run-calculation-text-rows.test.ts: the real
 * orchestration, engine and tax-table parsing over payroll-fake-db.ts.
 *
 * swedish-payroll vacation-pay.md:
 *   - Sammalöneregeln (16 a §): the regular salary continues during the
 *     vacation, plus a semestertillägg of at least 0.43 % of the monthly
 *     salary per paid vacation day (many kollektivavtal 0.8 %).
 *   - Procentregeln (16 b §): semesterlön is 12 % of the semesterlönegrundande
 *     income of the intjänandeår.
 *
 * What the calculation does with the days today, pinned here:
 *   - the monthly salary runs on under both rules (right for sammalöneregeln);
 *   - the days reach the payslip (vacation_days_taken) and from there the
 *     vacation ledger, converted to paid days by the stored factor;
 *   - the semesteravsättning (2920) is the month's earned share, whatever is
 *     taken;
 *   - the days alone value nothing: no semestertillägg under
 *     sammalöneregeln, no semesterlöneavdrag + semesterlön under
 *     procentregeln. Whatever the payslip pays for the days is the line's
 *     amount (quantity x à-pris), and that amount reaches gross pay.
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

function seed(rule: Rule, vacationLines: Row[]): Record<string, Row[]> {
  const vera = employee(CO, EMP, {
    first_name: 'Vera',
    monthly_salary: MONTHLY,
    vacation_rule: rule,
    vacation_days_per_year: 25,
    semestertillagg_rate: 0.0043,
  })
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [{ company_id: CO, salary_net_rounding: false, salary_calculation_policy: {} }],
    salary_runs: [draftRun(CO, RUN, { period_year: 2026, period_month: 7, payment_date: '2026-07-25' })],
    employees: [vera],
    salary_run_employees: [rosterRow(CO, RUN, vera)],
    salary_line_items: [
      line(CO, SRE, 'li-base', { item_type: 'monthly_salary', description: 'Grundlön', amount: MONTHLY }),
      ...vacationLines,
    ],
    employee_opening_balances: [],
    salary_absence_days: [],
    salary_worked_days: [],
    shift_premium_rules: [],
    employee_benefits: [],
    employee_recurring_lines: [],
  }
}

/** Five days off in July, the days alone: what the docs and the dialog now allow. */
const DAYS_ONLY = line(CO, SRE, 'li-vacation', {
  item_type: 'vacation',
  description: 'Semester',
  quantity: 5,
  amount: 0,
  ...VACATION_FLAGS,
  vacation_category: 'paid',
  sort_order: 30,
})

/** The same days with the semestertillägg on the line: 5 x 0,43 % x 40 000 kr. */
const WITH_TILLAGG = {
  ...DAYS_ONLY,
  description: 'Semestertillägg 5 dagar',
  unit_price: 172,
  amount: 860,
}

async function calculate(rule: Rule, vacationLines: Row[]) {
  vi.mocked(calculateSalary).mockClear()
  const db = createPayrollFakeDb(seed(rule, vacationLines))
  const result = await runSalaryCalculation({
    supabase: db.supabase,
    companyId: CO,
    salaryRunId: RUN,
    log: createLogger('test/run-calculation-vacation-days'),
    requestId: 'req_vacation_days',
  })
  expect(result.ok).toBe(true)
  const [input] = vi.mocked(calculateSalary).mock.calls[0]
  const roster = db.rows('salary_run_employees').find((row) => row.id === SRE) as Row
  return { db, input, roster }
}

describe('runSalaryCalculation: vacation days taken (crm#1331)', () => {
  beforeEach(() => {
    vi.mocked(calculateSalary).mockClear()
    clearTaxTableCache()
    vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('sammalöneregeln', () => {
    it('days alone: the monthly salary runs on, the days reach the payslip, the accrual is the month\'s share', async () => {
      const plain = await calculate('sammaloneregeln', [])
      const { input, roster, db } = await calculate('sammaloneregeln', [DAYS_ONLY])

      // The engine sees the line with its stored 0 kr.
      expect(input.lineItems.filter((li) => li.itemType === 'vacation')).toEqual([
        expect.objectContaining({ itemType: 'vacation', amount: 0 }),
      ])
      // Månadslön unchanged through the vacation (16 a §).
      expect(roster.gross_salary).toBe(MONTHLY)
      expect(roster.gross_salary).toBe(plain.roster.gross_salary)
      expect(roster.tax_withheld).toBe(plain.roster.tax_withheld)
      // The days are on the payslip for the vacation ledger, one paid day per
      // day off at five workdays a week (Semesterlagen 12 a §).
      expect(roster.vacation_days_taken).toBe(5)
      expect(roster.vacation_paid_days_per_day_off).toBe(1)
      expect(plain.roster.vacation_days_taken).toBe(0)
      // Semesteravsättning: 40 000 x 0,43 % x 25 / 12, the same with or
      // without days taken.
      expect(roster.vacation_accrual).toBe(358.33)
      expect(roster.vacation_accrual).toBe(plain.roster.vacation_accrual)
      // The line stays as entered across the calculation.
      expect(db.rows('salary_line_items').find((row) => row.id === 'li-vacation')).toEqual(DAYS_ONLY)
    }, 30_000)

    it('the days alone derive no semestertillägg: it is paid only when the line carries it', async () => {
      const daysOnly = await calculate('sammaloneregeln', [DAYS_ONLY])
      expect(daysOnly.roster.gross_salary).toBe(MONTHLY)
      expect(daysOnly.db.rows('salary_line_items').filter((row) => row.id !== 'li-vacation' && row.item_type !== 'monthly_salary')).toEqual([])

      const withTillagg = await calculate('sammaloneregeln', [WITH_TILLAGG])
      // 0,43 % of the monthly salary per paid day, 5 days, on top of the
      // unchanged monthly salary: taxed and in the avgiftsunderlag.
      expect(withTillagg.roster.gross_salary).toBe(MONTHLY + 860)
      expect(withTillagg.roster.avgifter_basis).toBe(MONTHLY + 860)
      expect(withTillagg.roster.tax_withheld).toBeGreaterThan(daysOnly.roster.tax_withheld as number)
      expect(withTillagg.roster.vacation_days_taken).toBe(5)
      // Paying the tillägg does not change what accrues (not semestergrundande).
      expect(withTillagg.roster.vacation_accrual).toBe(daysOnly.roster.vacation_accrual)
    }, 30_000)

    it.todo('derives the semestertillägg from the days alone (0,43 % or the kollektivavtal rate of the monthly salary per paid day)')
  })

  describe('procentregeln', () => {
    it('days alone: the monthly salary runs on, the days reach the payslip, 12 % accrues on the month', async () => {
      const plain = await calculate('procentregeln', [])
      const { roster } = await calculate('procentregeln', [DAYS_ONLY])

      expect(roster.gross_salary).toBe(MONTHLY)
      expect(roster.gross_salary).toBe(plain.roster.gross_salary)
      expect(roster.vacation_days_taken).toBe(5)
      // 12 % of the month's semesterlönegrundande pay, whatever is taken.
      expect(roster.vacation_accrual).toBe(4800)
      expect(roster.vacation_accrual).toBe(plain.roster.vacation_accrual)
    }, 30_000)

    it('a semesterlöneavdrag and a semesterlön on vacation lines reach gross pay with their signs', async () => {
      // Amounts as an operator enters them today; the calculation takes them
      // as given (11 520 kr is 40 000 x 12 x 12 % / 25 x 5, the day value
      // semesterberedning.ts uses under procentregeln).
      const deduction = line(CO, SRE, 'li-vacation-deduction', {
        item_type: 'vacation',
        description: 'Semesterlöneavdrag 5 dagar',
        quantity: 5,
        amount: -9000,
        ...VACATION_FLAGS,
        sort_order: 30,
      })
      const pay = line(CO, SRE, 'li-vacation-pay', {
        item_type: 'vacation',
        description: 'Semesterlön 5 dagar',
        amount: 11520,
        ...VACATION_FLAGS,
        sort_order: 31,
      })
      const { roster } = await calculate('procentregeln', [deduction, pay])
      expect(roster.gross_salary).toBe(MONTHLY - 9000 + 11520)
      // Only the deduction line carries days.
      expect(roster.vacation_days_taken).toBe(5)
    }, 30_000)

    it.todo('derives the semesterlöneavdrag and the semesterlön (12 % of the intjänandeår basis per paid day) from the days alone')
  })
})
