/**
 * Sandbox payroll seed: the Löner story the demo user lands on.
 *
 *   /salary            → two lönekörningar (one Bokförd, one Utkast)
 *   /salary/employees  → two anställda (one månadslön, one timlön)
 *   /salary/runs/{id}  → per-employee calculation rows + payslip line items
 *
 * Everything here is a PURE ROW BUILDER, same contract as ./customers.ts and
 * ./pending-operations.ts: no Supabase, no `new Date()` inside, dates, ids,
 * the year's payroll config and the tax table arrive as arguments. route.ts
 * owns the reads and the inserts.
 *
 * The figures are the salary engine's own (calculateSandboxPayroll calls
 * calculateSalary with the employee rows this module builds), so the booked
 * run, its verifikat and the draft run's "Beräkna om" agree to the öre.
 *
 * Insert order (foreign keys):
 *   1. employees                → buildSandboxEmployees
 *   2. salary_runs              → buildSandboxSalaryRuns (needs the payroll)
 *   3. salary_run_employees     → buildSandboxSalaryRunEmployees (needs 1 + 2)
 *   4. salary_line_items        → buildSandboxSalaryLineItems (needs 3)
 *
 * Two seeding hazards this module is written around:
 *
 *   PostgREST bulk-insert normalization. Every row in one `.insert([...])`
 *   array must carry the SAME key set: a key present on one row and absent on
 *   another is sent as null for the missing row, which either violates NOT NULL
 *   or overwrites a schema default. So the builders below spell out nulls
 *   explicitly instead of omitting keys.
 *
 *   The January edge. The sandbox has exactly one fiscal period, the current
 *   calendar year. In January the "previous month" falls in the previous year,
 *   which has no period, so resolveSandboxSalaryPeriods keeps both runs inside
 *   the current year (January booked, February draft) instead.
 */

import { roundOre } from '@/lib/money'
import { lastDayOfMonth, pad2 } from './date-utils'
import { lineItemAccount } from '@/lib/salary/account-mapping'
import { calculateSalary, type SalaryCalculationResult } from '@/lib/salary/calculation-engine'
import { serializePayrollConfig, type PayrollConfig } from '@/lib/salary/payroll-config'
import type { TaxTableRate } from '@/lib/salary/tax-tables'
import type { SalaryLineItemType } from '@/types'

/**
 * Skatteverket tax table + column both demo employees are registered on.
 * Column 1 is ordinary employment income for someone below 66 (SKV 434).
 * route.ts loads exactly this table and column for the booked year.
 */
export const SANDBOX_TAX_TABLE_NUMBER = 34
export const SANDBOX_TAX_COLUMN = 1
const TAX_TABLE_NUMBER = SANDBOX_TAX_TABLE_NUMBER
const TAX_COLUMN = SANDBOX_TAX_COLUMN

// ============================================================
// Employee facts
// ============================================================

/**
 * Fabricated identity numbers. Both are SAMORDNINGSNUMMER (the day field
 * carries the +60 offset Skatteverket uses for people without a personnummer),
 * which makes them unmistakably not a real person's personnummer while still
 * passing every gate the app applies: validatePersonnummer (format + Luhn over
 * the printed digits) and the AGI generator's IDENTITET_PATTERN both accept the
 * offset form. An invalid-Luhn number would write fine but would be rejected
 * the moment the demo user opened the employee and saved.
 *
 *   198805741231 → born 1988-05-14 (74 = 14 + 60)
 *   199611624561 → born 1996-11-02 (62 =  2 + 60)
 */
const ANNA_PERSONNUMMER = '198805741231'
const ERIK_PERSONNUMMER = '199611624561'

/** Months before `today` each employment started. */
const ANNA_EMPLOYMENT_MONTHS_AGO = 24
const ERIK_EMPLOYMENT_MONTHS_AGO = 8

const ANNA_MONTHLY_SALARY = 38000
const ERIK_HOURLY_RATE = 245
const ERIK_HOURS_WORKED = 80

/**
 * Last names are the seed's stable handle on the two employees: the ciphertext
 * in `personnummer` differs on every encrypt (random IV), so it cannot be used
 * to match inserted rows back to the builder's intent.
 */
