/**
 * Area b of the payroll scenario catalogue: semesterlöneskuld valuation
 * (vacation-liability.scenarios.ts holds the data and the sources).
 *
 * The year-close scenarios run previewVacationYearClose over the queued
 * Supabase mock; only the trial balance (the booked 2920/2940), the ledger
 * sync and the vacation-year basis (calendar) are stubbed, as in
 * semesterberedning.test.ts.
 *
 * The true-up and convention scenarios run computeVacationLiability over a
 * per-table mock (company settings with the day-value policy, the roster,
 * no ledger rows or payslips), then buildRemeasurePlan against the booked
 * balances. The owed-day count is the scenario's input: the runner hands it
 * over in place of vacationLiabilityDays for those runs only (every other
 * call, the year close included, goes to the real function).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import { roundOre } from '@/lib/money'
import { scenarioTestName } from './catalogue'
import { actualFor, runPayslip } from './harness'
import {
  LIABILITY_SCENARIOS,
  type ConventionInputs,
  type LiabilityScenario,
  type TrueUpInputs,
  type YearCloseInputs,
} from './vacation-liability.scenarios'

const mockTrialBalance = vi.fn()
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: (...a: unknown[]) => mockTrialBalance(...a),
}))

vi.mock('@/lib/salary/vacation-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/salary/vacation-ledger')>()
  return {
    ...actual,
    getVacationYearBasis: vi.fn().mockResolvedValue('calendar'),
    syncVacationLedgerForEmployees: vi.fn().mockResolvedValue({ ok: true }),
  }
})

// Owed days handed to the valuation in roster order; empty = the real count.
const forcedDays = vi.hoisted(() => ({ queue: [] as number[] }))
vi.mock('@/lib/salary/vacation-liability-days', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/salary/vacation-liability-days')>()
  return {
    ...actual,
    vacationLiabilityDays: (input: Parameters<typeof actual.vacationLiabilityDays>[0]) => {
      const days = forcedDays.queue.shift()
      if (days === undefined) return actual.vacationLiabilityDays(input)
      return { current_year_days: days, saved_days: 0, earning_days: 0, unclosed_year_days: 0, total_days: days }
    },
  }
})

// 'mock_born_YYYY' decrypts to a mid-year birth in YYYY (the year close);
// a plaintext 12-digit personnummer passes through (the payslip runs).
vi.mock('@/lib/salary/personnummer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/salary/personnummer')>()
  return {
    ...actual,
    decryptPersonnummer: (value: string) => {
      const m = /^mock_born_(\d{4})$/.exec(value)
      return m ? `${m[1]}06151234` : value
    },
  }
})

import { dayValueSek, previewVacationYearClose } from '../../semesterberedning'
import { computeVacationLiability } from '../../vacation-liability-valuation'
import { buildRemeasurePlan } from '../../vacation-liability-plan'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let mock: ReturnType<typeof createQueuedMockSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  forcedDays.queue.length = 0
  mock = createQueuedMockSupabase()
})

/**
 * The earning year's payslips as procentregeln-liability.ts reads them: twelve
 * booked runs, one per month of the closing year, each carrying a twelfth of
 * the semesterunderlag in its "Semesteravsättning (procentregeln ...)" step
 * (the calculation_breakdown the run engine stores).
 */
function earningYearPayslips(inputs: YearCloseInputs) {
  const total = inputs.earningYearSemesterunderlag ?? 0
  const year = inputs.closingYearStart.slice(0, 4)
  const perMonth = roundOre(total / 12)
  return Array.from({ length: 12 }, (_, i) => {
    const mm = String(i + 1).padStart(2, '0')
    return {
      employee_id: EMPLOYEE_ID,
      calculation_breakdown: { steps: [{ label: 'Semesteravsättning (procentregeln 12 %)', input: { vacation_basis: i === 11 ? roundOre(total - 11 * perMonth) : perMonth } }] },
      salary_run: { id: `run-${year}-${mm}`, payment_date: `${year}-${mm}-25`, status: 'booked' },
    }
  })
}

interface ValuationEmployee {
  vacation_rule: 'sammaloneregeln' | 'procentregeln'
  monthly_salary: number
  semestertillagg_rate: number
  birthYear: number
}

