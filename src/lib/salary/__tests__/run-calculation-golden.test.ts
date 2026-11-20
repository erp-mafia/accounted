/**
 * Golden payroll fixture for runSalaryCalculation.
 *
 * Realistic runs go through the real orchestration, the real engine, the real
 * absence and premium derivations and the real tax-table parsing; only the
 * database (payroll-fake-db.ts, which applies filters and writes to plain
 * arrays) and Skatteverket's API (served from the bundled 2026 tables) are
 * stand-ins. The snapshot pins, to the öre:
 *
 *   - every engine call: the complete input and the line set it priced;
 *   - every stored row the calculation leaves behind: the run totals and its
 *     calculation_params, each roster row with its calculation trace, and
 *     every payslip line.
 *
 * It compares stored STATE, not the statements that produced it, so it holds
 * across a change of query plan. Normalised, because none of it is
 * semantically meaningful: payslip lines are sorted (the payslip orders by
 * sort_order; table order is not an order), ids the database generates are
 * masked, and a NULL column reads the same whether a write omitted it or
 * sent it as null.
 *
 * Coverage: monthly, part-time, hourly and sidoinkomst employees; F-skatt;
 * tax tables 30-34 across columns 1 and 2; jämkning with a review override;
 * the 67+ reduced and the youth avgifter (and an employee either side of
 * each threshold); sick leave with karens, återinsjuknande across the month
 * boundary and a partial day; VAB with year-to-date dates; parental leave;
 * unpaid leave; bilförmån reduced by the employee's payment; kostförmån;
 * löneväxling and union fee as recurring lines; OB evening, weekend and night
 * premiums for hourly and monthly employees; a mid-month start; engångsskatt;
 * the engine's semesterersättning row next to a manual one; öresavrundning;
 * cutover opening balances and prior-run YTD; a previous-month deviation
 * window under the calendar-day and annual-hourly conventions; a stale pay
 * type snapshot; a refused benefit payment; and an empty roster.
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

vi.mock('../calculation-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../calculation-engine')>()
  return { ...actual, calculateSalary: vi.fn(actual.calculateSalary) }
})

import { calculateSalary } from '../calculation-engine'
import { runSalaryCalculation, type RunSalaryCalculationResult } from '../run-calculation'

// ---------------------------------------------------------------------------
// Scenario A: a September run, pay month = deviation month, default
// conventions, öresavrundning on, OB rules
// ---------------------------------------------------------------------------

const A = 'company-a'
const RUN_A = 'run-a-2026-09'

function scenarioA(): Record<string, Row[]> {
  const anna = employee(A, 'emp-anna', {
    first_name: 'Anna',
    personnummer: '198504120000',
    monthly_salary: 42000,
    tax_table_number: 33,
    tax_column: 1,
  })
  const bertil = employee(A, 'emp-bertil', {
    first_name: 'Bertil',
    personnummer: '195805120000', // 67 at the start of 2026: reduced avgifter
    monthly_salary: 38000,
    employment_degree: 80,
    hours_per_week: 32,
    workdays_per_week: 4,
    tax_table_number: 32,
    tax_column: 2,
  })
  const cecilia = employee(A, 'emp-cecilia', {
    first_name: 'Cecilia',
    personnummer: '200502010000', // 20 at the start of 2026: youth avgifter
    salary_type: 'hourly',
    monthly_salary: null,
    hourly_rate: 185.5,
    tax_table_number: 34,
    tax_column: 1,
    vacation_rule: 'semesterersattning',
  })
  const david = employee(A, 'emp-david', {
    first_name: 'David',
    personnummer: '197911030000',
    monthly_salary: 28000,
    employment_degree: 50,
    hours_per_week: 20,
    is_sidoinkomst: true,
    tax_table_number: null,
  })
  const erik = employee(A, 'emp-erik', {
    first_name: 'Erik',
    personnummer: '200211300000', // 23 at the start of 2026: just past youth
    monthly_salary: 35000,
    employment_start: '2026-09-15',
    tax_table_number: 33,
    tax_column: 1,
  })
  const fia = employee(A, 'emp-fia', {
    first_name: 'Fia',
    personnummer: '198807070000',
    monthly_salary: 20000,
    f_skatt_status: 'f_skatt',
    tax_table_number: null,
  })
  const gustav = employee(A, 'emp-gustav', {
    first_name: 'Gustav',
    personnummer: '195912310000', // 66 at the start of 2026: just under 67
    monthly_salary: 31500,
    tax_table_number: 30,
    tax_column: 1,
    jamkning_percentage: 25,
    jamkning_valid_from: '2026-01-01',
    jamkning_valid_to: '2026-12-31',
  })
  const employees = [anna, bertil, cecilia, david, erik, fia, gustav]
  const sre = (emp: Row, overrides: Row = {}) => rosterRow(A, RUN_A, emp, overrides)
  const sreId = (emp: Row) => `sre-${RUN_A}-${emp.id as string}`

  const priorRunId = 'run-a-2026-08'
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [{ company_id: A, salary_net_rounding: true, salary_calculation_policy: {} }],
    salary_runs: [
      draftRun(A, RUN_A, { period_year: 2026, period_month: 9, payment_date: '2026-09-25' }),
      draftRun(A, priorRunId, { status: 'booked', period_year: 2026, period_month: 8, payment_date: '2026-08-25' }),
    ],
    employees,
    salary_run_employees: [
      sre(anna),
      sre(bertil, { monthly_salary: 38000 }),
      sre(cecilia),
      sre(david),
      sre(erik),
      sre(fia),
      sre(gustav, { tax_withheld_override: 9000, override_reason: 'Jämkningsbeslut, rättat i granskning' }),
      // The August run, counted in YTD.
      rosterRow(A, priorRunId, anna, {
        gross_salary: 42000,
        tax_withheld: 10512,
        net_salary: 31488,
        calculation_breakdown: { steps: [] },
      }),
      rosterRow(A, priorRunId, gustav, {
        gross_salary: 31500,
        tax_withheld: 7875,
        tax_withheld_override: 8000,
        override_reason: 'Rättat',
        net_salary: 23625,
        calculation_breakdown: { steps: [] },
      }),
    ],
    salary_line_items: [
      line(A, sreId(anna), 'li-anna-base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 42000 }),
      line(A, sreId(anna), 'li-anna-bonus', {
        item_type: 'bonus',
        description: 'Bonus Q3',
        amount: 5000,
        sort_order: 10,
        one_off_tax_percent: 34,
      }),
      line(A, sreId(anna), 'li-anna-vacation', {
        item_type: 'vacation',
        description: 'Semester 2 dagar',
        quantity: 2,
        amount: 336,
        is_vacation_basis: false,
        sort_order: 20,
      }),
      // Rows a previous calculation derived: each is replaced.
      line(A, sreId(anna), 'li-anna-old-karens', {
        item_type: 'sick_karens',
        description: 'Karensavdrag',
        amount: -1234.56,
        is_gross_deduction: true,
        sort_order: 100,
      }),
      line(A, sreId(anna), 'li-anna-old-car', {
        item_type: 'benefit_car',
        description: 'Bilförmån (gammal)',
        amount: 3900,
        is_vacation_basis: false,
        sort_order: 200,
        source_benefit_id: 'ben-anna-car',
      }),
      line(A, sreId(anna), 'li-anna-old-union', {
        item_type: 'net_deduction_union',
        description: 'Fackavgift (gammal)',
        amount: -400,
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_net_deduction: true,
        sort_order: 250,
        source_recurring_line_id: 'rec-anna-union',
      }),
      line(A, sreId(anna), 'li-anna-old-rounding', {
        item_type: 'oresavrundning',
        description: 'Öresavrundning',
        amount: 0.4,
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        sort_order: 900,
      }),
      line(A, sreId(bertil), 'li-bertil-base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 30400 }),
      line(A, sreId(cecilia), 'li-cecilia-base', { item_type: 'hourly_salary', description: 'Timlön', amount: 0 }),
      line(A, sreId(cecilia), 'li-cecilia-old-sem', {
        item_type: 'semesterersattning',
        description: 'Semesterersättning',
        amount: 999,
        is_vacation_basis: false,
        sort_order: 50,
        calculation_source: 'vacation_compensation',
      }),
      line(A, sreId(cecilia), 'li-cecilia-old-ob', {
        item_type: 'ob_weekend',
        description: 'OB helg (gammal)',
        amount: 120,
        sort_order: 300,
      }),
      line(A, sreId(david), 'li-david-base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 14000 }),
      line(A, sreId(david), 'li-david-advance', {
        item_type: 'net_deduction_advance',
        description: 'Löneförskott',
        amount: -2000,
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_net_deduction: true,
        sort_order: 30,
      }),
      line(A, sreId(erik), 'li-erik-base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 35000 }),
      line(A, sreId(erik), 'li-erik-trakt', {
        item_type: 'traktamente_taxfree',
        description: 'Traktamente Göteborg',
        quantity: 1,
        amount: 290,
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        sort_order: 30,
      }),
      line(A, sreId(fia), 'li-fia-base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 20000 }),
      line(A, sreId(gustav), 'li-gustav-base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 31500 }),
      // A semesterersättning the operator entered: it survives and is priced.
      line(A, sreId(gustav), 'li-gustav-manual-sem', {
        item_type: 'semesterersattning',
        description: 'Semesterersättning sparade dagar',
        amount: 2500,
        is_vacation_basis: false,
        sort_order: 60,
      }),
      // Lines of the August run: untouched.
      line(A, `sre-${priorRunId}-emp-anna`, 'li-prior-anna-base', {
        item_type: 'monthly_salary',
        description: 'Grundlön',
        amount: 42000,
      }),
    ],
    employee_opening_balances: [
      {
        id: 'ob-bertil',
        company_id: A,
        employee_id: 'emp-bertil',
        cutover_date: '2026-03-01',
        ytd_gross: 60800,
        ytd_tax: 7400,
        ytd_net: 53400,
        karens_periods_adjustment: 2,
      },
    ],
    salary_absence_days: [
      // Anna: sick 27-28 Aug, sick again 1 Sep (återinsjuknande), a new
      // period on 21 Sep ending with a half day; two spring periods for the
      // högriskskydd count.
      ...absence(A, 'emp-anna', [
        ['2026-03-10', 'sick'],
        ['2026-03-11', 'sick'],
        ['2026-05-19', 'sick', 4],
        ['2026-08-27', 'sick'],
        ['2026-08-28', 'sick'],
        ['2026-09-01', 'sick'],
        ['2026-09-02', 'sick'],
        ['2026-09-21', 'sick'],
        ['2026-09-22', 'sick', 4],
      ]),
      // Bertil (four-day week, 8 h days): VAB this month on top of three
      // earlier VAB dates, one sick day.
      ...absence(A, 'emp-bertil', [
        ['2026-02-10', 'vab'],
        ['2026-02-11', 'vab'],
        ['2026-02-12', 'vab'],
        ['2026-09-15', 'vab'],
        ['2026-09-16', 'vab', 4],
        ['2026-09-29', 'sick'],
      ]),
      // David (4 h days): two days of unpaid leave.
      ...absence(A, 'emp-david', [
        ['2026-09-14', 'unpaid_leave', 4],
        ['2026-09-15', 'unpaid_leave', 4],
      ]),
      // Erik: parental leave the last two days of the month, a prior-year
      // parental date outside every window.
      ...absence(A, 'emp-erik', [
        ['2025-12-18', 'parental'],
        ['2026-09-24', 'parental'],
        ['2026-09-25', 'parental'],
      ]),
      // Someone else's absence in the same company: never read for the roster.
      ...absence(A, 'emp-not-on-run', [['2026-09-10', 'sick']]),
    ],
    salary_worked_days: [
      ...worked(A, 'emp-cecilia', [
        ['2026-09-01', 8, '08:00:00', '16:30:00'],
        ['2026-09-02', 8, '14:00:00', '22:00:00'],
        ['2026-09-05', 6, '10:00:00', '16:00:00'],
        ['2026-09-08', 8, null, null],
        ['2026-09-09', 7.5, null, null],
        ['2026-09-11', 8, '22:00:00', '06:00:00'],
        ['2026-10-01', 8, '08:00:00', '16:00:00'], // next month: outside the window
      ]),
      // Gustav (monthly) works a Sunday: OB on his derived hourly rate.
      ...worked(A, 'emp-gustav', [['2026-09-06', 4, '10:00:00', '14:00:00']]),
    ],
    shift_premium_rules: [
      {
        id: 'rule-evening',
        company_id: A,
        name: 'OB kväll',
        applies_to_all_employees: true,
        applies_to_employee_ids: [],
        day_of_week: [1, 2, 3, 4, 5],
        start_time: '18:00:00',
        end_time: '22:00:00',
        premium_percent: 30,
        item_type: 'ob_weekday_evening',
        priority: 1,
        is_active: true,
      },
      {
        id: 'rule-weekend',
        company_id: A,
        name: 'OB helg',
        applies_to_all_employees: true,
        applies_to_employee_ids: [],
        day_of_week: [6, 7],
        start_time: '00:00:00',
        end_time: '00:00:00',
        premium_percent: 50,
        item_type: 'ob_weekend',
        priority: 2,
        is_active: true,
      },
      {
        id: 'rule-night',
        company_id: A,
        name: 'OB natt',
        applies_to_all_employees: true,
        applies_to_employee_ids: [],
        day_of_week: [1, 2, 3, 4, 5, 6, 7],
        start_time: '22:00:00',
        end_time: '06:00:00',
        premium_percent: 40,
        item_type: 'ob_night',
        priority: 3,
        is_active: true,
      },
      {
        id: 'rule-archived',
        company_id: A,
        name: 'Gammal OB',
        applies_to_all_employees: true,
        applies_to_employee_ids: [],
        day_of_week: [1, 2, 3, 4, 5],
        start_time: '06:00:00',
        end_time: '18:00:00',
        premium_percent: 100,
        item_type: 'ob_weekday_evening',
        priority: 9,
        is_active: false,
      },
    ],
    employee_benefits: [
      {
        id: 'ben-anna-car',
        company_id: A,
        employee_id: 'emp-anna',
        benefit_type: 'car',
        description: 'Bilförmån Volvo XC40',
        monthly_value: 4210,
        is_active: true,
        valid_from: '2026-01-01',
        valid_to: null,
        created_at: '2026-01-02T08:00:00Z',
      },
      {
        id: 'ben-anna-old-phone',
        company_id: A,
        employee_id: 'emp-anna',
        benefit_type: 'other',
        description: 'Telefon (avslutad)',
        monthly_value: 150,
        is_active: true,
        valid_from: '2025-01-01',
        valid_to: '2026-06-30',
        created_at: '2025-01-02T08:00:00Z',
      },
      {
        id: 'ben-bertil-lunch',
        company_id: A,
        employee_id: 'emp-bertil',
        benefit_type: 'meals',
        description: 'Kostförmån lunch',
        monthly_value: 1240,
        is_active: true,
        valid_from: '2026-01-01',
        valid_to: null,
        created_at: '2026-01-02T08:00:00Z',
      },
      {
        id: 'ben-bertil-housing-inactive',
        company_id: A,
        employee_id: 'emp-bertil',
        benefit_type: 'housing',
        description: 'Bostadsförmån (inaktiv)',
        monthly_value: 3000,
        is_active: false,
        valid_from: '2026-01-01',
        valid_to: null,
        created_at: '2026-01-03T08:00:00Z',
      },
      {
        id: 'ben-gustav-wellness',
        company_id: A,
        employee_id: 'emp-gustav',
        benefit_type: 'wellness',
        description: 'Massage',
        monthly_value: 450,
        is_active: true,
        valid_from: '2026-09-01',
        valid_to: '2026-12-31',
        created_at: '2026-08-20T08:00:00Z',
      },
      {
        id: 'ben-gustav-bike',
        company_id: A,
        employee_id: 'emp-gustav',
        benefit_type: 'bike',
        description: 'Förmånscykel',
        monthly_value: 0,
        is_active: true,
        valid_from: '2026-01-01',
        valid_to: null,
        created_at: '2026-08-21T08:00:00Z',
      },
    ],
    employee_recurring_lines: [
      {
        id: 'rec-anna-union',
        company_id: A,
        employee_id: 'emp-anna',
        item_type: 'net_deduction_union',
        description: 'Fackavgift Unionen',
        amount: -450,
        account_number: null,
        is_active: true,
        valid_from: '2026-01-01',
        valid_to: null,
        created_at: '2026-01-02T08:00:00Z',
      },
      {
        id: 'rec-anna-car-payment',
        company_id: A,
        employee_id: 'emp-anna',
        item_type: 'net_deduction_benefit_payment',
        description: 'Egen betalning bilförmån',
        amount: -500,
        account_number: null,
        is_active: true,
        valid_from: '2026-01-01',
        valid_to: null,
        created_at: '2026-01-03T08:00:00Z',
      },
      {
        id: 'rec-bertil-lonevaxling',
        company_id: A,
        employee_id: 'emp-bertil',
        item_type: 'gross_deduction_pension',
        description: 'Löneväxling tjänstepension',
        amount: -3000,
        account_number: '7412',
        is_active: true,
        valid_from: '2026-04-01',
        valid_to: null,
        created_at: '2026-03-20T08:00:00Z',
      },
      {
        id: 'rec-erik-future',
        company_id: A,
        employee_id: 'emp-erik',
        item_type: 'net_deduction_other',
        description: 'Personalfest (från oktober)',
        amount: -300,
        account_number: null,
        is_active: true,
        valid_from: '2026-10-01',
        valid_to: null,
        created_at: '2026-09-20T08:00:00Z',
      },
      {
        id: 'rec-gustav-ended',
        company_id: A,
        employee_id: 'emp-gustav',
        item_type: 'net_deduction_other',
        description: 'Avbetalning (slut)',
        amount: -1000,
        account_number: null,
        is_active: true,
        valid_from: '2026-01-01',
        valid_to: '2026-08-31',
        created_at: '2026-01-02T08:00:00Z',
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Scenario B: an October run paid on September's deviations, with the
// calendar-day, annual-hourly and partial-month conventions, nearest
// rounding, a stale pay-type snapshot and an hourly employee without
// registered hours
// ---------------------------------------------------------------------------

const B = 'company-b'
const RUN_B = 'run-b-2026-10'

function scenarioB(): Record<string, Row[]> {
  const hanna = employee(B, 'emp-hanna', {
    first_name: 'Hanna',
    personnummer: '199002020000',
    monthly_salary: 45000,
    tax_table_number: 31,
    tax_column: 1,
  })
  const ivar = employee(B, 'emp-ivar', {
    first_name: 'Ivar',
    personnummer: '198612120000',
    monthly_salary: 33000,
    tax_table_number: 31,
    tax_column: 1,
  })
  const jonas = employee(B, 'emp-jonas', {
    first_name: 'Jonas',
    personnummer: '199906060000',
    salary_type: 'hourly',
    monthly_salary: null,
    hourly_rate: 210,
    tax_table_number: 31,
    tax_column: 1,
  })
  const karin = employee(B, 'emp-karin', {
    first_name: 'Karin',
    personnummer: '198303030000',
    monthly_salary: 39000,
    employment_end: '2026-10-15',
    tax_table_number: 31,
    tax_column: 1,
  })
  const sreId = (emp: Row) => `sre-${RUN_B}-${emp.id as string}`
  const septemberWorkdays = (from: number, to: number) => {
    const dates: string[] = []
    for (let day = from; day <= to; day++) {
      const date = `2026-09-${String(day).padStart(2, '0')}`
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
      if (weekday !== 0 && weekday !== 6) dates.push(date)
    }
    return dates
  }
  const priorRunId = 'run-b-2026-09'
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [
      {
        company_id: B,
        salary_net_rounding: true,
        salary_calculation_policy: {
          sick_rate: 'annual_hourly',
          long_leave: 'calendar_after_five_workdays',
          partial_month: 'annual_calendar_days',
          net_rounding: 'nearest',
        },
      },
    ],
    salary_runs: [
      draftRun(B, RUN_B, {
        period_year: 2026,
        period_month: 10,
        payment_date: '2026-10-23',
        deviation_period_start: '2026-09-01',
        deviation_period_end: '2026-09-30',
      }),
      draftRun(B, priorRunId, { status: 'paid', period_year: 2026, period_month: 9, payment_date: '2026-09-25' }),
    ],
    employees: [hanna, ivar, jonas, karin],
    salary_run_employees: [
      rosterRow(B, RUN_B, hanna),
      // Ivar moved from hourly to monthly pay after he joined the run.
      rosterRow(B, RUN_B, ivar, { salary_type: 'hourly', monthly_salary: 33000 }),
      rosterRow(B, RUN_B, jonas, { hours_worked: 120 }),
      rosterRow(B, RUN_B, karin),
      rosterRow(B, priorRunId, hanna, {
        gross_salary: 45000,
        tax_withheld: 12000,
        net_salary: 33000,
        calculation_breakdown: { steps: [] },
      }),
    ],
    salary_line_items: [
      line(B, sreId(hanna), 'li-hanna-base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 45000 }),
      line(B, sreId(ivar), 'li-ivar-old-base', { item_type: 'hourly_salary', description: 'Timlön', amount: 0 }),
      line(B, sreId(jonas), 'li-jonas-base', {
        item_type: 'hourly_salary',
        description: 'Timlön',
        quantity: 120,
        unit_price: 210,
        amount: 25200,
      }),
      line(B, sreId(karin), 'li-karin-base', { item_type: 'monthly_salary', description: 'Grundlön', amount: 39000 }),
    ],
    employee_opening_balances: [],
    salary_absence_days: [
      // Hanna: two weeks of parental leave with registered days either side
      // of the window (they decide the episode length, never deducted), and
      // a VAB half day.
      ...absence(B, 'emp-hanna', [
        ['2026-08-31', 'parental'],
        ...septemberWorkdays(7, 18).map((date): [string, string] => [date, 'parental']),
        ['2026-09-24', 'vab', 4],
        ['2026-10-01', 'parental'],
        ['2026-10-02', 'parental'],
      ]),
      // Karin: sick from 7 September to the end of the month, past day 14.
      ...absence(B, 'emp-karin', septemberWorkdays(7, 30).map((date): [string, string] => [date, 'sick'])),
    ],
    salary_worked_days: [
      // Registered in October, outside the deviation window.
      ...worked(B, 'emp-jonas', [['2026-10-05', 8, null, null]]),
    ],
    shift_premium_rules: [],
    employee_benefits: [],
    employee_recurring_lines: [],
  }
}

// ---------------------------------------------------------------------------
// Scenario C: a benefit payment the payslip cannot attribute is refused
// ---------------------------------------------------------------------------

const C = 'company-c'
const RUN_C = 'run-c-2026-09'

function scenarioC(): Record<string, Row[]> {
  const lars = employee(C, 'emp-lars', { first_name: 'Lars', monthly_salary: 36000 })
  const maja = employee(C, 'emp-maja', { first_name: 'Maja', monthly_salary: 41000 })
  const benefit = (id: string, type: string, value: number): Row => ({
    id,
    company_id: C,
    employee_id: 'emp-maja',
    benefit_type: type,
    description: id,
    monthly_value: value,
    is_active: true,
    valid_from: '2026-01-01',
    valid_to: null,
    created_at: '2026-01-02T08:00:00Z',
  })
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [],
    salary_runs: [draftRun(C, RUN_C, { period_year: 2026, period_month: 9, payment_date: '2026-09-25' })],
    employees: [lars, maja],
    salary_run_employees: [rosterRow(C, RUN_C, lars), rosterRow(C, RUN_C, maja)],
    salary_line_items: [],
    employee_benefits: [benefit('ben-maja-car', 'car', 3500), benefit('ben-maja-housing', 'housing', 2500)],
    employee_recurring_lines: [
      {
        id: 'rec-maja-payment',
        company_id: C,
        employee_id: 'emp-maja',
        item_type: 'net_deduction_benefit_payment',
        description: 'Egen betalning förmån',
        amount: -800,
        account_number: null,
        is_active: true,
        valid_from: '2026-01-01',
        valid_to: null,
        created_at: '2026-01-02T08:00:00Z',
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Scenario D: an empty roster (nolldeklaration month)
// ---------------------------------------------------------------------------

const D = 'company-d'
const RUN_D = 'run-d-2026-09'

function scenarioD(): Record<string, Row[]> {
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [{ company_id: D, salary_net_rounding: false, salary_calculation_policy: {} }],
    salary_runs: [draftRun(D, RUN_D, { period_year: 2026, period_month: 9, payment_date: '2026-09-25' })],
    employees: [],
    salary_run_employees: [],
  }
}

// ---------------------------------------------------------------------------
// Snapshot rendering
// ---------------------------------------------------------------------------

/** JSON with sorted keys; a NULL column and an absent one read the same. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.keys(v as Row)
          .filter((k) => (v as Row)[k] !== null && (v as Row)[k] !== undefined)
          .sort()
          .map((k) => [k, (v as Row)[k]]),
      )
    }
    return v
  })
}

function byId(a: Row, b: Row) {
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
}

/** Payslip lines in payslip order; ids the database generated are masked. */
function payslipLines(rows: Row[]): string[] {
  return rows
    .map((row): Row => ({ ...row, id: String(row.id).includes('-new-') ? '<generated>' : row.id }))
    .map((row) => ({ row, text: canonical(row) }))
    .sort((a, b) => {
      const keys = ['salary_run_employee_id', 'sort_order', 'item_type', 'description']
      for (const key of keys) {
        const av = a.row[key] as string | number
        const bv = b.row[key] as string | number
        if (av !== bv) return av < bv ? -1 : 1
      }
      return a.text < b.text ? -1 : a.text > b.text ? 1 : 0
    })
    .map(({ text }) => text)
}

