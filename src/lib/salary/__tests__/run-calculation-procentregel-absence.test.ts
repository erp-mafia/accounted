/**
 * Semesterlönegrundande frånvaro through the real orchestration (#60 part C,
 * Semesterlagen 16 b § andra och tredje stycket, 17-17 a §§).
 *
 *   - An hourly employee's sick days add the hours they would have worked at
 *     full timlön to the procentregeln base; the 80 % sjuklön stays out.
 *   - The VAB and parental 120-date cap counts within the intjänandeår, which
 *     follows the company's semesterår basis: 1 April under the statutory
 *     basis, 1 January under the calendar one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
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

const C = 'company-p'

async function calculate(seed: Record<string, Row[]>, runId: string) {
  const db = createPayrollFakeDb(seed)
  const result = await runSalaryCalculation({
    supabase: db.supabase,
    companyId: C,
    salaryRunId: runId,
    log: createLogger('test/run-calculation-procentregel-absence'),
    requestId: 'req_procentregel_absence',
  })
  return { db, result }
}

/** Every calendar date from `start`, `count` of them (YYYY-MM-DD). */
function dates(start: string, count: number): string[] {
  const first = Date.parse(`${start}T00:00:00Z`)
  return Array.from({ length: count }, (_, i) => new Date(first + i * 86_400_000).toISOString().slice(0, 10))
}

describe('runSalaryCalculation: procentregeln base with absence (#60 C)', () => {
  beforeEach(() => {
    clearTaxTableCache()
    vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('puts an hourly employee\'s sick hours at full timlön in the base, not the sjuklön', async () => {
    const RUN = 'run-p-2026-09'
    const SRE = `sre-${RUN}-emp-olle`
    const olle = employee(C, 'emp-olle', {
      first_name: 'Olle',
      salary_type: 'hourly',
      monthly_salary: null,
      hourly_rate: 200,
      vacation_rule: 'procentregeln',
    })
    const { db, result } = await calculate(
      {
        salary_payroll_config: [PAYROLL_CONFIG_2026],
        company_settings: [{ company_id: C, salary_net_rounding: false, salary_calculation_policy: {} }],
        salary_runs: [draftRun(C, RUN, { period_year: 2026, period_month: 9, payment_date: '2026-09-25' })],
        employees: [olle],
        salary_run_employees: [rosterRow(C, RUN, olle)],
        salary_line_items: [line(C, SRE, 'li-olle-base', { item_type: 'hourly_salary', description: 'Timlön', amount: 0 })],
        employee_opening_balances: [],
        salary_absence_days: absence(C, 'emp-olle', [
          ['2026-09-14', 'sick', 8],
          ['2026-09-15', 'sick', 8],
          ['2026-09-16', 'sick', 8],
        ]),
        salary_worked_days: worked(
          C,
          'emp-olle',
          ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'].map(
            (date): [string, number, null, null] => [date, 8, null, null],
          ),
        ),
        shift_premium_rules: [],
        employee_benefits: [],
        employee_recurring_lines: [],
      },
      RUN,
    )
    expect(result.ok).toBe(true)

    const sre = db.rows('salary_run_employees').find((row) => row.id === SRE)!
    // Paid: 8 000 worked + 3 840 sjuklön - 1 280 karens. Base: 8 000 + 24 h x
    // 200 = 12 800, where it used to be 8 000 + 3 840 = 11 840.
    expect(sre.gross_salary).toBe(10560)
    expect(sre.vacation_accrual).toBe(roundOre(12800 * 0.12))
    const steps = (sre.calculation_breakdown as { steps: Array<{ label: string; input: unknown; output: number }> }).steps
    expect(steps.find((s) => s.label === 'Semesterlönegrundande frånvaro (Semesterlagen 16 b §)')).toMatchObject({
      input: { hourly_rate: 200, hours: 24 },
      output: 4800,
    })
    const sjuklon = db.rows('salary_line_items').find((li) => li.salary_run_employee_id === SRE && li.item_type === 'sick_day2_14')!
    expect(sjuklon).toMatchObject({ amount: 3840, is_vacation_basis: false })
  })

  describe('the VAB cap counts within the intjänandeår of the company\'s basis', () => {
    const RUN = 'run-p-2026-03'
    const SRE = `sre-${RUN}-emp-vera`
    /** 120 VAB dates from 1 September to 29 December 2025, one more in March 2026. */
    const seed = (basis: 'calendar' | 'statutory_apr_mar'): Record<string, Row[]> => {
      const vera = employee(C, 'emp-vera', { first_name: 'Vera', monthly_salary: 30000, vacation_rule: 'procentregeln' })
      return {
        salary_payroll_config: [PAYROLL_CONFIG_2026],
        company_settings: [
          { company_id: C, salary_net_rounding: false, salary_calculation_policy: {}, salary_vacation_year_basis: basis },
        ],
        salary_runs: [draftRun(C, RUN, { period_year: 2026, period_month: 3, payment_date: '2026-03-25' })],
        employees: [vera],
        salary_run_employees: [rosterRow(C, RUN, vera)],
        salary_line_items: [line(C, SRE, 'li-vera-base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 30000 })],
        employee_opening_balances: [],
        salary_absence_days: absence(C, 'emp-vera', [
          ...dates('2025-09-01', 120).map((date): [string, string] => [date, 'vab']),
          ['2026-03-10', 'vab'],
        ]),
        salary_worked_days: [],
        shift_premium_rules: [],
        employee_benefits: [],
        employee_recurring_lines: [],
      }
    }
    const vabLine = (db: Awaited<ReturnType<typeof calculate>>['db']) =>
      db.rows('salary_line_items').find((li) => li.salary_run_employee_id === SRE && li.item_type === 'vab')!

    it('calendar basis: the year began 1 January, so the March date qualifies and the base stays whole', async () => {
      const { db, result } = await calculate(seed('calendar'), RUN)
      expect(result.ok).toBe(true)
      expect(vabLine(db)).toMatchObject({ description: 'VAB (1 dagar)', is_vacation_basis: false })
      expect(db.rows('salary_run_employees').find((row) => row.id === SRE)!.vacation_accrual).toBe(3600)
    })

    it('statutory basis: the year began 1 April 2025, so the March date is date 121 and lowers the base', async () => {
      const { db, result } = await calculate(seed('statutory_apr_mar'), RUN)
      expect(result.ok).toBe(true)
      expect(vabLine(db)).toMatchObject({ description: 'VAB (1 dagar, ej semestergrundande)', is_vacation_basis: true })
      expect(db.rows('salary_run_employees').find((row) => row.id === SRE)!.vacation_accrual).toBe(
        roundOre((30000 - 1428.57) * 0.12),
      )
    })
  })
})