/** computeVacationLiability for a roster with the given owed days, under a day-value policy. */
async function runValuation(args: {
  asOfDate: string
  policy: 'daily_divisor' | 'percent_4_6'
  employees: Array<ValuationEmployee & { days: number }>
}) {
  const roster = args.employees.map((e, i) => ({
    id: `emp-${i + 1}`,
    first_name: 'Scenario',
    last_name: `Employee ${i + 1}`,
    employment_type: 'employee',
    personnel_category: null,
    personnummer: `mock_born_${e.birthYear}`,
    default_dimensions: null,
    vacation_rule: e.vacation_rule,
    vacation_days_per_year: 25,
    vacation_days_saved: 0,
    vacation_pay_rate: null,
    semestertillagg_rate: e.semestertillagg_rate,
    salary_type: 'monthly',
    monthly_salary: e.monthly_salary,
    employment_degree: 100,
    hourly_rate: null,
    hours_per_week: 40,
    workdays_per_week: 5,
    employment_start: '2019-03-01',
    employment_end: null,
  }))
  const { supabase } = createTableMockSupabase({
    company_settings: { data: { salary_vacation_year_basis: 'calendar', salary_calculation_policy: { vacation_day_value: args.policy } } },
    employees: { data: roster },
    employee_vacation_balances: { data: [] },
    employee_opening_balances: { data: [] },
    salary_run_employees: { data: [] },
  })
  forcedDays.queue.push(...args.employees.map((e) => e.days))
  const valuation = await computeVacationLiability(supabase as unknown as SupabaseClient, COMPANY_ID, args.asOfDate)
  expect(forcedDays.queue, 'every forced day count was consumed').toEqual([])
  return valuation
}

/** The scenario's salaryShare names the convention: 4,6 % is percent_4_6. */
function policyFor(inputs: ConventionInputs): 'percent_4_6' {
  if (inputs.salaryShare !== 0.046) throw new Error(`no vacation_day_value convention for a ${inputs.salaryShare} salary share`)
  return 'percent_4_6'
}

/** Sum of a verifikat's lines on one account, debit positive. */
function net(lines: Array<{ account_number: string; debit_amount?: number; credit_amount?: number }>, account: string): number {
  return roundOre(lines.filter((l) => l.account_number === account).reduce((s, l) => s + (l.debit_amount ?? 0) - (l.credit_amount ?? 0), 0))
}

async function runTrueUp(inputs: TrueUpInputs) {
  const valuation = await runValuation({
    asOfDate: inputs.asOfDate,
    policy: 'daily_divisor',
    employees: inputs.employees.map((e) => ({ ...e, days: e.remainingDays })),
  })
  // The booked specification: one employee holds the whole booked balance
  // (several: the plan spreads the rest over the computed liabilities).
  const spec =
    valuation.rows.length === 1
      ? [{ employeeId: valuation.rows[0].employee_id, employeeName: valuation.rows[0].employee_name, accruedAmount: inputs.booked2920, accruedAvgifter: inputs.booked2940, liabilityChangeAccount: valuation.rows[0].liability_change_account }]
      : []
  const plan = buildRemeasurePlan(valuation, spec, { booked2920: inputs.booked2920, booked2940: inputs.booked2940 })
  return { valuation, plan }
}

