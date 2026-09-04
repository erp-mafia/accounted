/**
 * Sandbox payroll seed: the Löner story the demo user lands on.
 *
 *   /salary            → two lönekörningar (one Bokförd, one Utkast)
 *   /salary/employees  → two anställda (one månadslön, one timlön)
 *   /salary/runs/{id}  → per-employee calculation rows + payslip line items
 *
 * Everything here is a PURE ROW BUILDER, same contract as ./customers.ts and
 * ./pending-operations.ts: no Supabase, no `new Date()` inside, dates and ids
 * arrive as arguments. route.ts owns the inserts.
 *
 * Insert order (foreign keys):
 *   1. employees                → buildSandboxEmployees
 *   2. salary_runs              → buildSandboxSalaryRuns
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
import { FALLBACK_TAX_TABLES_2026 } from '@/lib/salary/tax-tables-fallback'
import { getLineItemAccount } from '@/lib/salary/account-mapping'
import type { SalaryLineItemType } from '@/types'

// ============================================================
// Statutory + demo rates
// ============================================================

/**
 * Arbetsgivaravgifter 2026, matching salary_payroll_config.avgifter_total
 * seeded by migration 20260414120000. Both employees are in the standard
 * age band (born 1988 and 1996), so no reduction applies.
 */
const AVGIFTER_RATE = 0.3142

/**
 * Procentregeln at 25 semesterdagar: 12 % of the vacation basis (SemL 16 b §).
 * The engine switches to 14.4 % at 30+ days; both demo employees are on 25.
 */
const VACATION_ACCRUAL_RATE = 0.12

/** Skatteverket tax table + column both demo employees are registered on. */
const TAX_TABLE_NUMBER = 34
const TAX_COLUMN = 1

/**
 * Real skatteavdrag, from the Skatteverket 2026 tables the repo already ships
 * (SKV 434, generated into lib/salary/tax-tables-fallback.ts).
 *
 * A flat schablon was tempting here and wrong. The draft run ships with
 * calculation_params set, so its "Beräkna om" is live: a visitor who presses it
 * gets the engine's real table lookup, and any approximation would make the
 * open run jump away from the booked one it is supposed to mirror. It would
 * also put a wrong skatteavdrag on screen in the payslip, the 2710 verifikat
 * line and the AGI figures, which is not a thing an accounting product should
 * demo. The fallback module is a plain synchronous constant, no DB and no
 * network, so there is nothing to depend on being loaded.
 *
 * Column 1 is ordinary employment income for someone below 66 (SKV 434), which
 * is what both demo employees are registered as.
 */
function lookupTaxWithheld(monthlyIncome: number): number {
  const table = FALLBACK_TAX_TABLES_2026[TAX_TABLE_NUMBER]
  if (!table) {
    throw new Error(`Sandbox seed: no 2026 tax table ${TAX_TABLE_NUMBER}`)
  }
  // Rows are [incomeFrom, incomeTo, col1..col6] and the brackets are integer
  // kronor, so round before comparing.
  const income = Math.round(monthlyIncome)
  const row = table.find(([from, to]) => income >= from && income <= to)
  if (!row) {
    throw new Error(
      `Sandbox seed: income ${income} is outside tax table ${TAX_TABLE_NUMBER}`,
    )
  }
  return row[1 + TAX_COLUMN]
}

/**
 * Frozen payroll-config snapshot written to salary_runs.calculation_params.
 *
 * A real run stores serializePayrollConfig(config): the full 2026 config row.
 * The seed writes the documented subset that consumers actually read
 * (`slpRate` in lib/salary/salary-entries.ts, `sjuklonRate` in the AGI
 * generator) plus the rates these demo figures were computed with. The column
 * being non-null is also what makes the run detail page treat the run as
 * calculated: KPI cards, Beräkningsdetaljer and the bokförings-preview all
 * hang off `calculation_params != null`.
 */
