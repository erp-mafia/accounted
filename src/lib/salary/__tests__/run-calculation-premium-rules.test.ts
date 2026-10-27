/**
 * The premium rules through the real calculation: the amount forms, a rate
 * step inside the pay period, and the provenance every derived OB line
 * carries (salary_line_items.source_premium_rule_id and premium_basis).
 * The engine's arithmetic itself is pinned by shift-premium-engine-forms.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import { clearTaxTableCache } from '../tax-tables'
import { runSalaryCalculation } from '../run-calculation'
import { createPayrollFakeDb, type Row } from './payroll-fake-db'
import { draftRun, employee, line, PAYROLL_CONFIG_2026, rosterRow, skatteverketFetch, worked } from './payroll-fixtures'

const COMPANY = 'company-premium'
const RUN = 'run-premium-2026-04'

function premiumRule(id: string, fields: Row): Row {
  return {
    id,
    company_id: COMPANY,
    name: id,
    applies_to_all_employees: true,
    applies_to_employee_ids: [],
    day_of_week: [1, 2, 3, 4, 5, 6, 7],
    start_time: '00:00:00',
    end_time: '00:00:00',
    amount_form: 'percent_of_hourly',
    premium_percent: null,
    monthly_divisor: null,
    sek_per_hour: null,
    hourly_divisor: null,
    valid_from: '2025-04-01',
    valid_to: null,
    item_type: 'ob_weekday_evening',
    priority: 0,
    is_active: true,
    ...fields,
  }
}

function seed(): Record<string, Row[]> {
  const anna = employee(COMPANY, 'emp-anna', { monthly_salary: 40000 })
  const timo = employee(COMPANY, 'emp-timo', { salary_type: 'hourly', monthly_salary: null, hourly_rate: 200 })
  const annaRow = rosterRow(COMPANY, RUN, anna)
  const timoRow = rosterRow(COMPANY, RUN, timo)
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [{ company_id: COMPANY, salary_net_rounding: false, salary_calculation_policy: {} }],
    salary_runs: [draftRun(COMPANY, RUN, { period_year: 2026, period_month: 4, payment_date: '2026-04-25' })],
    employees: [anna, timo],
    salary_run_employees: [annaRow, timoRow],
    salary_line_items: [
      line(COMPANY, annaRow.id as string, 'li-anna-base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 40000 }),
      line(COMPANY, timoRow.id as string, 'li-timo-base', { item_type: 'hourly_salary', description: 'Timlön', amount: 0 }),
    ],
    employee_opening_balances: [],
    salary_absence_days: [],
    salary_worked_days: [
      ...worked(COMPANY, 'emp-anna', [
        // Tuesday: 3 h in the Almega evening window.
        ['2026-04-07', 8, '13:00:00', '21:00:00'],
        // Two Saturdays either side of the rate step on 2026-04-15.
        ['2026-04-11', 4, '10:00:00', '14:00:00'],
        ['2026-04-18', 4, '10:00:00', '14:00:00'],
      ]),
      ...worked(COMPANY, 'emp-timo', [['2026-04-07', 8, '13:00:00', '21:00:00']]),
    ],
    shift_premium_rules: [
      // Almega Tjänsteföretag kvälls- och nattetid: månadslönen / 480.
      premiumRule('rule-almega-kvall', {
        name: 'OB kväll',
        day_of_week: [1, 2, 3, 4, 5],
        start_time: '18:00:00',
        end_time: '06:00:00',
        amount_form: 'monthly_divisor',
        monthly_divisor: '480.00',
      }),
      // A fixed weekend amount that steps up inside the pay period.
      premiumRule('rule-helg-old', {
        name: 'OB helg',
        day_of_week: [6, 7],
        amount_form: 'sek_per_hour',
        sek_per_hour: '26.79',
        item_type: 'ob_weekend',
        valid_to: '2026-04-14',
      }),
      premiumRule('rule-helg-new', {
        name: 'OB helg',
        day_of_week: [6, 7],
        amount_form: 'sek_per_hour',
        sek_per_hour: '27.59',
        item_type: 'ob_weekend',
        valid_from: '2026-04-15',
      }),
    ],
    employee_benefits: [],
    employee_recurring_lines: [],
  }
}

describe('runSalaryCalculation with premium rules', () => {
  beforeEach(() => {
    clearTaxTableCache()
    vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prices each form, follows the rate step per day and stamps every line with its rule', async () => {
    const db = createPayrollFakeDb(seed())
    const result = await runSalaryCalculation({
      supabase: db.supabase,
      companyId: COMPANY,
      salaryRunId: RUN,
      log: createLogger('test/run-calculation-premium-rules'),
      requestId: 'req_premium',
    })
    expect(result.ok).toBe(true)

    // In payslip order: by worked date (sort_order 300 + n).
    const premiumLines = db
      .rows('salary_line_items')
      .filter((row) => row.source_premium_rule_id)
      .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))

    expect(
      premiumLines.map((row) => [row.source_premium_rule_id, row.description, row.quantity, row.amount]),
    ).toEqual([
      // 40 000 x 3 / 480 = 250
      ['rule-almega-kvall', 'OB kväll (2026-04-07, 3 h)', 3, 250],
      // 4 h x 26.79 = 107.16 on the Saturday before the step
      ['rule-helg-old', 'OB helg (2026-04-11, 4 h)', 4, 107.16],
      // 4 h x 27.59 = 110.36 on the Saturday after it
      ['rule-helg-new', 'OB helg (2026-04-18, 4 h)', 4, 110.36],
    ])
    expect(premiumLines.every((row) => row.salary_run_employee_id === `sre-${RUN}-emp-anna`)).toBe(true)

    const kvall = premiumLines.find((row) => row.source_premium_rule_id === 'rule-almega-kvall')!
    expect(kvall.premium_basis).toMatchObject({
      v: 1,
      rule_id: 'rule-almega-kvall',
      amount_form: 'monthly_divisor',
      monthly_divisor: 480,
      base: { kind: 'monthly_salary', amount: 40000 },
      rate_per_hour: 83.33,
      work_date: '2026-04-07',
      hours: 3,
    })

    // The hourly-paid employee is outside the monthly_divisor rule: no OB
    // line, and the calculation still succeeds.
    expect(
      db.rows('salary_line_items').filter((row) => row.salary_run_employee_id === `sre-${RUN}-emp-timo` && row.source_premium_rule_id),
    ).toEqual([])

    const anna = db.rows('salary_run_employees').find((row) => row.employee_id === 'emp-anna')!
    // 40 000 + 250 + 107.16 + 110.36
    expect(anna.gross_salary).toBe(40467.52)
  })

  it('replaces the derived premium lines on a recalculation instead of adding to them', async () => {
    const db = createPayrollFakeDb(seed())
    const args = {
      supabase: db.supabase,
      companyId: COMPANY,
      salaryRunId: RUN,
      log: createLogger('test/run-calculation-premium-rules'),
      requestId: 'req_premium',
    }
    expect((await runSalaryCalculation(args)).ok).toBe(true)
    expect((await runSalaryCalculation(args)).ok).toBe(true)
    expect(db.rows('salary_line_items').filter((row) => row.source_premium_rule_id)).toHaveLength(3)
  })
})
