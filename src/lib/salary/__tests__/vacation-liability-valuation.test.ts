/**
 * computeVacationLiability against a per-table mock: which runs count by the
 * date, the run being booked, a raise, part-time, hourly procentregeln, the
 * 67+ tier; and the remeasurement's starting point (a run's own posted
 * vouchers left out, a corrected run's remeasurement no anchor).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/salary/personnummer', async () => {
  const actual = await vi.importActual<typeof import('@/lib/salary/personnummer')>('@/lib/salary/personnummer')
  return {
    ...actual,
    decryptPersonnummer: (encrypted: string) => {
      const m = /^mock_born_(\d{4})$/.exec(encrypted)
      if (!m) throw new Error('not an encrypted fixture')
      return `${m[1]}06151234`
    },
  }
})

const trialBalance = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: trialBalance }))

import { roundOre } from '@/lib/money'
import { computeVacationLiability } from '../vacation-liability-valuation'
import { previewVacationYearClose } from '../semesterberedning'
import { generateBookedVacationSpec } from '@/lib/reports/vacation-liability'

const COMPANY = 'company-1'

function employee(over: Record<string, unknown>) {
  return {
    id: 'emp-1',
    first_name: 'Anna',
    last_name: 'Andersson',
    employment_type: 'employee',
    personnel_category: 'tjansteman',
    personnummer: 'mock_born_1985',
    default_dimensions: null,
    vacation_rule: 'sammaloneregeln',
    vacation_days_per_year: 25,
    vacation_days_saved: 0,
    vacation_pay_rate: null,
    semestertillagg_rate: 0.0043,
    salary_type: 'monthly',
    monthly_salary: 30000,
    employment_degree: 100,
    hourly_rate: null,
    hours_per_week: 40,
    workdays_per_week: 5,
    employment_start: '2020-01-01',
    employment_end: null,
    ...over,
  }
}

/** A payslip row with `days` of paid vacation, as the ledger query reads it. */
function run(id: string, month: number, days: number, status = 'booked', employeeId = 'emp-1') {
  const mm = String(month).padStart(2, '0')
  return {
    employee_id: employeeId,
    vacation_days_taken: days,
    vacation_paid_days_per_day_off: 1,
    line_items: days ? [{ item_type: 'vacation', quantity: days, vacation_category: 'paid', vacation_saved_year: null }] : [],
    salary_run: {
      id,
      payment_date: `2026-${mm}-25`,
      period_year: 2026,
      period_month: month,
      status,
      deviation_period_start: null,
      deviation_period_end: null,
    },
  }
}

type Chain = { method: string; args: unknown[] }[]
const selected = (chain: Chain) => String(chain.find((c) => c.method === 'select')?.args[0] ?? '')
const filtered = (chain: Chain, column: string) => chain.find((c) => c.method === 'eq' && c.args[0] === column)?.args[1]

function mockCompany(args: {
  employees: Array<Record<string, unknown>>
  runs?: Array<ReturnType<typeof run>>
  payslips?: Array<Record<string, unknown>>
  basis?: 'calendar' | 'statutory_apr_mar'
  policy?: Record<string, unknown>
}) {
  const runs = args.runs ?? []
  const { supabase } = createTableMockSupabase({
    company_settings: { data: { salary_vacation_year_basis: args.basis ?? 'calendar', salary_calculation_policy: args.policy ?? {} } },
    employees: { data: args.employees },
    employee_vacation_balances: { data: [] },
    employee_opening_balances: { data: [] },
    salary_run_employees: (chain: Chain) => {
      const select = selected(chain)
      if (select.includes('vacation_days_taken')) {
        const inFlight = filtered(chain, 'salary_run_id')
        return { data: inFlight ? runs.filter((r) => r.salary_run.id === inFlight) : runs.filter((r) => r.salary_run.status === 'booked') }
      }
      // The rörliga lönedelar and the procentregeln payslips.
      return { data: args.payslips ?? [] }
    },
  })
  return supabase as unknown as SupabaseClient
}