const DEMO_CALCULATION_PARAMS = {
  configYear: 2026,
  avgifterTotal: AVGIFTER_RATE,
  avgifterReduced65plus: 0.1021,
  egenavgifterTotal: 0.2897,
  slpRate: 0.2426,
  prisbasbelopp: 59200,
  sjuklonRate: 0.8,
  karensavdragFactor: 0.2,
  reducedAvgiftAge: 67,
  // Marks the snapshot as seeded rather than calculated, so anything reading
  // it later can tell the difference from a real frozen config.
  demoSeed: true,
} as const

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
// Figures (computed once, shared by the run rows and the employee rows)
// ============================================================

export interface SandboxPayrollFigures {
  grossSalary: number
  taxableIncome: number
  taxWithheld: number
  netDeductions: number
  netSalary: number
  avgifterRate: number
  avgifterBasis: number
  avgifterAmount: number
  vacationAccrual: number
  vacationAccrualAvgifter: number
  totalEmployerCost: number
}

/**
 * Mirror of lib/salary/calculation-engine for the one shape the seed uses:
 * a single salary line, no benefits, no absence, no gross or net deductions.
 *
 *   taxable       = gross + förmåner (0 here)
 *   net           = gross - skatt - nettoavdrag
 *   avgifter      = (gross + förmåner) × 31,42 %
 *   semesterskuld = semesterunderlag × 12 %
 *   employer cost = gross + avgifter + semesteravsättning + avgifter på den
 */
function computeFigures(grossSalary: number): SandboxPayrollFigures {
  const gross = roundOre(grossSalary)
  const taxWithheld = lookupTaxWithheld(gross)
  const netDeductions = 0
  const vacationAccrual = roundOre(gross * VACATION_ACCRUAL_RATE)
  const vacationAccrualAvgifter = roundOre(vacationAccrual * AVGIFTER_RATE)
  const avgifterAmount = roundOre(gross * AVGIFTER_RATE)

  return {
    grossSalary: gross,
    taxableIncome: gross,
    taxWithheld,
    netDeductions,
    netSalary: roundOre(gross - taxWithheld - netDeductions),
    avgifterRate: AVGIFTER_RATE,
    avgifterBasis: gross,
    avgifterAmount,
    vacationAccrual,
    vacationAccrualAvgifter,
    totalEmployerCost: roundOre(
      gross + avgifterAmount + vacationAccrual + vacationAccrualAvgifter,
    ),
  }
}

/** The two demo employees' per-run figures. Identical on both runs. */
export const SANDBOX_PAYROLL_FIGURES = {
  anna: computeFigures(ANNA_MONTHLY_SALARY),
  erik: computeFigures(ERIK_HOURLY_RATE * ERIK_HOURS_WORKED),
} as const

/**
 * Run-level totals, summed from the same figures the per-employee rows are
 * written from. Computed here rather than typed out so salary_runs.total_* can
 * never drift from sum(salary_run_employees).
 */
export const SANDBOX_RUN_TOTALS = {
  total_gross: roundOre(
    SANDBOX_PAYROLL_FIGURES.anna.grossSalary + SANDBOX_PAYROLL_FIGURES.erik.grossSalary,
  ),
  total_tax: roundOre(
    SANDBOX_PAYROLL_FIGURES.anna.taxWithheld + SANDBOX_PAYROLL_FIGURES.erik.taxWithheld,
  ),
  total_net: roundOre(
    SANDBOX_PAYROLL_FIGURES.anna.netSalary + SANDBOX_PAYROLL_FIGURES.erik.netSalary,
  ),
  total_avgifter: roundOre(
    SANDBOX_PAYROLL_FIGURES.anna.avgifterAmount + SANDBOX_PAYROLL_FIGURES.erik.avgifterAmount,
  ),
  total_vacation_accrual: roundOre(
    SANDBOX_PAYROLL_FIGURES.anna.vacationAccrual + SANDBOX_PAYROLL_FIGURES.erik.vacationAccrual,
  ),
  total_employer_cost: roundOre(
    SANDBOX_PAYROLL_FIGURES.anna.totalEmployerCost +
      SANDBOX_PAYROLL_FIGURES.erik.totalEmployerCost,
  ),
} as const