export const SANDBOX_EMPLOYEE_LAST_NAMES = {
  anna: 'Lindqvist',
  erik: 'Sandström',
} as const

// ============================================================
// Date helpers (pure: every one takes its reference date as an argument)
// ============================================================

/** Local-calendar YYYY-MM-DD, same convention as route.ts's toDateStr. */
function toDateString(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/**
 * Shift a date by whole calendar months, clamping the day to the target
 * month's length so 31 March minus 1 month is 28/29 February, never 3 March.
 */
function shiftMonths(from: Date, months: number): string {
  const total = from.getFullYear() * 12 + from.getMonth() + months
  const year = Math.floor(total / 12)
  const month = (total % 12) + 1
  const day = Math.min(from.getDate(), lastDayOfMonth(year, month))
  return toDateString(year, month, day)
}

/** Earlier of two YYYY-MM-DD strings (ISO dates compare lexicographically). */
function earlierDate(a: string, b: string): string {
  return a <= b ? a : b
}

// ============================================================
// Periods
// ============================================================

export interface SandboxSalaryPeriod {
  year: number
  /** 1-12. */
  month: number
  /** The 25th, the ordinary Swedish payday. */
  paymentDate: string
}

export interface SandboxSalaryPeriods {
  /** Status 'booked': last month's payroll, paid and posted. */
  booked: SandboxSalaryPeriod
  /** Status 'draft': this month's payroll, still open. */
  draft: SandboxSalaryPeriod
}

/**
 * Resolve the two demo periods.
 *
 * Normal case: the booked run is last month, the draft run is this month.
 *
 * January: "last month" would be December of the PREVIOUS calendar year, and
 * the sandbox seeds exactly one fiscal period ({currentYear}-01-01 ..
 * {currentYear}-12-31). A run in an unseeded year has no period to book
 * against, and the demo would show a payroll history that predates the
 * company's books. So in January both runs stay inside the current year:
 * January booked, February draft.
 */
export function resolveSandboxSalaryPeriods(today: Date): SandboxSalaryPeriods {
  const year = today.getFullYear()
  const month = today.getMonth() + 1

  const [bookedMonth, draftMonth] = month === 1 ? [1, 2] : [month - 1, month]

  return {
    booked: { year, month: bookedMonth, paymentDate: toDateString(year, bookedMonth, 25) },
    draft: { year, month: draftMonth, paymentDate: toDateString(year, draftMonth, 25) },
  }
}


// ============================================================
// 1. employees
// ============================================================

export interface SandboxEmployeesInput {
  userId: string
  companyId: string
  /** Reference date; employment start dates are derived from it. */
  today: Date
  /**
   * `encryptPersonnummer` from lib/salary/personnummer, injected so this
   * builder stays pure and unit-testable. employees.personnummer stores the
   * AES-256-GCM ciphertext; personnummer_last4 stores the plain last four.
   */
  encrypt: (personnummer: string) => string
}

/**
 * The demo roster: one månadsavlönad tjänsteman and one timavlönad
 * deltidsanställd, which between them exercise both salary_type branches in
 * the calculation engine and both payslip line-item shapes.
 */
export function buildSandboxEmployees({
  userId,
  companyId,
  today,
  encrypt,
}: SandboxEmployeesInput) {
  const base = {
    user_id: userId,
    company_id: companyId,
    // Both are ordinary employees (7210), not företagsledare (7220) or
    // styrelseledamot (7240): lineItemAccount keys off this.
    employment_type: 'employee',
    tax_table_number: TAX_TABLE_NUMBER,
    tax_column: TAX_COLUMN,
    tax_municipality: 'Stockholm',
    is_sidoinkomst: false,
    f_skatt_status: 'a_skatt',
    vacation_rule: 'procentregeln',
    vacation_days_per_year: 25,
    is_active: true,
  }

  return [
    {
      ...base,
      first_name: 'Anna',
      last_name: SANDBOX_EMPLOYEE_LAST_NAMES.anna,
      personnummer: encrypt(ANNA_PERSONNUMMER),
      personnummer_last4: ANNA_PERSONNUMMER.slice(-4),
      employment_start: shiftMonths(today, -ANNA_EMPLOYMENT_MONTHS_AGO),
      employment_degree: 100,
      salary_type: 'monthly',
      monthly_salary: ANNA_MONTHLY_SALARY,
      hourly_rate: null,
      // Deliberately null, not a demo@example.com address. The payslip-send
      // action is reachable on the seeded BOOKED run, and example.com has no
      // MX: a visitor pressing it would hard-bounce mail off the production
      // sending domain. Both approve routes treat a missing address as a
      // warning, and the send route records "saknar e-postadress" instead of
      // calling the mail provider. (The route also now refuses sandbox
      // companies outright; this is the second lock on the same door.)
      email: null,
      // Swedbank: the only 5-digit clearings in the Swedish system start with
      // 8. Stored as plain digits because every consumer (payment files,
      // payslip PDF) normalizes away spaces and hyphens anyway.
      clearing_number: '83271',
      bank_account_number: '1234567',
      specification_number: 1,
    },
    {
      ...base,
      first_name: 'Erik',
      last_name: SANDBOX_EMPLOYEE_LAST_NAMES.erik,
      personnummer: encrypt(ERIK_PERSONNUMMER),
      personnummer_last4: ERIK_PERSONNUMMER.slice(-4),
      employment_start: shiftMonths(today, -ERIK_EMPLOYMENT_MONTHS_AGO),
      employment_degree: 50,
      salary_type: 'hourly',
      monthly_salary: null,
      hourly_rate: ERIK_HOURLY_RATE,
      email: null,
      // SEB (clearing 5000-5999), 4 digits.
      clearing_number: '5000',
      bank_account_number: '7654321',
      specification_number: 2,
    },
  ]
}

export interface SandboxEmployeeIds {
  annaEmployeeId: string
  erikEmployeeId: string
}

/**
 * Map the inserted employee rows back to the two demo employees.
 * Insert with `.select('id, last_name')` and pass the result straight in.
 */
export function mapSandboxEmployeeIds(
  rows: Array<{ id: string; last_name: string }>,
): SandboxEmployeeIds {
  const byLastName = new Map(rows.map((r) => [r.last_name, r.id]))
  const annaEmployeeId = byLastName.get(SANDBOX_EMPLOYEE_LAST_NAMES.anna)
  const erikEmployeeId = byLastName.get(SANDBOX_EMPLOYEE_LAST_NAMES.erik)
  if (!annaEmployeeId || !erikEmployeeId) {
    throw new Error('Sandbox seed: could not resolve both employee ids from the inserted rows')
  }
  return { annaEmployeeId, erikEmployeeId }
}

// ============================================================
// Figures: the salary engine, once per employee
// ============================================================

export type SandboxEmployeeRow = ReturnType<typeof buildSandboxEmployees>[number]

export interface SandboxPayrollInput {
  /** The rows buildSandboxEmployees returned, personnummer encrypted. */
  employees: readonly SandboxEmployeeRow[]
  today: Date
  /** The booked year's salary_payroll_config row (loadPayrollConfig). */
  config: PayrollConfig
  /** Table 34, column 1 for the booked year (fetchTaxTableRates). */
  taxRates: TaxTableRate[]
}

/** The two demo employees' calculation results, plus the config they used. */
export interface SandboxPayroll {
  anna: SalaryCalculationResult
  erik: SalaryCalculationResult
  config: PayrollConfig
}

function engineFor(
  employee: SandboxEmployeeRow,
  period: SandboxSalaryPeriod,
  config: PayrollConfig,
  taxRates: TaxTableRate[],
): SalaryCalculationResult {
  const periodStart = toDateString(period.year, period.month, 1)
  const periodEnd = toDateString(period.year, period.month, lastDayOfMonth(period.year, period.month))
  const hourly = employee.salary_type === 'hourly'
  // The input runSalaryCalculation builds from an employee and its run row:
  // an hourly employee's monthly_salary snapshot is 0, and the base salary
  // line item is not passed, since the engine derives the base itself.
  return calculateSalary(
    {
      employmentType: 'employee',
      salaryType: hourly ? 'hourly' : 'monthly',
      monthlySalary: employee.monthly_salary ?? 0,
      hourlyRate: employee.hourly_rate ?? undefined,
      hoursWorked: hourly ? ERIK_HOURS_WORKED : undefined,
      employmentDegree: employee.employment_degree,
      taxTableNumber: employee.tax_table_number,
      taxColumn: employee.tax_column,
      isSidoinkomst: employee.is_sidoinkomst,
      jamkningPercentage: null,
      jamkningValidFrom: null,
      jamkningValidTo: null,
      fSkattStatus: employee.f_skatt_status,
      personnummer: employee.personnummer,
      paymentDate: period.paymentDate,
      vacationRule: 'procentregeln',
      vacationDaysPerYear: employee.vacation_days_per_year,
      // Read only under sammalöneregeln; both demo employees are on procentregeln.
      semestertillaggRate: 0,
      vacationPayRate: null,
      vaxaStodEligible: false,
      vaxaStodStart: null,
      vaxaStodEnd: null,
      lineItems: [],
      periodStart,
      periodEnd,
      employmentStart: employee.employment_start,
      employmentEnd: null,
    },
    config,
    taxRates.map((rate) => ({ ...rate })),
  )
}

/**
 * Run the salary engine for both demo employees on the booked period. The
 * draft run pays the same amounts a month later; the engine would answer the
 * same figures for it (same age band, same table, no proration), so one
 * calculation serves both runs, and "Beräkna om" on the draft reproduces it.
 */
export function calculateSandboxPayroll({
  employees,
  today,
  config,
  taxRates,
}: SandboxPayrollInput): SandboxPayroll {
  const { booked } = resolveSandboxSalaryPeriods(today)
  const byLastName = (lastName: string) => {
    const employee = employees.find((e) => e.last_name === lastName)
    if (!employee) throw new Error(`Sandbox seed: no employee ${lastName} to calculate`)
    return employee
  }
  return {
    anna: engineFor(byLastName(SANDBOX_EMPLOYEE_LAST_NAMES.anna), booked, config, taxRates),
    erik: engineFor(byLastName(SANDBOX_EMPLOYEE_LAST_NAMES.erik), booked, config, taxRates),
    config,
  }
}

/**
 * Run-level totals, summed from the same results the per-employee rows are
 * written from, so salary_runs.total_* can never drift from
 * sum(salary_run_employees).
 */
export function sandboxRunTotals(payroll: SandboxPayroll) {
  const { anna, erik } = payroll
  return {
    total_gross: roundOre(anna.grossSalary + erik.grossSalary),
    total_tax: roundOre(anna.taxWithheld + erik.taxWithheld),
    total_net: roundOre(anna.netSalary + erik.netSalary),
    total_avgifter: roundOre(anna.avgifterAmount + erik.avgifterAmount),
    total_vacation_accrual: roundOre(anna.vacationAccrual + erik.vacationAccrual),
    total_employer_cost: roundOre(anna.totalEmployerCost + erik.totalEmployerCost),
  }
}

/**
 * Sum of vacation_accrual_avgifter across the run. Deliberately NOT part of
 * sandboxRunTotals: salary_runs has no column for it, and everything in that
 * object is spread straight onto the run row. The semester voucher of the
 * booked run needs the figure though (7519 / 2940).
 */
export function sandboxVacationAccrualAvgifterTotal(payroll: SandboxPayroll): number {
  return roundOre(payroll.anna.vacationAccrualAvgifter + payroll.erik.vacationAccrualAvgifter)
}

// ============================================================
// 2. salary_runs
// ============================================================

export interface SandboxSalaryRunsInput {
  userId: string
  companyId: string
  today: Date
  payroll: SandboxPayroll
}

/**
 * Two runs: last month booked and paid, this month still a draft. Both carry
 * the same denormalized totals because the roster and the amounts are the
 * same in both periods.
 *
 * calculation_params is the frozen config a real run stores
 * (serializePayrollConfig), marked as seeded. The column being non-null is
 * also what makes the run detail page treat the run as calculated: KPI cards,
 * Beräkningsdetaljer and the bokförings-preview all hang off it.
 */
export function buildSandboxSalaryRuns({ userId, companyId, today, payroll }: SandboxSalaryRunsInput) {
  const periods = resolveSandboxSalaryPeriods(today)
  const todayDate = toDateString(today.getFullYear(), today.getMonth() + 1, today.getDate())

  // Never stamp a completion timestamp in the future: in the January case the
  // booked run's payday (25 January) can still be ahead of `today`.
  const settledOn = earlierDate(periods.booked.paymentDate, todayDate)
  const settledAt = `${settledOn}T09:00:00.000Z`

  const base = {
    user_id: userId,
    company_id: companyId,
    voucher_series: 'A',
    ...sandboxRunTotals(payroll),
    calculation_params: { ...serializePayrollConfig(payroll.config), demoSeed: true },
  }

  return [
    {
      ...base,
      period_year: periods.booked.year,
      period_month: periods.booked.month,
      payment_date: periods.booked.paymentDate,
      status: 'booked',
      approved_by: userId,
      approved_at: settledAt,
      paid_at: settledAt,
      booked_at: settledAt,
      booked_by: userId,
      notes: 'Demolönekörning: godkänd, utbetald och bokförd.',
    },
    {
      ...base,
      period_year: periods.draft.year,
      period_month: periods.draft.month,
      payment_date: periods.draft.paymentDate,
      status: 'draft',
      // Spelled out rather than omitted: PostgREST normalizes the key set
      // across a bulk insert, so a key present only on the row above would be
      // sent as null here regardless.
      approved_by: null,
      approved_at: null,
      paid_at: null,
      booked_at: null,
      booked_by: null,
      notes: 'Demolönekörning: utkast, klar att granska.',
    },
  ]
}

// ============================================================
// 3. salary_run_employees
// ============================================================

export interface SandboxSalaryRunEmployeesInput {
  companyId: string
  today: Date
  bookedRunId: string
  draftRunId: string
  annaEmployeeId: string
  erikEmployeeId: string
  payroll: SandboxPayroll
}

/**
 * Per-employee calculation results for both runs, in the columns
 * runSalaryCalculation writes, with the engine's own steps as the
 * calculation_breakdown.
 *
 * YTD: the booked run is the earliest payroll in the sandbox, so its YTD is
 * its own month; the draft run's YTD is the booked run plus itself. That is
 * exactly what runSalaryCalculation would compute (it aggregates prior BOOKED
 * runs inside the same period_year and adds the current result), so the demo
 * stays consistent if the user recalculates the draft.
 *
 * Rows come back in the documented order booked/Anna, booked/Erik,
 * draft/Anna, draft/Erik, but nothing downstream depends on it:
 * buildSandboxSalaryLineItems keys off employee_id.
 */
export function buildSandboxSalaryRunEmployees({
  companyId,
  today,
  bookedRunId,
  draftRunId,
  annaEmployeeId,
  erikEmployeeId,
  payroll,
}: SandboxSalaryRunEmployeesInput) {
  const periods = resolveSandboxSalaryPeriods(today)

  const common = {
    company_id: companyId,
    tax_table_number: TAX_TABLE_NUMBER,
    tax_column: TAX_COLUMN,
    // Both runs pay out in the current calendar year (see the January note on
    // resolveSandboxSalaryPeriods), so one year covers both.
    tax_table_year: periods.booked.year,
  }

  const { anna, erik } = payroll

  /** Figure columns shared by both runs for one employee. */
  const results = (r: SalaryCalculationResult) => ({
    gross_salary: r.grossSalary,
    gross_deductions: r.grossDeductions,
    benefit_values: r.benefitValues,
    taxable_income: r.taxableIncome,
    tax_withheld: r.taxWithheld,
    net_deductions: r.netDeductions,
    net_salary: r.netSalary,
    avgifter_rate: r.avgifterRate,
    avgifter_amount: r.avgifterAmount,
    avgifter_basis: r.avgifterBasis,
    avgifter_category: r.avgifterCategory,
    vacation_accrual: r.vacationAccrual,
    vacation_accrual_avgifter: r.vacationAccrualAvgifter,
    calculation_breakdown: { steps: r.steps },
  })

  const annaSnapshot = {
    employee_id: annaEmployeeId,
    employment_degree: 100,
    monthly_salary: ANNA_MONTHLY_SALARY,
    salary_type: 'monthly',
    // Månadsavlönade have no hour count; the column is nullable.
    hours_worked: null,
    ...results(anna),
  }

  const erikSnapshot = {
    employee_id: erikEmployeeId,
    employment_degree: 50,
    // NOT NULL on the table, and 0 is what createSalaryRunWithEmployees writes
    // for an hourly employee: the gross comes from timlön × timmar instead.
    monthly_salary: 0,
    salary_type: 'hourly',
    hours_worked: ERIK_HOURS_WORKED,
    ...results(erik),
  }

  return [
    {
      ...common,
      ...annaSnapshot,
      salary_run_id: bookedRunId,
      ytd_gross: anna.grossSalary,
      ytd_tax: anna.taxWithheld,
      ytd_net: anna.netSalary,
    },
    {
      ...common,
      ...erikSnapshot,
      salary_run_id: bookedRunId,
      ytd_gross: erik.grossSalary,
      ytd_tax: erik.taxWithheld,
      ytd_net: erik.netSalary,
    },
    {
      ...common,
      ...annaSnapshot,
      salary_run_id: draftRunId,
      ytd_gross: roundOre(anna.grossSalary * 2),
      ytd_tax: roundOre(anna.taxWithheld * 2),
      ytd_net: roundOre(anna.netSalary * 2),
    },
    {
      ...common,
      ...erikSnapshot,
      salary_run_id: draftRunId,
      ytd_gross: roundOre(erik.grossSalary * 2),
      ytd_tax: roundOre(erik.taxWithheld * 2),
      ytd_net: roundOre(erik.netSalary * 2),
    },
  ]
}

// ============================================================
// 4. salary_line_items
// ============================================================

export interface SandboxSalaryLineItemsInput {
  companyId: string
  annaEmployeeId: string
  erikEmployeeId: string
  /**
   * The inserted salary_run_employees rows. Insert with
   * `.select('id, employee_id')` and pass the result straight in: the line
   * item's content depends only on which employee the row belongs to, since
   * both runs pay the same amounts.
   */
  runEmployees: Array<{ id: string; employee_id: string }>
  payroll: SandboxPayroll
}

/**
 * One payslip line per calculation row: Grundlön for the månadsavlönad,
 * Timlön (80 tim × 245 kr) for the timavlönad. The seeded runs are booked,
 * so the lines carry the account they were booked on, from lineItemAccount
 * so the seed cannot drift from the salary account map (both resolve to 7210
 * Löner till tjänstemän for a tjänsteman with employment_type 'employee').
 */
export function buildSandboxSalaryLineItems({
  companyId,
  annaEmployeeId,
  erikEmployeeId,
  runEmployees,
  payroll,
}: SandboxSalaryLineItemsInput) {
  return runEmployees.map((sre) => {
    const isAnna = sre.employee_id === annaEmployeeId
    const isErik = sre.employee_id === erikEmployeeId
    if (!isAnna && !isErik) {
      throw new Error(
        `Sandbox seed: salary_run_employee ${sre.id} belongs to an unknown employee`,
      )
    }

    const itemType: SalaryLineItemType = isAnna ? 'monthly_salary' : 'hourly_salary'

    return {
      salary_run_employee_id: sre.id,
      company_id: companyId,
      item_type: itemType,
      description: isAnna ? 'Grundlön' : 'Timlön',
      quantity: isAnna ? 1 : ERIK_HOURS_WORKED,
      unit_price: isAnna ? ANNA_MONTHLY_SALARY : ERIK_HOURLY_RATE,
      amount: isAnna ? payroll.anna.grossSalary : payroll.erik.grossSalary,
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: true,
      is_gross_deduction: false,
      is_net_deduction: false,
      account_number: lineItemAccount(itemType, { employmentType: 'employee' }),
      sort_order: 0,
    }
  })
}
