/**
 * Text rows (item_type 'text', lib/salary/text-rows.ts) through the real
 * runSalaryCalculation: a manual text row and a recurring text line are
 * words on the payslip and nothing else, so the engine input, the computed
 * roster row and the run totals are byte-identical to the same run without
 * them. The recurring text line is still derived into the run (copied as
 * words only) so the issued payslip keeps the text it was issued with.
 *
 * Same harness as run-calculation-golden.test.ts: the real orchestration,
 * engine and tax-table parsing over payroll-fake-db.ts, Skatteverket served
 * from the bundled 2026 tables.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/logger'
import { clearTaxTableCache } from '../tax-tables'
import { createPayrollFakeDb, type Row } from './payroll-fake-db'
import { draftRun, employee, line, PAYROLL_CONFIG_2026, rosterRow, skatteverketFetch } from './payroll-fixtures'
import { RECURRING_TEXT_SORT_ORDER, TEXT_ROW_FLAGS } from '../text-rows'

vi.mock('../calculation-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../calculation-engine')>()
  return { ...actual, calculateSalary: vi.fn(actual.calculateSalary) }
})

import { calculateSalary } from '../calculation-engine'
import { runSalaryCalculation } from '../run-calculation'

const CO = 'company-text'
const RUN = 'run-text-2026-09'
const EMP = 'emp-anna'
const SRE = `sre-${RUN}-${EMP}`

function recurring(id: string, fields: Row): Row {
  return {
    id,
    company_id: CO,
    employee_id: EMP,
    account_number: null,
    is_active: true,
    valid_from: '2026-01-01',
    valid_to: null,
    created_at: '2026-01-02T08:00:00Z',
    ...fields,
  }
}

const MANUAL_TEXT = line(CO, SRE, 'li-text-manual', {
  item_type: 'text',
  description: 'Lön enligt kollektivavtal, se bilaga',
  amount: 0,
  ...TEXT_ROW_FLAGS,
  sort_order: 5,
})

const RECURRING_TEXT = recurring('rec-text', {
  item_type: 'text',
  description: 'Grundlön 40 000 kr + personligt tillägg 2 000 kr',
  amount: 0,
  // Created between the two money lines, so its index among the recurring
  // lines is 1, not 0.
  created_at: '2026-01-03T08:00:00Z',
})

function seed({ manualText = false, recurringText = false } = {}): Record<string, Row[]> {
  const anna = employee(CO, EMP, {
    first_name: 'Anna',
    personnummer: '198504120000',
    monthly_salary: 42000,
    tax_table_number: 33,
    tax_column: 1,
  })
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [{ company_id: CO, salary_net_rounding: true, salary_calculation_policy: {} }],
    salary_runs: [draftRun(CO, RUN, { period_year: 2026, period_month: 9, payment_date: '2026-09-25' })],
    employees: [anna],
    salary_run_employees: [rosterRow(CO, RUN, anna)],
    salary_line_items: [
      line(CO, SRE, 'li-base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 42000 }),
      line(CO, SRE, 'li-bonus', {
        item_type: 'bonus',
        description: 'Bonus Q3',
        amount: 5000,
        is_vacation_basis: false,
        sort_order: 20,
      }),
      ...(manualText ? [MANUAL_TEXT] : []),
    ],
    employee_opening_balances: [],
    salary_absence_days: [],
    salary_worked_days: [],
    shift_premium_rules: [],
    employee_benefits: [],
    employee_recurring_lines: [
      recurring('rec-union', {
        item_type: 'net_deduction_union',
        description: 'Fackavgift Unionen',
        amount: -450,
      }),
      ...(recurringText ? [RECURRING_TEXT] : []),
      recurring('rec-pension', {
        item_type: 'gross_deduction_pension',
        description: 'Löneväxling tjänstepension',
        amount: -3000,
        account_number: '7412',
        created_at: '2026-01-04T08:00:00Z',
      }),
    ],
  }
}

async function calculate(db: ReturnType<typeof createPayrollFakeDb>) {
  return runSalaryCalculation({
    supabase: db.supabase,
    companyId: CO,
    salaryRunId: RUN,
    log: createLogger('test/run-calculation-text-rows'),
    requestId: 'req_text_rows',
  })
}

/** Everything a calculation decides about the pay: engine input, roster row, run totals. */
async function payOutcome(options: { manualText?: boolean; recurringText?: boolean }) {
  vi.mocked(calculateSalary).mockClear()
  const db = createPayrollFakeDb(seed(options))
  const result = await calculate(db)
  expect(result.ok).toBe(true)
  const engineCalls = vi.mocked(calculateSalary).mock.calls.map((args) => structuredClone(args))
  const roster = db.rows('salary_run_employees').find((row) => row.id === SRE) as Row
  const run = db.rows('salary_runs').find((row) => row.id === RUN) as Row
  return {
    db,
    warnings: result.ok ? result.warnings : null,
    engineCalls,
    roster,
    run,
  }
}