/**
 * Sum of vacation_accrual_avgifter across the run. Deliberately NOT part of
 * SANDBOX_RUN_TOTALS: salary_runs has no column for it, and everything in that
 * object is spread straight onto the run row. The semester voucher of the
 * booked run needs the figure though (7519 / 2940), so it is exported here
 * rather than recomputed by the caller.
 */
export const SANDBOX_TOTAL_VACATION_ACCRUAL_AVGIFTER = roundOre(
  SANDBOX_PAYROLL_FIGURES.anna.vacationAccrualAvgifter +
    SANDBOX_PAYROLL_FIGURES.erik.vacationAccrualAvgifter,
)

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
    // styrelseledamot (7240): getLineItemAccount keys off this.
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
// 2. salary_runs
// ============================================================

export interface SandboxSalaryRunsInput {
  userId: string
  companyId: string
  today: Date
}

/**
 * Two runs: last month booked and paid, this month still a draft. Both carry
 * the same denormalized totals because the roster and the amounts are the
 * same in both periods; the totals come from SANDBOX_RUN_TOTALS, which is
 * summed from the per-employee figures.
 */
export function buildSandboxSalaryRuns({ userId, companyId, today }: SandboxSalaryRunsInput) {
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
    ...SANDBOX_RUN_TOTALS,
    calculation_params: DEMO_CALCULATION_PARAMS,
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
}

interface BreakdownStep {
  label: string
  formula: string
  input: Record<string, number | string>
  output: number | null
}

/**
 * calculation_breakdown, in the shape RunCalculationDetails renders
 * ({ steps: [{ label, formula, output }] }) and the engine produces. The
 * skatteavdrag step names the table and column it actually came from, because
 * it actually came from them (see lookupTaxWithheld).
 */
function buildBreakdownSteps(
  figures: SandboxPayrollFigures,
  baseStep: BreakdownStep,
): { steps: BreakdownStep[] } {
  return {
    steps: [
      baseStep,
      {
        label: 'Bruttolön',
        formula: 'grundlön + tillägg + frånvaro − bruttoavdrag',
        input: { base: figures.grossSalary, additions: 0, absence: 0, gross_deductions: 0 },
        output: figures.grossSalary,
      },
      {
        label: 'Skattegrundande inkomst',
        formula: 'bruttolön + förmåner',
        input: { gross_salary: figures.grossSalary, benefit_values: 0 },
        output: figures.taxableIncome,
      },
      {
        label: 'Skatteavdrag',
        formula: `skattetabell ${TAX_TABLE_NUMBER}, kolumn ${TAX_COLUMN}`,
        input: {
          taxable_income: figures.taxableIncome,
          tax_table: TAX_TABLE_NUMBER,
          tax_column: TAX_COLUMN,
        },
        output: figures.taxWithheld,
      },
      {
        label: 'Nettolön',
        formula: 'bruttolön − skatt − nettoavdrag',
        input: {
          gross: figures.grossSalary,
          tax: figures.taxWithheld,
          net_deductions: figures.netDeductions,
        },
        output: figures.netSalary,
      },
      {
        label: 'Arbetsgivaravgifter',
        formula: 'avgiftsunderlag × 31,42 %',
        input: { avgifter_basis: figures.avgifterBasis, rate: figures.avgifterRate },
        output: figures.avgifterAmount,
      },
      {
        label: 'Semesteravsättning (procentregeln 12,00 %)',
        formula: 'semesterunderlag × 12,00 %',
        input: { vacation_basis: figures.grossSalary, rate: VACATION_ACCRUAL_RATE },
        output: figures.vacationAccrual,
      },
      {
        label: 'Arbetsgivaravgifter på semesteravsättning',
        formula: 'semesteravsättning × 31,42 %',
        input: {
          vacation_accrual: figures.vacationAccrual,
          avgifter_rate: figures.avgifterRate,
        },
        output: figures.vacationAccrualAvgifter,
      },
      {
        label: 'Total arbetsgivarkostnad',
        formula: 'bruttolön + avgifter + semesteravsättning + avgifter på semester',
        input: {
          gross: figures.grossSalary,
          avgifter: figures.avgifterAmount,
          vacation_accrual: figures.vacationAccrual,
          vacation_avgifter: figures.vacationAccrualAvgifter,
        },
        output: figures.totalEmployerCost,
      },
    ],
  }
}