function render(db: ReturnType<typeof createPayrollFakeDb>, result: RunSalaryCalculationResult): string {
  const out: string[] = []
  out.push('# result')
  out.push(
    result.ok
      ? canonical({ ok: true, warnings: result.warnings, run_id: result.run.id })
      : canonical(result),
  )
  out.push('# engine calls')
  for (const [input, , rates] of vi.mocked(calculateSalary).mock.calls) {
    const { lineItems, ...rest } = input
    out.push(canonical({ ...rest, taxRates: rates.length }))
    for (const item of lineItems) out.push(`  ${canonical(item)}`)
  }
  out.push('# salary_runs')
  for (const run of db.rows('salary_runs').sort(byId)) out.push(canonical(run))
  out.push('# salary_run_employees')
  for (const row of db.rows('salary_run_employees').sort(byId)) {
    const { calculation_breakdown: breakdown, ...rest } = row
    out.push(canonical(rest))
    for (const step of ((breakdown as { steps?: unknown[] } | null)?.steps ?? [])) out.push(`  ${canonical(step)}`)
  }
  out.push('# salary_line_items')
  out.push(...payslipLines(db.rows('salary_line_items')))
  return out.join('\n')
}

async function calculate(seed: Record<string, Row[]>, companyId: string, runId: string) {
  const db = createPayrollFakeDb(seed)
  const result = await runSalaryCalculation({
    supabase: db.supabase,
    companyId,
    salaryRunId: runId,
    log: createLogger('test/run-calculation-golden'),
    requestId: 'req_golden',
  })
  return { db, result }
}

describe('runSalaryCalculation golden payroll fixture', () => {
  beforeEach(() => {
    vi.mocked(calculateSalary).mockClear()
    clearTaxTableCache()
    vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('A: a September run with absence, benefits, recurring lines, OB and öresavrundning', async () => {
    const { db, result } = await calculate(scenarioA(), A, RUN_A)
    expect(result.ok).toBe(true)
    expect(render(db, result)).toMatchSnapshot()
  })

  it('B: an October run on September deviations under the calendar and annual-hourly conventions', async () => {
    const { db, result } = await calculate(scenarioB(), B, RUN_B)
    expect(result.ok).toBe(true)
    expect(render(db, result)).toMatchSnapshot()
  })

  it('C: a benefit payment that cannot be attributed refuses the run by name', async () => {
    const { result } = await calculate(scenarioC(), C, RUN_C)
    // Only the answer is pinned: what a refused calculation leaves stored is
    // not part of its contract (the run stays a draft either way).
    expect(result).toMatchSnapshot()
  })

  it('D: an empty roster freezes all-zero totals and the calculation params', async () => {
    const { db, result } = await calculate(scenarioD(), D, RUN_D)
    expect(result.ok).toBe(true)
    expect(render(db, result)).toMatchSnapshot()
  })
})