async function runYearClose(inputs: YearCloseInputs) {
  mockTrialBalance.mockResolvedValue({
    rows: [
      { account_number: '2920', closing_credit: inputs.booked2920, closing_debit: 0 },
      { account_number: '2940', closing_credit: inputs.booked2940, closing_debit: 0 },
    ],
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  })
  mock.enqueue({ data: null }) // vacation_year_closures: not closed yet
  mock.enqueue({
    data: [
      {
        id: EMPLOYEE_ID,
        first_name: 'Scenario',
        last_name: 'Employee',
        employment_type: 'employee',
        personnel_category: null,
        salary_type: 'monthly',
        employment_degree: 100,
        hourly_rate: null,
        hours_per_week: 40,
        workdays_per_week: 5,
        employment_start: '2019-03-01',
        employment_end: null,
        ...inputs.employee,
      },
    ],
  })
  mock.enqueue({
    data: [
      {
        id: 'vb-1',
        employee_id: EMPLOYEE_ID,
        vacation_year_start: inputs.closingYearStart,
        accrued_days: 0,
        forced_payout_days: 0,
        status: 'open',
        ...inputs.ledger,
      },
    ],
  })
  mock.enqueue({ data: [] }) // employee_opening_balances
  if (inputs.employee.vacation_rule === 'sammaloneregeln') mock.enqueue({ data: [] }) // rörliga lönedelar history
  const year = inputs.closingYearStart.slice(0, 4)
  mock.enqueue({ data: { id: `fp-${year}`, period_start: `${year}-01-01`, period_end: `${year}-12-31` } })
  mock.enqueue({ data: null }) // company_settings: default day-value policy
  if (inputs.employee.vacation_rule === 'procentregeln') mock.enqueue({ data: earningYearPayslips(inputs) })
  const result = await previewVacationYearClose(mock.supabase as unknown as SupabaseClient, COMPANY_ID, inputs.closingYearStart)
  if (!result.ok) throw new Error(`year close refused: ${result.code}`)
  return result.data
}

async function runScenario(s: LiabilityScenario): Promise<void> {
  switch (s.kind) {
    case 'day-value':
      expect({ dayValue: dayValueSek(s.inputs) }).toEqual(s.expected)
      return
    case 'payslip':
      expect(actualFor(runPayslip(s.inputs), s.expected)).toEqual(s.expected)
      return
    case 'year-close': {
      const report = await runYearClose(s.inputs)
      const row = report.rows[0]
      const actual: Record<string, unknown> = {}
      for (const key of Object.keys(s.expected)) {
        if (key === 'computed_liability') actual[key] = report.sek.computed_liability
        else if (key === 'computed_avgifter') actual[key] = report.sek.computed_avgifter
        else if (key === 'drift_2920') actual[key] = report.sek.drift_2920
        else if (key === 'drift_2940') actual[key] = report.sek.drift_2940
        else actual[key] = (row as unknown as Record<string, unknown>)[key]
      }
      expect(actual).toEqual(s.expected)
      return
    }
    case 'true-up': {
      const { valuation, plan } = await runTrueUp(s.inputs)
      expect({
        dayValues: valuation.rows.map((r) => r.day_value_sek),
        target2920: plan.computed_liability,
        target2940: plan.computed_avgifter,
        entry2920: plan.difference_2920,
        entry2940: plan.difference_2940,
      }).toEqual(s.expected)
      // One verifikat: debit 7290 / credit 2920 and debit 7519 / credit 2940
      // when the target is above what is booked, the reverse below it.
      expect({
        '7290': net(plan.lines, '7290'),
        '2920': net(plan.lines, '2920'),
        '7519': net(plan.lines, '7519'),
        '2940': net(plan.lines, '2940'),
      }).toEqual({ '7290': s.expected.entry2920, '2920': -s.expected.entry2920, '7519': s.expected.entry2940, '2940': -s.expected.entry2940 })
      return
    }
    case 'convention': {
      const valuation = await runValuation({
        asOfDate: s.inputs.asOfDate,
        policy: policyFor(s.inputs),
        employees: [
          {
            vacation_rule: 'sammaloneregeln',
            monthly_salary: s.inputs.monthlySalary,
            semestertillagg_rate: s.inputs.tillagg,
            birthYear: s.inputs.birthYear,
            days: s.inputs.days,
          },
        ],
      })
      const row = valuation.rows[0]
      expect({ perDay: row.day_value_sek, liability: row.computed_liability_sek, avgifter: row.computed_avgifter_sek }).toEqual(s.expected)
      return
    }
  }
}

describe('payroll scenarios, area b: vacation liability', () => {
  for (const s of LIABILITY_SCENARIOS) {
    const name = scenarioTestName(s)
    if (s.status === 'todo') it.todo(name)
    // SCENARIO_SHOW_BUGS=1 runs the suspected engine bugs as plain tests, to see the diff.
    else if (s.status === 'engine-bug' && !process.env.SCENARIO_SHOW_BUGS) it.fails(`${name} [suspected engine bug, see note]`, () => runScenario(s))
    else it(name, () => runScenario(s))
  }
})