describe('computeVacationLiability', () => {
  it('sammalöneregeln after a raise: every owed day at the new salary; leave counts by the date', async () => {
    const supabase = mockCompany({
      employees: [employee({ monthly_salary: 33000 })],
      // July's leave is counted by 30 September; October's is not yet.
      runs: [run('run-jul', 7, 10), run('run-oct', 10, 5)],
    })
    const valuation = await computeVacationLiability(supabase, COMPANY, '2026-09-30')
    const row = valuation.rows[0]
    const earned = (25 * 273) / 365
    expect(row.days.current_year_days).toBeCloseTo(earned - 10, 4)
    expect(row.day_value_sek).toBe(roundOre(33000 / 21 + 33000 * 0.0043))
    expect(row.computed_liability_sek).toBe(roundOre(row.days.total_days * row.day_value_sek))
    expect(row.computed_avgifter_sek).toBe(roundOre(row.computed_liability_sek * 0.3142))
    expect(valuation.totals.computed_liability).toBe(row.computed_liability_sek)
  })

  it('the run being booked counts as booked: its leave relieves the liability it is valued in', async () => {
    const runs = [run('run-sep', 9, 4, 'paid')]
    const without = await computeVacationLiability(mockCompany({ employees: [employee({})], runs }), COMPANY, '2026-09-25')
    const withRun = await computeVacationLiability(mockCompany({ employees: [employee({})], runs }), COMPANY, '2026-09-25', {
      inFlightRunId: 'run-sep',
    })
    expect(roundOre(without.rows[0].days.total_days - withRun.rows[0].days.total_days)).toBe(4)
  })

  it('part-time: the day is a day of the pay earned at the employment degree', async () => {
    const valuation = await computeVacationLiability(
      mockCompany({ employees: [employee({ employment_degree: 50, monthly_salary: 40000 })] }),
      COMPANY,
      '2026-12-31',
    )
    expect(valuation.rows[0].day_value_sek).toBe(roundOre(20000 / 21 + 20000 * 0.0043))
    expect(valuation.rows[0].computed_liability_sek).toBe(roundOre(25 * valuation.rows[0].day_value_sek))
  })

  it('the 4,6 % convention prices the sammalöneregeln day', async () => {
    const valuation = await computeVacationLiability(
      mockCompany({ employees: [employee({})], policy: { vacation_day_value: 'percent_4_6' } }),
      COMPANY,
      '2026-12-31',
    )
    expect(valuation.day_value_policy).toBe('percent_4_6')
    expect(valuation.rows[0].day_value_sek).toBe(roundOre(30000 * 0.046 + 30000 * 0.0043))
  })

  it('a 67+ employee: at the year end the liability settles next year, at the reduced rate', async () => {
    const supabase = () => mockCompany({ employees: [employee({ personnummer: 'mock_born_1959' })] })
    const midYear = await computeVacationLiability(supabase(), COMPANY, '2026-06-30')
    const yearEnd = await computeVacationLiability(supabase(), COMPANY, '2026-12-31')
    expect(midYear.rows[0].avgifter_rate).toBe(0.3142)
    expect(yearEnd.rows[0].avgifter_rate).toBe(0.1021)
    expect(yearEnd.rows[0].computed_avgifter_sek).toBe(roundOre(yearEnd.rows[0].computed_liability_sek * 0.1021))
  })

  it('hourly procentregeln on the statutory basis: earning year per day plus this year\'s semesterunderlag', async () => {
    const breakdown = (basis: number) => ({
      steps: [{ label: 'Semesteravsättning (procentregeln 12 %)', input: { vacation_basis: basis } }],
    })
    const slip = (year: number, month: number, basis: number) => ({
      employee_id: 'emp-1',
      calculation_breakdown: breakdown(basis),
      salary_type: 'hourly',
      line_items: [],
      salary_run: { id: `r-${year}-${month}`, payment_date: `${year}-${String(month).padStart(2, '0')}-25`, status: 'booked' },
    })
    const earningYear = [4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => slip(2025, m, 20000)).concat([1, 2, 3].map((m) => slip(2026, m, 20000)))
    const thisYear = [4, 5, 6, 7, 8, 9].map((m) => slip(2026, m, 22000))
    const valuation = await computeVacationLiability(
      mockCompany({
        basis: 'statutory_apr_mar',
        employees: [employee({ vacation_rule: 'procentregeln', salary_type: 'hourly', monthly_salary: null, hourly_rate: 180 })],
        runs: [run('r-2026-7', 7, 5)],
        payslips: [...earningYear, ...thisYear],
      }),
      COMPANY,
      '2026-09-30',
    )
    const row = valuation.rows[0]
    expect(row.day_value_basis).toBe('earning_year')
    expect(row.day_value_sek).toBe(1152)
    // 25 entitled (statutory, employed all year) - 5 taken = 20 days at 1 152, plus 12 % of 132 000.
    expect(row.computed_liability_sek).toBe(roundOre(20 * 1152 + 0.12 * 132000))
    expect(row.valued_days).toBe(20)
    expect(row.earning_sek).toBe(15840)
  })
})

