/**
 * Hourly sick pay through the real orchestration (#60 part A, SjLL 6 §).
 *
 * An hourly employee's base pay is timlön × worked hours, so the hours they
 * were sick were never in it: sick days 1-14 must ADD 80 % of timlön × the
 * sick hours, less the karensavdrag. They used to be priced from
 * monthly_salary, which is 0 for timlön (0 kr sjuklön), or a stale monthly
 * salary left from before a switch to hourly pay (a deduction off timlön).
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

const H = 'company-h'
const RUN = 'run-h-2026-09'
const SRE = `sre-${RUN}-emp-olle`

function scenario(sickHours: number[] = [8, 8, 8]): Record<string, Row[]> {
  // A monthly salary left on the employee from before the switch to timlön.
  const olle = employee(H, 'emp-olle', {
    first_name: 'Olle',
    salary_type: 'hourly',
    monthly_salary: 30000,
    hourly_rate: 200,
    hours_per_week: 40,
    workdays_per_week: 5,
  })
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [{ company_id: H, salary_net_rounding: false, salary_calculation_policy: {} }],
    salary_runs: [draftRun(H, RUN, { period_year: 2026, period_month: 9, payment_date: '2026-09-25' })],
    employees: [olle],
    salary_run_employees: [rosterRow(H, RUN, olle, { monthly_salary: 30000 })],
    salary_line_items: [line(H, SRE, 'li-olle-base', { item_type: 'hourly_salary', description: 'Timlön', amount: 0 })],
    employee_opening_balances: [],
    salary_absence_days: absence(
      H,
      'emp-olle',
      ['2026-09-14', '2026-09-15', '2026-09-16'].map((date, i): [string, string, number] => [date, 'sick', sickHours[i]]),
    ),
    salary_worked_days: worked(
      H,
      'emp-olle',
      ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'].map(
        (date): [string, number, null, null] => [date, 8, null, null],
      ),
    ),
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
    log: createLogger('test/run-calculation-hourly-sick'),
    requestId: 'req_hourly_sick',
  })
  return { db, result }
}

describe('runSalaryCalculation: hourly sick pay', () => {
  beforeEach(() => {
    clearTaxTableCache()
    vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds sjuklön for the sick hours on top of the worked hours, less the karensavdrag', async () => {
    const { db, result } = await calculate(scenario())
    expect(result.ok).toBe(true)

    const lines = db.rows('salary_line_items').filter((li) => li.salary_run_employee_id === SRE)
    const byType = (type: string) => lines.filter((li) => li.item_type === type)
    expect(byType('hourly_salary')).toHaveLength(1)
    expect(byType('hourly_salary')[0]).toMatchObject({ quantity: 40, amount: 8000 })
    // 3 x 8 h x 200 x 0,8 = 3 840; karens 0,2 x 0,8 x 200 x 40 = 1 280. The
    // stale 30 000 kr monthly salary deducts nothing.
    expect(byType('sick_day2_14')).toHaveLength(1)
    expect(byType('sick_day2_14')[0]).toMatchObject({ quantity: 24, amount: 3840 })
    expect(byType('sick_karens')).toHaveLength(1)
    expect(byType('sick_karens')[0]).toMatchObject({ amount: -1280 })
    expect(byType('sick_day15_plus')).toHaveLength(0)

    const sre = db.rows('salary_run_employees').find((row) => row.id === SRE)!
    expect(sre.gross_salary).toBe(10560) // 8 000 + 3 840 - 1 280
    expect(sre.sick_days).toBe(3)

    if (!result.ok) return
    expect(result.warnings).toContainEqual(
      expect.stringContaining('Karensavdraget för timavlönade bygger på Timmar per vecka hos den anställde: Olle Testsson (40 tim/vecka)'),
    )
  })

  it('refuses the run by name when a sick row has no hours, and writes nothing', async () => {
    const { db, result } = await calculate(scenario([8, 0, 8]))
    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: {
        issues: [expect.stringMatching(/^Olle Testsson: Sjukdagen 2026-09-15 saknar timmar/)],
        reason: 'absence_input_incomplete',
      },
    })
    expect(db.rows('salary_line_items').map((li) => li.id)).toEqual(['li-olle-base'])
    expect(db.rows('salary_run_employees').find((row) => row.id === SRE)!.gross_salary).toBe(0)
  })
})