describe('runSalaryCalculation: text rows never reach the pay', () => {
  beforeEach(() => {
    vi.mocked(calculateSalary).mockClear()
    clearTaxTableCache()
    vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prices a run with a manual and a recurring text row exactly like the run without them', async () => {
    const plain = await payOutcome({})
    const withText = await payOutcome({ manualText: true, recurringText: true })

    // The engine saw the same input, line for line: no text row in it.
    expect(withText.engineCalls).toHaveLength(1)
    expect(withText.engineCalls).toEqual(plain.engineCalls)
    const [input] = withText.engineCalls[0]
    expect(input.lineItems.some((li) => (li.itemType as string) === 'text')).toBe(false)

    // Gross, tax, net, avgifter, the calculation trace: identical.
    expect(withText.roster).toEqual(plain.roster)
    expect(withText.roster.gross_salary).toBeGreaterThan(0)
    expect(withText.roster.tax_withheld).toBeGreaterThan(0)
    expect(withText.roster.avgifter_amount).toBeGreaterThan(0)

    // The run totals and the frozen calculation params: identical.
    expect(withText.run).toEqual(plain.run)
    expect(withText.warnings).toEqual(plain.warnings)
  }, 30_000)

  it('a manual text row alone and a recurring text line alone each leave the pay unchanged', async () => {
    const plain = await payOutcome({})
    for (const options of [{ manualText: true }, { recurringText: true }]) {
      const withText = await payOutcome(options)
      expect(withText.engineCalls).toEqual(plain.engineCalls)
      expect(withText.roster).toEqual(plain.roster)
      expect(withText.run).toEqual(plain.run)
    }
  }, 30_000)

  it('derives a recurring text line into the run as words only, linked to its recurring line', async () => {
    const { db } = await payOutcome({ recurringText: true })

    const derived = db.rows('salary_line_items').filter((row) => row.source_recurring_line_id === 'rec-text')
    expect(derived).toHaveLength(1)
    expect(derived[0]).toMatchObject({
      salary_run_employee_id: SRE,
      company_id: CO,
      item_type: 'text',
      description: 'Grundlön 40 000 kr + personligt tillägg 2 000 kr',
      quantity: null,
      amount: 0,
      account_number: null,
      ...TEXT_ROW_FLAGS,
      source_recurring_line_id: 'rec-text',
      // The only recurring text line: counted among text lines only, so the
      // money lines before it never push it past the semesterersättning (50).
      sort_order: RECURRING_TEXT_SORT_ORDER,
    })

    // The money recurring lines are derived as before, with an account.
    const union = db.rows('salary_line_items').find((row) => row.source_recurring_line_id === 'rec-union')
    expect(union).toMatchObject({ quantity: 1, amount: -450, account_number: '2794', sort_order: 250 })
  }, 30_000)

  it('leaves the manual text row as entered and keeps one copy of the recurring text across recalculations', async () => {
    const { db } = await payOutcome({ manualText: true, recurringText: true })
    vi.mocked(calculateSalary).mockClear()
    const again = await calculate(db)
    expect(again.ok).toBe(true)

    const rows = db.rows('salary_line_items')
    expect(rows.filter((row) => row.source_recurring_line_id === 'rec-text')).toHaveLength(1)
    const manual = rows.filter((row) => row.id === 'li-text-manual')
    expect(manual).toEqual([MANUAL_TEXT])
  }, 30_000)
})