/** A procentregeln payslip of `basis` (the run engine's breakdown step), paid the 25th. */
function procentSlip(employeeId: string, year: number, month: number, basis: number) {
  const mm = String(month).padStart(2, '0')
  return {
    employee_id: employeeId,
    calculation_breakdown: { steps: [{ label: 'Semesteravsättning (procentregeln 12 %)', input: { vacation_basis: basis } }] },
    salary_type: 'monthly',
    line_items: [],
    salary_run: { id: `r-${year}-${mm}`, payment_date: `${year}-${mm}-25`, status: 'booked' },
  }
}

const slips = (employeeId: string, year: number, months: number[], basis = 35000) => months.map((m) => procentSlip(employeeId, year, m, basis))
const JUNE_TO_DECEMBER = [6, 7, 8, 9, 10, 11, 12]

describe('a hire during the intjänandeår (Semesterlagen 7 §, 16 b §)', () => {
  const procentHire = (id: string) =>
    employee({ id, first_name: id, vacation_rule: 'procentregeln', monthly_salary: 35000, employment_start: '2026-06-01' })

  it('procentregeln, calendar basis: two hires on 1 June, seven payslips each, owe 15 days at 1 960 each, 58 800 kr', async () => {
    const valuation = await computeVacationLiability(
      mockCompany({
        employees: [procentHire('emp-1'), procentHire('emp-2')],
        payslips: [...slips('emp-1', 2026, JUNE_TO_DECEMBER), ...slips('emp-2', 2026, JUNE_TO_DECEMBER)],
      }),
      COMPANY,
      '2026-12-31',
    )
    for (const row of valuation.rows) {
      expect(row.days.current_year_days).toBe(15)
      expect(row.day_value_sek).toBe(1960)
      expect(row.valued_days).toBe(15)
      expect(row.earning_sek).toBe(0)
      // 12 % of 7 x 35 000: from the payslips, not today's pay.
      expect(row.computed_liability_sek).toBe(29400)
      expect(row.day_value_basis).toBe('earning_year')
    }
    expect(valuation.totals.computed_liability).toBe(58800)
    expect(valuation.totals.computed_avgifter).toBe(roundOre(2 * roundOre(29400 * 0.3142)))
  })

  it('procentregeln, calendar basis: a month without a payslip falls back to today\'s pay, over the 15 days, flagged', async () => {
    const valuation = await computeVacationLiability(
      mockCompany({ employees: [procentHire('emp-1')], payslips: slips('emp-1', 2026, [6, 7, 9, 10, 11, 12]) }),
      COMPANY,
      '2026-12-31',
    )
    const row = valuation.rows[0]
    expect(row.day_value_basis).toBe('current_pay')
    expect(row.day_value_sek).toBe(2016)
    expect(row.computed_liability_sek).toBe(15 * 2016)
  })

  it('sammalöneregeln, calendar basis: a hire on 1 June owes 15 days at the sammalöneregeln day value', async () => {
    const valuation = await computeVacationLiability(
      mockCompany({ employees: [employee({ monthly_salary: 35000, employment_start: '2026-06-01' })] }),
      COMPANY,
      '2026-12-31',
    )
    const dayValue = roundOre(35000 / 21 + 35000 * 0.0043)
    expect(valuation.rows[0].days.total_days).toBe(15)
    expect(valuation.rows[0].day_value_sek).toBe(dayValue)
    expect(valuation.rows[0].computed_liability_sek).toBe(roundOre(15 * dayValue))
  })

  it('procentregeln, calendar basis: an employee of the whole year is unchanged, 25 days at 2 016', async () => {
    const valuation = await computeVacationLiability(
      mockCompany({
        employees: [employee({ vacation_rule: 'procentregeln', monthly_salary: 35000 })],
        payslips: slips('emp-1', 2026, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      }),
      COMPANY,
      '2026-12-31',
    )
    const row = valuation.rows[0]
    expect(row.day_value_sek).toBe(2016)
    expect(row.valued_days).toBe(25)
    expect(row.computed_liability_sek).toBe(50400)
    expect(row.day_value_basis).toBe('earning_year')
  })

  it('procentregeln, statutory basis: an employee of the whole year is unchanged, owed days plus the running year\'s 12 %', async () => {
    const valuation = await computeVacationLiability(
      mockCompany({
        basis: 'statutory_apr_mar',
        employees: [employee({ vacation_rule: 'procentregeln', monthly_salary: 35000 })],
        payslips: [...slips('emp-1', 2025, [4, 5, 6, 7, 8, 9, 10, 11, 12]), ...slips('emp-1', 2026, [1, 2, 3]), ...slips('emp-1', 2026, [4, 5, 6, 7, 8, 9, 10, 11, 12])],
      }),
      COMPANY,
      '2026-12-31',
    )
    const row = valuation.rows[0]
    expect(row.day_value_sek).toBe(2016)
    expect(row.valued_days).toBe(25)
    expect(row.earning_sek).toBe(37800)
    expect(row.computed_liability_sek).toBe(25 * 2016 + 37800)
  })

  it('the year close values a calendar-year procentregeln hire the same: 15 days at 1 960, next year 25 days', async () => {
    const hire = employee({ vacation_rule: 'procentregeln', monthly_salary: 35000, employment_start: '2025-06-01' })
    const ledger2025 = {
      id: 'vb-2025',
      employee_id: 'emp-1',
      vacation_year_start: '2025-01-01',
      // What the ledger sync now writes: 214/365 x 25, rounded up.
      entitled_days: 15,
      accrued_days: 0,
      taken_days: 0,
      saved_days: {},
      forced_payout_days: 0,
      status: 'open',
      unpaid_days: 0,
      advance_days: 0,
      saved_days_taken: {},
    }
    const { supabase } = createTableMockSupabase({
      company_settings: { data: { salary_vacation_year_basis: 'calendar', salary_calculation_policy: {} } },
      employees: { data: [hire] },
      employee_vacation_balances: { data: [ledger2025] },
      employee_opening_balances: { data: [] },
      vacation_year_closures: { data: null },
      fiscal_periods: { data: { id: 'fp-2025', period_start: '2025-01-01', period_end: '2025-12-31' } },
      salary_run_employees: (chain: Chain) => ({ data: selected(chain).includes('vacation_days_taken') ? [] : slips('emp-1', 2025, JUNE_TO_DECEMBER) }),
    })
    trialBalance.mockResolvedValue({
      rows: [
        { account_number: '2920', closing_credit: 29400, closing_debit: 0 },
        { account_number: '2940', closing_credit: roundOre(29400 * 0.3142), closing_debit: 0 },
      ],
    })
    const close = await previewVacationYearClose(supabase as unknown as SupabaseClient, COMPANY, '2025-01-01')
    expect(close.ok).toBe(true)
    if (!close.ok) return
    const row = close.data.rows[0]
    expect(row.remaining_days).toBe(15)
    expect(row.day_value_sek).toBe(1960)
    expect(row.computed_liability_sek).toBe(29400)
    expect(row.next_year_entitled).toBe(25)
    // The per-run accruals (12 % of each payslip) already hold it: nothing to adjust.
    expect(close.data.sek.drift_2920).toBe(0)
  })
})

describe('the remeasurement\'s starting point', () => {
  let queued: ReturnType<typeof createQueuedMockSupabase>
  beforeEach(() => {
    queued = createQueuedMockSupabase()
  })

  const EMP = { id: 'emp-1', first_name: 'Anna', last_name: 'A', personnummer_last4: '0000', employment_type: 'employee', personnel_category: 'tjansteman', vacation_rule: 'sammaloneregeln', vacation_days_per_year: 25, vacation_days_saved: 0, workdays_per_week: 5 }
  const accrualRun = (id: string, date: string, accrual: number, status = 'booked') => ({
    employee_id: 'emp-1',
    vacation_accrual: accrual,
    vacation_accrual_avgifter: roundOre(accrual * 0.3142),
    avgifter_rate: 0.3142,
    vacation_days_taken: 0,
    vacation_paid_days_per_day_off: 1,
    salary_run: { id, payment_date: date, status },
  })

  /** basis, closures, employees, booked runs, ledger rows, opening rows, remeasurements. */
  function queueSpec(remeasurements: Array<Record<string, unknown>>, runs: Array<Record<string, unknown>>) {
    queued.enqueue({ data: null })
    queued.enqueue({ data: [] })
    queued.enqueue({ data: [EMP] })
    queued.enqueue({ data: runs })
    queued.enqueue({ data: [] })
    queued.enqueue({ data: [] })
    queued.enqueue({ data: remeasurements })
  }

  const remeasurement = (asOf: string, runId: string | null, runStatus: string | null, liability: number) => ({
    as_of_date: asOf,
    created_at: `${asOf}T12:00:00Z`,
    kind: runId ? 'salary_run' : 'standalone',
    salary_run_id: runId,
    journal_entry_id: runId ? null : 'je-1',
    report: { rows: [{ employee_id: 'emp-1', computed_liability_sek: liability, computed_avgifter_sek: roundOre(liability * 0.3142) }] },
    salary_run: runStatus ? { status: runStatus } : null,
    journal_entry: runId ? null : { status: 'posted' },
  })

  it('starts from the latest standing remeasurement and adds only accruals booked after it', async () => {
    queueSpec(
      [remeasurement('2026-05-25', 'run-may', 'booked', 15000)],
      [accrualRun('run-apr', '2026-04-25', 900), accrualRun('run-may', '2026-05-25', 900), accrualRun('run-jun', '2026-06-25', 1100)],
    )
    const spec = await generateBookedVacationSpec(queued.supabase as unknown as SupabaseClient, COMPANY, '2026-06-30')
    expect(spec.remeasuredAt).toBe('2026-05-25')
    // 15 000 at the anchor, plus June's accrual (an accrual-method run).
    expect(spec.rows[0].accruedAmount).toBe(16100)
  })

  it('a corrected run\'s remeasurement is no anchor: its vouchers were reversed, the earlier one stands again', async () => {
    queueSpec(
      [remeasurement('2026-06-25', 'run-jun', 'corrected', 18000), remeasurement('2026-05-25', 'run-may', 'booked', 15000)],
      [accrualRun('run-may', '2026-05-25', 900)],
    )
    const spec = await generateBookedVacationSpec(queued.supabase as unknown as SupabaseClient, COMPANY, '2026-06-30')
    expect(spec.remeasuredAt).toBe('2026-05-25')
    expect(spec.rows[0].accruedAmount).toBe(15000)
  })

  it('a remeasured run adds no accrual of its own', async () => {
    queueSpec(
      [remeasurement('2026-06-25', 'run-jun', 'booked', 16000)],
      [accrualRun('run-jun', '2026-06-25', 1100)],
    )
    const spec = await generateBookedVacationSpec(queued.supabase as unknown as SupabaseClient, COMPANY, '2026-06-30')
    expect(spec.rows[0].accruedAmount).toBe(16000)
    expect(spec.rows[0].accruedAvgifter).toBe(roundOre(16000 * 0.3142))
  })
})

describe('year close after remeasuring: no double count', () => {
  it('the close values the same liability the remeasurement booked on the year end, so its drift is nil', async () => {
    const leave2025 = {
      ...run('run-2025-07', 7, 15),
      salary_run: { ...run('run-2025-07', 7, 15).salary_run, payment_date: '2025-07-25', period_year: 2025 },
    }
    const ledger2025 = {
      id: 'vb-2025',
      employee_id: 'emp-1',
      vacation_year_start: '2025-01-01',
      entitled_days: 25,
      accrued_days: 0,
      taken_days: 15,
      saved_days: { '2024': 3 },
      forced_payout_days: 0,
      status: 'open',
      unpaid_days: 0,
      advance_days: 0,
      saved_days_taken: {},
    }
    const make = () =>
      createTableMockSupabase({
        company_settings: { data: { salary_vacation_year_basis: 'calendar', salary_calculation_policy: {} } },
        // Born mid-1958: 67 at the start of 2026, the year the 2025 liability settles in.
        employees: { data: [employee({ personnummer: 'mock_born_1958' })] },
        employee_vacation_balances: { data: [ledger2025] },
        employee_opening_balances: { data: [] },
        vacation_year_closures: { data: null },
        fiscal_periods: { data: { id: 'fp-2025', period_start: '2025-01-01', period_end: '2025-12-31' } },
        salary_run_employees: (chain: Chain) => ({ data: selected(chain).includes('vacation_days_taken') ? [leave2025] : [] }),
      }).supabase as unknown as SupabaseClient

    // A remeasured company: 2920/2940 hold the computed liability of 31 December.
    const remeasured = await computeVacationLiability(make(), COMPANY, '2025-12-31')
    expect(remeasured.rows[0].days.total_days).toBe(13)
    trialBalance.mockResolvedValue({
      rows: [
        { account_number: '2920', closing_credit: remeasured.totals.computed_liability, closing_debit: 0 },
        { account_number: '2940', closing_credit: remeasured.totals.computed_avgifter, closing_debit: 0 },
      ],
    })

    const close = await previewVacationYearClose(make(), COMPANY, '2025-01-01')
    expect(close.ok).toBe(true)
    if (!close.ok) return
    expect(close.data.sek.computed_liability).toBe(remeasured.totals.computed_liability)
    expect(close.data.sek.computed_avgifter).toBe(remeasured.totals.computed_avgifter)
    expect(close.data.sek.drift_2920).toBe(0)
    expect(close.data.sek.drift_2940).toBe(0)
    expect(close.data.sek.adjustment_needed).toBe(false)
    // The 67+ tier of the settlement year, in both.
    expect(close.data.rows[0].avgifter_rate).toBe(0.1021)
  })
})