const ANNA_BREAKDOWN = buildBreakdownSteps(
  SANDBOX_PAYROLL_FIGURES.anna,
  {
    label: 'Grundlön',
    formula: 'månadslön × (sysselsättningsgrad / 100)',
    input: { monthly_salary: ANNA_MONTHLY_SALARY, employment_degree: 100 },
    output: SANDBOX_PAYROLL_FIGURES.anna.grossSalary,
  },
)

const ERIK_BREAKDOWN = buildBreakdownSteps(
  SANDBOX_PAYROLL_FIGURES.erik,
  {
    label: 'Grundlön (timavlönad)',
    formula: 'timlön × arbetade timmar',
    input: { hourly_rate: ERIK_HOURLY_RATE, hours_worked: ERIK_HOURS_WORKED },
    output: SANDBOX_PAYROLL_FIGURES.erik.grossSalary,
  },
)

/**
 * Per-employee calculation results for both runs.
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
}: SandboxSalaryRunEmployeesInput) {
  const periods = resolveSandboxSalaryPeriods(today)

  const common = {
    company_id: companyId,
    tax_table_number: TAX_TABLE_NUMBER,
    tax_column: TAX_COLUMN,
    // Both runs pay out in the current calendar year (see the January note on
    // resolveSandboxSalaryPeriods), so one year covers both.
    tax_table_year: periods.booked.year,
    avgifter_category: 'standard',
  }

  const anna = SANDBOX_PAYROLL_FIGURES.anna
  const erik = SANDBOX_PAYROLL_FIGURES.erik

  /** Figure columns shared by both runs for one employee. */
  const results = (f: SandboxPayrollFigures) => ({
    gross_salary: f.grossSalary,
    gross_deductions: 0,
    benefit_values: 0,
    taxable_income: f.taxableIncome,
    tax_withheld: f.taxWithheld,
    net_deductions: f.netDeductions,
    net_salary: f.netSalary,
    avgifter_rate: f.avgifterRate,
    avgifter_amount: f.avgifterAmount,
    avgifter_basis: f.avgifterBasis,
    vacation_accrual: f.vacationAccrual,
    vacation_accrual_avgifter: f.vacationAccrualAvgifter,
  })

  const annaSnapshot = {
    employee_id: annaEmployeeId,
    employment_degree: 100,
    monthly_salary: ANNA_MONTHLY_SALARY,
    salary_type: 'monthly',
    // Månadsavlönade have no hour count; the column is nullable.
    hours_worked: null,
    calculation_breakdown: ANNA_BREAKDOWN,
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
    calculation_breakdown: ERIK_BREAKDOWN,
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
}

/**
 * One payslip line per calculation row: Grundlön for the månadsavlönad,
 * Timlön (80 tim × 245 kr) for the timavlönad. Account numbers come from
 * getLineItemAccount so the seed cannot drift from the salary account map
 * (both resolve to 7210 Löner till tjänstemän for employment_type 'employee').
 */
export function buildSandboxSalaryLineItems({
  companyId,
  annaEmployeeId,
  erikEmployeeId,
  runEmployees,
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
      amount: isAnna
        ? SANDBOX_PAYROLL_FIGURES.anna.grossSalary
        : SANDBOX_PAYROLL_FIGURES.erik.grossSalary,
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: true,
      is_gross_deduction: false,
      is_net_deduction: false,
      account_number: getLineItemAccount(itemType, 'employee'),
      sort_order: 0,
    }
  })
}
