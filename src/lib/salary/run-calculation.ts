/**
 * Shared salary-calculation orchestration.
 *
 * Both the internal dashboard route (`POST /api/salary/runs/{id}/calculate`)
 * and the v1 public route (`POST /api/v1/companies/{companyId}/salary-runs/{id}/calculate`)
 * call this helper. It performs every side effect the dashboard's calculate
 * step did: load config + employees + tax tables, derive absence / benefits
 * / worked-hours, run the engine per employee, write line items + run-employee
 * results + run totals + calculation_params.
 *
 * The function returns a discriminated result rather than a NextResponse so
 * either caller can wrap it in their own response envelope (internal uses
 * `errorResponseFromCode`; v1 uses `v1ErrorResponseFromCode`).
 *
 * Strict-mode: the function aborts at the FIRST per-employee failure. There
 * is no partial-state recovery: either every employee succeeds and the run
 * gets its aggregated totals + updated row, or the caller receives an error
 * and the run remains in `draft`. This matches the dashboard's behaviour and
 * is required for BFL 5 kap: a half-calculated run that later advances to
 * `review` would post a wrong verifikation when `:book` runs.
 *
 * Query shape: the inputs are read once per run (not once per employee),
 * every employee is priced in memory, and only then are the derived rows
 * written: one delete per kind of derived row and one insert for all of
 * them, then one update per roster row with only the computed columns. A
 * refusal therefore writes nothing.
 *
 * The function does NOT advance the salary_runs status. That's the route's
 * responsibility: the dashboard leaves the run in `draft` (an explicit
 * `/review` verb does the freeze), while v1 collapses calculate+review into
 * a single verb. Routes layer the status transition on top of this result.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateSalary, monthlyBaseSalary, type CalculationStep } from './calculation-engine'
import { SalaryCalculationPolicySchema } from './calculation-policy'
import {
  DERIVED_ABSENCE_TYPES,
  DERIVED_PREMIUM_TYPES,
  isCalculatedLine,
  VACATION_COMPENSATION_SOURCE,
  VACATION_PAY_SOURCE,
} from './calculated-line-items'
import { validateOneOffTaxLine } from './one-off-tax'
import {
  benefitPaymentRefusalDetails,
  collectDescribedLines,
  describeDoubleBenefitAdjustments,
  doubleBenefitAdjustmentWarning,
  resolveTaxableBenefits,
} from './benefit-payments'
import {
  loadPayrollConfig,
  PayrollConfigMissingError,
  serializePayrollConfig,
  type PayrollConfig,
} from './payroll-config'
import { fetchAllTaxTableRatesForRun, TaxTableUnavailableError } from './tax-tables'
import { REGIONAL_SUPPORT_PARAM } from './regional-support'
import { AbsenceInputError, deriveEmployeeAbsence, loadRunAbsence } from './derive-absence-line-items'
import { monthWindow, runDeviationWindow } from './deviation-period'
import type { MoneyLineItemType } from './account-mapping'
import { recurringLineFlags, type RecurringLineItemType } from './recurring-lines'
import { RECURRING_TEXT_SORT_ORDER, isTextRow } from './text-rows'
import { computePremiumLines } from './shift-premium-engine'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { effectiveRow } from './effective-figures'
import { refreshRunEmployeeSalaryType, runMonthlySalaryFor } from './base-salary-line'
import { isBaseSalaryDisplayLine } from './line-item-roles'
import { computePriorYtd, loadOpeningBalances } from './ytd'
import { dailyDivisor, degreeAdjustedMonthlySalary, hourlyDivisor, scheduledHoursPerDay } from './work-schedule'
import { paidDaysPerDayOff } from './vacation-net-days'
import { resolveVacationPayRate } from './vacation-pay-rate'
import { getVacationYearBounds, getVacationYearStart, type VacationYearBasis } from './vacation-year'
import {
  loadVariablePayRuns,
  payslipVariableVacationPay,
  previousVacationYearStart,
  sammaloneVariablePay,
  vacationYearLabel,
  type VariablePayRun,
} from './variable-vacation-pay'
import { vaxaStodRefundWarning } from './vaxa-stod'
import {
  deriveVacationDaysPay,
  loadProcentregelnBasisPayslips,
  paidLikeDaysOff,
  procentregelnDayValue,
  vacationDaysOff,
  type ProcentregelnBasisPayslip,
} from './vacation-days-pay'
import type { WorkedDayShift } from './shift-premium-engine'
import type { Logger } from '@/lib/logger'
import type { SalaryLineItemType, ShiftPremiumRule, ShiftPremiumItemType } from '@/types'

/**
 * Effective hourly rate used as the base for shift-premium computation.
 *   - Hourly employees: their stored hourly_rate.
 *   - Monthly employees: degree-adjusted monthly salary /
 *     hourlyDivisor(hours_per_week): 173 at the 40h default (common Swedish
 *     derivation for full-time monthly → hourly, matches the timlön
 *     conventions used in CBAs), the exact 52w formula for other schedules
 *     (arbetsschema-lite). monthly_salary is the full-time salary and
 *     hours_per_week the part-time schedule, so the raw column over the
 *     part-time divisor would price a 10 % employee's hour ten times too high.
 */
function effectiveHourlyRate(emp: {
  salary_type: 'monthly' | 'hourly'
  hourly_rate: number | null
  monthly_salary: number | null
  employment_degree: number | null
  hours_per_week?: number | null
}): number {
  if (emp.salary_type === 'hourly') return emp.hourly_rate || 0
  const monthly = degreeAdjustedMonthlySalary(emp.monthly_salary, emp.employment_degree)
  return monthly > 0 ? Math.round((monthly / hourlyDivisor(emp.hours_per_week)) * 100) / 100 : 0
}

/** Benefit-type → line-item-type mapping for the derived benefit rows. */
const BENEFIT_TYPE_TO_LINE_ITEM: Record<string, MoneyLineItemType> = {
  bike: 'benefit_bike',
  car: 'benefit_car',
  meals: 'benefit_meals',
  housing: 'benefit_housing',
  wellness: 'benefit_wellness',
  other: 'benefit_other',
}

/** Roster row updates in flight at once (step 9e). */
const ROSTER_WRITE_CONCURRENCY = 10

/** The input rows the loop reads, carrying employee_id so one read serves the roster. */
interface WorkedDayRow {
  employee_id: string
  hours: number
  work_date: string
  start_time: string | null
  end_time: string | null
}
interface BenefitRow {
  id: string
  employee_id: string
  benefit_type: string
  description: string
  monthly_value: number
}
interface RecurringRow {
  id: string
  employee_id: string
  item_type: string
  description: string
  amount: number
  account_number: string | null
  valid_to: string | null
}

function groupByEmployee<T extends { employee_id: string }>(rows: T[]): Map<string, T[]> {
  const byEmployee = new Map<string, T[]>()
  for (const row of rows) {
    const group = byEmployee.get(row.employee_id)
    if (group) group.push(row)
    else byEmployee.set(row.employee_id, [row])
  }
  return byEmployee
}

/** A paginated read's failure (fetchAllRows throws), in the shape a PostgREST error has. */
function databaseError(err: unknown): RunSalaryCalculationResult {
  const source = (err ?? {}) as { message?: string; code?: string; details?: string; hint?: string }
  return {
    ok: false,
    code: 'DATABASE_ERROR',
    details: { message: source.message, code: source.code, details: source.details, hint: source.hint },
  }
}

export interface RunSalaryCalculationArgs {
  supabase: SupabaseClient
  companyId: string
  salaryRunId: string
  log: Logger
  requestId: string
}

export type RunSalaryCalculationResult =
  | { ok: true; run: Record<string, unknown>; warnings: string[] }
  | {
      ok: false
      code: string
      details?: unknown
      status?: number
      /**
       * The refusal's own sentences, for a code whose message names the
       * employees and what to do (thrown_message_sv in the registry). The
       * doors pass them on: errorResponseFromCode, v1ErrorResponseFromCode
       * and the MCP tool.
       */
      messageSv?: string
      messageEn?: string
    }

/**
 * Run the per-employee calculation for a salary run.
 *
 * Preconditions enforced inside:
 *   - salary_runs row exists, is owned by `companyId`, and is in `draft` status
 *   - at least one salary_run_employee row exists for the run
 *   - every employee has a valid salary amount + tax configuration
 *   - every needed tax table is fetchable from Skatteverket (or local fallback)
 *
 * Returns the updated salary_runs row + warnings on success. Returns a
 * structured `{ ok: false; code; details? }` on any failure. The caller is
 * responsible for converting that to its response envelope.
 */
export async function runSalaryCalculation(
  args: RunSalaryCalculationArgs,
): Promise<RunSalaryCalculationResult> {
  const { supabase, companyId, salaryRunId: id, log, requestId } = args
  const opLog = log.child({ salaryRunId: id })

  // 1. Precondition: run exists, owned by company, is in draft status.
  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (runError || !run) {
    return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  }
  if (run.status !== 'draft') {
    return {
      ok: false,
      code: 'SALARY_RUN_CALCULATE_FAILED',
      details: { currentStatus: run.status, reason: 'not_draft' },
    }
  }

  const paymentYear = parseInt(run.payment_date.split('-')[0])

  // 2. Load year config. A year without rates is a known state (the row ships
  //    when the figures are official), reported by name like a missing tax
  //    table; anything else is a real failure and propagates.
  let config: PayrollConfig
  try {
    config = await loadPayrollConfig(supabase, paymentYear)
  } catch (err) {
    if (err instanceof PayrollConfigMissingError) {
      return { ok: false, code: err.code, details: { paymentYear } }
    }
    throw err
  }

  // 2b. Company-level öresavrundning toggle: round each net payout up to a
  //     whole krona (banks that reject öre in salary files). maybeSingle: a
  //     company without a settings row keeps the default (off).
  //     The same row carries the calculation conventions
  //     (lib/salary/calculation-policy.ts); a missing row or an empty object
  //     is every default, which is the historical engine. An unparseable
  //     policy (only reachable by direct SQL: the API validates on write)
  //     refuses the run rather than silently calculating on defaults.
  const { data: companySettings, error: settingsError } = await supabase
    .from('company_settings')
    .select('salary_net_rounding, salary_calculation_policy, salary_vacation_year_basis, salary_regional_support')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) {
    return { ok: false, code: 'DATABASE_ERROR', details: settingsError }
  }
  const roundNetToWholeKrona = companySettings?.salary_net_rounding === true
  // Semesterår boundaries for the variable vacation pay (step 7c), read the
  // way getVacationYearBasis reads them: anything but statutory is calendar.
  const vacationYearBasis: VacationYearBasis =
    companySettings?.salary_vacation_year_basis === 'statutory_apr_mar' ? 'statutory_apr_mar' : 'calendar'
  const policyParse = SalaryCalculationPolicySchema.safeParse(companySettings?.salary_calculation_policy ?? {})
  if (!policyParse.success) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: {
        reason: 'salary_calculation_policy_invalid',
        issues: policyParse.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      },
    }
  }
  const calculationPolicy = policyParse.data
  // Regionalt stöd (regional-support.ts, PH 208): the company attests work
  // at a fast driftställe in a stödområde. Frozen into the snapshot below so
  // the run's booking and AGI read the answer it was calculated with.
  const regionalSupport = companySettings?.salary_regional_support === true

  // 3. Load roster: `salary_run_employees` joined with employees + line items.
  // Defense-in-depth: filter by company_id too even though salary_run_id is a
  // foreign key. RLS already constrains the table per-company, but per
  // CLAUDE.md every query carries the company_id filter explicitly so a
  // future RLS lapse can't surface cross-tenant rows.
  const { data: runEmployeesData, error: empError } = await supabase
    .from('salary_run_employees')
    .select('*, employee:employees(*), line_items:salary_line_items(*)')
    .eq('salary_run_id', id)
    .eq('company_id', companyId)

  if (empError) {
    return { ok: false, code: 'DATABASE_ERROR', details: empError }
  }
  // An empty roster is valid: a registered employer must still file a
  // nolldeklaration (HU-only AGI) for months without payroll. Calculation
  // then yields all-zero totals plus a frozen calculation_params snapshot,
  // and every downstream loop simply iterates zero times.
  const runEmployees = runEmployeesData ?? []

  // 4. Pre-calculation validation: ensure every employee has the data the
  //    engine needs. We accumulate ALL errors so the caller sees a complete
  //    list rather than fixing one and discovering the next on the retry.
  const validationErrors: string[] = []
  for (const sre of runEmployees) {
    const emp = sre.employee
    if (!emp) continue
    const name = `${emp.first_name} ${emp.last_name}`

    // A per-run monthly salary of 0 is allowed: it represents an intentional
    // nollkörning (the user edited this month's salary down to 0). Only a
    // negative value is rejected. New employees still require monthly_salary > 0
    // at creation (CreateEmployeeSchema), so a stray 0 cannot arise by accident.
    if (emp.salary_type === 'monthly' && sre.monthly_salary < 0) {
      validationErrors.push(`${name}: Månadslön kan inte vara negativ`)
    }
    if (emp.salary_type === 'hourly' && (!emp.hourly_rate || emp.hourly_rate <= 0)) {
      validationErrors.push(`${name}: Timlön saknas eller är 0`)
    }
    if (emp.f_skatt_status === 'a_skatt' && !emp.is_sidoinkomst && !emp.tax_table_number) {
      validationErrors.push(`${name}: Skattetabell saknas (krävs för A-skatt)`)
    }
    // The calendar-day long-leave convention is a five-day-week rule; the
    // derivation would throw on any other schedule, so refuse up front with
    // the employee named instead of a 500 mid-loop.
    if (
      calculationPolicy.long_leave === 'calendar_after_five_workdays' &&
      (emp.workdays_per_week ?? 5) !== 5
    ) {
      validationErrors.push(`${name}: Kalenderdagsavdrag kräver femdagarsvecka (arbetsdagar per vecka måste vara 5)`)
    }
    // Engångsskatt lines were validated when written, but the DB CHECK is
    // the only gate for rows that arrived another way. Same reason: name the
    // line here rather than let the engine throw.
    for (const li of (sre.line_items || []) as Array<Record<string, unknown>>) {
      const oneOffError = validateOneOffTaxLine({
        one_off_tax_percent: li.one_off_tax_percent as number | null | undefined,
        item_type: li.item_type as string,
        amount: li.amount as number,
        is_taxable: li.is_taxable as boolean,
        is_gross_deduction: li.is_gross_deduction as boolean,
        is_net_deduction: li.is_net_deduction as boolean,
      })
      if (oneOffError) validationErrors.push(`${name}: ${li.description as string}: ${oneOffError}`)
    }
  }
  if (validationErrors.length > 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { issues: validationErrors, reason: 'employee_data_incomplete' },
    }
  }

  // 5. Fetch every needed tax table in one batch. The Skatteverket API has
  //    fallback to local data; if both fail TaxTableUnavailableError surfaces
  //    as a distinct retryable 503.
  const tableNumbers = [
    ...new Set(
      runEmployees
        .filter((e) => e.employee?.tax_table_number)
        .map((e) => e.employee.tax_table_number as number),
    ),
  ]
  const columns = [
    ...new Set(
      runEmployees
        .filter((e) => e.employee?.tax_column)
        .map((e) => e.employee.tax_column as number),
    ),
  ]
  let taxRates: Awaited<ReturnType<typeof fetchAllTaxTableRatesForRun>>['rates'] = []
  let taxTableSource: Awaited<ReturnType<typeof fetchAllTaxTableRatesForRun>>['source'] = 'api'
  if (tableNumbers.length > 0) {
    try {
      const result = await fetchAllTaxTableRatesForRun(
        paymentYear,
        tableNumbers,
        columns.length > 0 ? columns : [1],
      )
      taxRates = result.rates
      taxTableSource = result.source
    } catch (err) {
      if (err instanceof TaxTableUnavailableError) {
        return {
          ok: false,
          code: 'SALARY_RUN_TAX_TABLE_MISSING',
          details: { reason: err.message, paymentYear, tableNumbers },
          status: 503,
        }
      }
      throw err
    }
  }

  // 6. Cutover opening balances (payroll gap-closure 2.2): a company that
  //    switched to Accounted mid-year has YTD state from its previous
  //    payroll system that no run in this system carries. Loaded here
  //    because the karensavdrag adjustment further down reads the same rows.
  const rosterEmployeeIds = runEmployees.map((sre) => sre.employee_id as string)
  const openingByEmployee = new Map<
    string,
    { cutoverDate: string; karensPeriodsAdjustment: number }
  >()

  // 6b. YTD carried into this period (prior counted runs + any pre-cutover
  //     balance). Stored on the roster rows below as the payslip's
  //     "Ackumulerat" block, and refreshed again when the run is approved
  //     and booked: calculating a run before an earlier month is authorized
  //     would otherwise freeze a YTD that is missing that month forever.
  //     YTD is display + reporting only: the per-month tax lookup and the
  //     per-month avgifter caps never read it.
  //
  //     A failed read throws rather than yielding an empty carry-in. Silently
  //     dropping every prior month (and, from the same rows, the karensavdrag
  //     adjustment that reaches sjuklön) is worse than failing the
  //     calculation, and matches how this function treats every other query
  //     error.
  let ytdByEmployee: Map<string, { gross: number; tax: number; net: number | null }>
  try {
    const openingRows = await loadOpeningBalances(supabase, companyId, rosterEmployeeIds)
    for (const opening of openingRows) {
      openingByEmployee.set(opening.employee_id, {
        cutoverDate: opening.cutover_date,
        karensPeriodsAdjustment: opening.karens_periods_adjustment ?? 0,
      })
    }

    ytdByEmployee = await computePriorYtd(supabase, {
      companyId,
      periodYear: run.period_year as number,
      periodMonth: run.period_month as number,
      employeeIds: rosterEmployeeIds,
      openingRows,
    })
  } catch (err) {
    return {
      ok: false,
      code: 'DATABASE_ERROR',
      details: { reason: err instanceof Error ? err.message : 'YTD aggregation failed' },
    }
  }

  // 7. Two windows. The pay month (periodStart..periodEnd) prorates the fixed
  //    salary for employments that start or end mid-month. The avvikelseperiod
  //    (deviation.start..deviation.end) is where per-day absence and worked-day
  //    records are read from: the same month by default, the previous month
  //    for companies that run "föregående månads avvikelser". It is snapshotted
  //    on the run at creation; older runs without it fall back to the pay month.
  const periodYear = run.period_year as number
  const periodMonth = run.period_month as number
  const payMonth = monthWindow(periodYear, periodMonth)
  const periodStart = payMonth.start
  const periodEnd = payMonth.end
  const deviation = runDeviationWindow({
    period_year: periodYear,
    period_month: periodMonth,
    deviation_period_start: run.deviation_period_start as string | null | undefined,
    deviation_period_end: run.deviation_period_end as string | null | undefined,
  })

  // 7b. Load active shift_premium_rules once per run. Filtered by company.
  // Inactive rules excluded: the engine also re-checks, but this saves
  // network bytes for companies with many archived rules.
  const { data: premiumRulesRaw, error: rulesError } = await supabase
    .from('shift_premium_rules')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_active', true)
  if (rulesError) {
    return { ok: false, code: 'DATABASE_ERROR', details: rulesError }
  }
  const premiumRules = (premiumRulesRaw ?? []) as ShiftPremiumRule[]

  // 7c. Everything the per-employee loop reads, read once for the roster:
  //     absence, worked days (hourly employees, or everyone when premium rules
  //     exist), förmåner and recurring lines. In parallel, paginated (a
  //     roster's rows pass PostgREST's 1000-row cap long before an employer
  //     is large) and grouped by employee. A failed absence read propagates
  //     as it always has; the others answer DATABASE_ERROR, checked in that
  //     order whichever finished first.
  const roster = runEmployees.filter((sre) => sre.employee)
  const employeeIds = roster.map((sre) => sre.employee.id as string)
  const workedDayEmployeeIds = roster
    .filter((sre) => sre.employee.salary_type === 'hourly' || premiumRules.length > 0)
    .map((sre) => sre.employee.id as string)
  // Sammalöneregeln employees: their other payslips from the start of the
  // previous semesterår to the end of the current one, for the semesterlön of
  // the rörliga lönedelar (lib/salary/variable-vacation-pay.ts). Nobody on
  // the rule, no read.
  const sammaloneEmployeeIds = roster
    .filter((sre) => sre.employee.vacation_rule === 'sammaloneregeln')
    .map((sre) => sre.employee.id as string)
  const currentVacationYearStart = getVacationYearStart(run.payment_date, vacationYearBasis)
  // Procentregeln employees with paid vacation days to price (Semesterlagen
  // 16 b §, lib/salary/vacation-days-pay.ts): their payslips of the year
  // before the current one, the year the semesterlön is 12 % of. Nobody with
  // such days, no read.
  const procentregelnBasisEmployeeIds = roster
    .filter(
      (sre) =>
        sre.employee.vacation_rule === 'procentregeln' &&
        paidLikeDaysOff(vacationDaysOff((sre.line_items || []) as Array<Record<string, unknown>>)) > 0,
    )
    .map((sre) => sre.employee.id as string)
  const [absenceLoad, workedLoad, benefitsLoad, recurringLoad, variablePayLoad, procentregelnBasisLoad] = await Promise.allSettled([
    loadRunAbsence(supabase, {
      companyId,
      employeeIds,
      periodStart: deviation.start,
      periodEnd: deviation.end,
      withContext: calculationPolicy.long_leave === 'calendar_after_five_workdays',
      // The VAB and parental 120-date cap counts within the intjänandeår
      // (Semesterlagen 17 a §), which follows the company's semesterår basis.
      earningYearStart: getVacationYearStart(deviation.start, vacationYearBasis),
    }),
    workedDayEmployeeIds.length === 0
      ? Promise.resolve<WorkedDayRow[]>([])
      : fetchAllRows<WorkedDayRow>(({ from, to }) =>
          supabase
            .from('salary_worked_days')
            .select('employee_id, hours, work_date, start_time, end_time')
            .eq('company_id', companyId)
            .in('employee_id', workedDayEmployeeIds)
            .gte('work_date', deviation.start)
            .lte('work_date', deviation.end)
            // (employee_id, work_date) is unique: a total order for paging.
            .order('employee_id')
            .order('work_date')
            .range(from, to),
        ),
    employeeIds.length === 0
      ? Promise.resolve<BenefitRow[]>([])
      : fetchAllRows<BenefitRow>(({ from, to }) =>
          supabase
            .from('employee_benefits')
            .select('id, employee_id, benefit_type, description, monthly_value')
            .in('employee_id', employeeIds)
            .eq('company_id', companyId)
            .eq('is_active', true)
            .lte('valid_from', run.payment_date)
            .or(`valid_to.is.null,valid_to.gte.${run.payment_date}`)
            // Registration order within an employee (the order the rows'
            // sort_order follows); id makes it total for paging.
            .order('created_at')
            .order('id')
            .range(from, to),
        ),
    // valid_to is filtered in JS rather than with a dynamic .or() so the
    // phantom-column scanner can resolve every expression in this query.
    employeeIds.length === 0
      ? Promise.resolve<RecurringRow[]>([])
      : fetchAllRows<RecurringRow>(({ from, to }) =>
          supabase
            .from('employee_recurring_lines')
            .select('id, employee_id, item_type, description, amount, account_number, valid_to')
            .in('employee_id', employeeIds)
            .eq('company_id', companyId)
            .eq('is_active', true)
            .lte('valid_from', run.payment_date)
            .order('created_at')
            .order('id')
            .range(from, to),
        ),
    sammaloneEmployeeIds.length === 0
      ? Promise.resolve(new Map<string, VariablePayRun[]>())
      : loadVariablePayRuns(supabase, {
          companyId,
          employeeIds: sammaloneEmployeeIds,
          from: previousVacationYearStart(currentVacationYearStart),
          to: getVacationYearBounds(currentVacationYearStart).end,
          excludeRunId: id,
        }),
    procentregelnBasisEmployeeIds.length === 0
      ? Promise.resolve(new Map<string, ProcentregelnBasisPayslip[]>())
      : loadProcentregelnBasisPayslips(supabase, {
          companyId,
          employeeIds: procentregelnBasisEmployeeIds,
          from: previousVacationYearStart(currentVacationYearStart),
          to: currentVacationYearStart,
          excludeRunId: id,
        }),
  ])
  if (absenceLoad.status === 'rejected') throw absenceLoad.reason
  if (workedLoad.status === 'rejected') return databaseError(workedLoad.reason)
  if (benefitsLoad.status === 'rejected') return databaseError(benefitsLoad.reason)
  if (recurringLoad.status === 'rejected') return databaseError(recurringLoad.reason)
  if (variablePayLoad.status === 'rejected') return databaseError(variablePayLoad.reason)
  if (procentregelnBasisLoad.status === 'rejected') return databaseError(procentregelnBasisLoad.reason)
  const absenceByEmployee = absenceLoad.value
  const workedDaysByEmployee = groupByEmployee(workedLoad.value)
  const benefitsByEmployee = groupByEmployee(benefitsLoad.value)
  const recurringByEmployee = groupByEmployee(recurringLoad.value)
  const variablePayRunsByEmployee = variablePayLoad.value
  const procentregelnBasisByEmployee = procentregelnBasisLoad.value

  // Per-run aggregates collected during the loop.
  let totalGross = 0
  let totalTax = 0
  let totalNet = 0
  let totalAvgifter = 0
  let totalVacationAccrual = 0
  let totalEmployerCost = 0

  // Surfaced as warnings: UI / agent shows alongside the successful
  // calculation, not an error.
  const lakarintygEmployees: string[] = []
  const fkReportingEmployees: string[] = []
  const hourlyKarensEmployees: string[] = []
  const doubleBenefitAdjustments: string[] = []
  const vaxaStodRefundEmployees: string[] = []
  const variableVacationPayEmployees: string[] = []
  const vacationDaysPayEmployees: string[] = []
  // Vacation days the law and the data cannot price (vacation-days-pay.ts):
  // collected for the whole roster, then refused together before anything
  // is written.
  const vacationPayIssues: Array<{ employee: string; message: string; message_en: string }> = []

  // What the loop decides to write. Nothing is written until every employee
  // is priced (step 9), so a refusal part-way leaves the run as it was.
  const staleSalaryTypeRows: typeof roster = []
  const hourlyLineRefreshIds: string[] = []
  const monthlyLineAmounts: Array<{ salaryRunEmployeeId: string; amount: number }> = []
  const derivedLineRows: Array<Record<string, unknown>> = []
  const rosterWrites: Array<{ id: string; columns: Record<string, unknown> }> = []

  // 8. Per-employee calculation: in memory, no reads and no writes.
  for (const sre of roster) {
    const emp = sre.employee

    // 8-. The engine prices the employee's live pay type. A row whose
    //     salary_type snapshot predates a switch between hourly and monthly
    //     pay gets the snapshot and its Grundlön/Timlön display line brought
    //     in line first (lib/salary/base-salary-line.ts, step 9a); the
    //     branches below price the new line.
    const staleSalaryType = Boolean(sre.salary_type && emp.salary_type && sre.salary_type !== emp.salary_type)
    if (staleSalaryType) staleSalaryTypeRows.push(sre)
    // The run's monthly salary under the live pay type. A row whose pay type
    // is stale never had one of its own (lib/salary/base-salary-line.ts), so
    // it is priced from the employee's, the figure 9a writes back (crm#1337).
    const runMonthlySalary: number = staleSalaryType ? runMonthlySalaryFor(emp) : sre.monthly_salary

    // 8a. Derive absence line items from per-day records. The cutover karens
    //     adjustment applies only while the 12-month högriskskydd lookback
    //     still reaches into pre-cutover time; past that horizon the
    //     adjustment is stale and imported day rows carry the truth.
    const opening = openingByEmployee.get(emp.id)
    const lookbackStartMs = Date.parse(`${deviation.start}T00:00:00Z`) - 365 * 86_400_000
    const karensAdjustmentApplies =
      opening !== undefined &&
      opening.karensPeriodsAdjustment > 0 &&
      lookbackStartMs < Date.parse(`${opening.cutoverDate}T00:00:00Z`)
    const hourlyPay = emp.salary_type === 'hourly'
    let absenceResult: ReturnType<typeof deriveEmployeeAbsence>
    try {
      absenceResult = deriveEmployeeAbsence({
        rows: absenceByEmployee.get(emp.id),
        // The pay the deductions are taken from. sre.monthly_salary is the
        // full-time salary; a 10 % employee's karensavdrag comes off 10 % of it,
        // the same base the engine's Step 1 pays (issue #2879). Hourly pay has
        // no such salary (a stale monthly_salary from before a switch to hourly
        // must never be deducted from timlön): sick pay is priced from the
        // timlön and the hours on the sick rows instead.
        monthlySalary: hourlyPay ? 0 : degreeAdjustedMonthlySalary(runMonthlySalary, emp.employment_degree),
        salaryType: hourlyPay ? 'hourly' : 'monthly',
        hourlyRate: hourlyPay ? emp.hourly_rate : null,
        payrollConfig: config,
        periodStart: deviation.start,
        periodEnd: deviation.end,
        karensPeriodsAdjustment: karensAdjustmentApplies ? opening.karensPeriodsAdjustment : 0,
        dailyDivisor: dailyDivisor(emp.workdays_per_week),
        // Scheduled hours per day weight partial absence rows (4 h of an 8 h day
        // is half a day). hours_per_week already reflects the employment degree.
        hoursPerDay: scheduledHoursPerDay(emp.hours_per_week, emp.workdays_per_week),
        hoursPerWeek: emp.hours_per_week > 0 ? emp.hours_per_week : 40,
        workdaysPerWeek: emp.workdays_per_week > 0 ? emp.workdays_per_week : 5,
        calculationPolicy,
      })
    } catch (err) {
      // An input the sick pay cannot be priced without: refuse by name
      // rather than pay 0 kr. Nothing has been written yet.
      if (err instanceof AbsenceInputError) {
        return {
          ok: false,
          code: 'VALIDATION_ERROR',
          details: { issues: [`${emp.first_name} ${emp.last_name}: ${err.message}`], reason: 'absence_input_incomplete' },
        }
      }
      throw err
    }

    // 8b. For hourly employees, derive worked hours from the calendar.
    //     For all employees (when premium rules exist), the same rows feed
    //     the shift-premium engine in 8z below.
    let derivedHoursWorked: number | null = null
    let workedDayRows: Array<{ work_date: string; hours: number; start_time: string | null; end_time: string | null }> = []
    if (emp.salary_type === 'hourly' || premiumRules.length > 0) {
      workedDayRows = (workedDaysByEmployee.get(emp.id) ?? []).map((d) => ({
        hours: d.hours,
        work_date: d.work_date,
        start_time: d.start_time,
        end_time: d.end_time,
      }))
    }
    // Rows derived for this employee, in the order they are inserted.
    const hourlyLineRows: Array<Record<string, unknown>> = []
    if (emp.salary_type === 'hourly') {
      derivedHoursWorked = workedDayRows.reduce(
        (sum, d) => Math.round((sum + Number(d.hours)) * 100) / 100,
        0,
      )
      opLog.info('Derived hours_worked from calendar', {
        employeeId: emp.id,
        periodStart: deviation.start,
        periodEnd: deviation.end,
        rowCount: workedDayRows.length,
        derivedHoursWorked,
      })

      // Refresh the hourly_salary line item so the displayed Lönerader table
      // matches what the engine actually calculated.
      if (derivedHoursWorked > 0 && (emp.hourly_rate || 0) > 0) {
        const baseAmount =
          Math.round((emp.hourly_rate as number) * derivedHoursWorked * 100) / 100
        hourlyLineRefreshIds.push(sre.id)
        hourlyLineRows.push({
          salary_run_employee_id: sre.id,
          company_id: companyId,
          item_type: 'hourly_salary',
          description: 'Timlön',
          quantity: derivedHoursWorked,
          amount: baseAmount,
          is_taxable: true,
          is_avgift_basis: true,
          is_vacation_basis: true,
          is_gross_deduction: false,
          is_net_deduction: false,
          account_number: null,
          sort_order: 0,
        })
      }
    }

    // Refresh the monthly 'Grundlön' line so the displayed Lönerader table
    // matches the per-run monthly salary the engine actually uses. The engine
    // recomputes baseSalary from sre.monthly_salary (not from this line item),
    // so this update is display-only: it keeps the row consistent after the
    // user edits this month's salary on the draft. monthlyBaseSalary is the
    // engine's own Step 1, so a partial month (and the company's
    // partial_month convention) shows the same figure the calculation used.
    // Written only when a line differs (or was just swapped in by 8-): a
    // recalculation of an unchanged draft rewrites nothing.
    if (emp.salary_type === 'monthly') {
      const baseAmount = monthlyBaseSalary({
        monthlySalary: runMonthlySalary || 0,
        employmentDegree: emp.employment_degree,
        employmentStart: emp.employment_start,
        employmentEnd: emp.employment_end,
        periodStart,
        periodEnd,
        calculationPolicy,
      })
      const lineDiffers = ((sre.line_items || []) as Array<Record<string, unknown>>).some(
        (li) => li.item_type === 'monthly_salary' && li.amount !== baseAmount,
      )
      if (staleSalaryType || lineDiffers) {
        monthlyLineAmounts.push({ salaryRunEmployeeId: sre.id, amount: baseAmount })
      }
    }

    const employeeName = `${emp.first_name} ${emp.last_name}`
    if (absenceResult.flagLakarintyg) lakarintygEmployees.push(employeeName)
    if (absenceResult.flagFkReporting) fkReportingEmployees.push(employeeName)
    // An hourly employee's karensavdrag rests on the weekly hours registered
    // on the employee (SjLL 6 § 2 st: the average week). Named every time, so
    // a schedule left at the default is seen before the run is approved.
    if (hourlyPay && absenceResult.lineItems.some((li) => li.item_type === 'sick_karens')) {
      hourlyKarensEmployees.push(`${employeeName} (${emp.hours_per_week > 0 ? emp.hours_per_week : 40} tim/vecka)`)
    }

    // 8d. Derive benefit line items from employee_benefits.
    const derivedBenefitRows = (benefitsByEmployee.get(emp.id) ?? [])
      .filter((b) => b.monthly_value > 0)
      .map((b, idx) => {
        const itemType = BENEFIT_TYPE_TO_LINE_ITEM[b.benefit_type] ?? 'benefit_other'
        return {
          salary_run_employee_id: sre.id,
          company_id: companyId,
          item_type: itemType,
          description: b.description,
          quantity: 1,
          amount: Math.round(b.monthly_value * 100) / 100,
          is_taxable: true,
          is_avgift_basis: true,
          is_vacation_basis: false,
          is_gross_deduction: false,
          is_net_deduction: false,
          account_number: null,
          sort_order: 200 + idx,
          source_benefit_id: b.id,
        }
      })

    // 8d3. Derive recurring line items from employee_recurring_lines: same
    //      lifecycle as the benefit rows (deleted by back-link, re-derived for
    //      rows whose validity window covers the payment date). Flags come
    //      from the item type so a stored row can never contradict the
    //      payslip math. A recurring text row is copied as words only (no
    //      quantity, amount 0, no account) and sorts directly under the base
    //      salary row; it is stored on the run, so the payslip keeps the text
    //      it was issued with even if the recurring line changes later.
    const activeRecurring = (recurringByEmployee.get(emp.id) ?? []).filter(
      (r) => !r.valid_to || r.valid_to >= run.payment_date,
    )
    let textIdx = 0
    const derivedRecurringRows = activeRecurring.map((r, idx) => {
      const itemType = r.item_type as RecurringLineItemType
      const flags = recurringLineFlags(itemType)
      const text = itemType === 'text'
      return {
        salary_run_employee_id: sre.id,
        company_id: companyId,
        item_type: itemType,
        description: r.description,
        quantity: text ? null : 1,
        amount: text ? 0 : roundOre(r.amount),
        is_taxable: flags.is_taxable,
        is_avgift_basis: flags.is_avgift_basis,
        is_vacation_basis: flags.is_vacation_basis,
        is_gross_deduction: flags.is_gross_deduction,
        is_net_deduction: flags.is_net_deduction,
        // A text row has no account; any other row carries its own
        // override, else the default resolved at booking (account-mapping.ts
        // lineItemAccount).
        account_number: text ? null : r.account_number || null,
        sort_order: text ? RECURRING_TEXT_SORT_ORDER + textIdx++ : 250 + idx,
        source_recurring_line_id: r.id,
      }
    })

    // 8c. Derived absence rows.
    const absenceRows = absenceResult.lineItems.map((li, idx) => ({
      salary_run_employee_id: sre.id,
      company_id: companyId,
      item_type: li.item_type,
      description: li.description,
      quantity: li.quantity,
      amount: Math.round(li.amount * 100) / 100,
      is_taxable: li.is_taxable,
      is_avgift_basis: li.is_avgift_basis,
      is_vacation_basis: li.is_vacation_basis,
      is_gross_deduction: li.is_gross_deduction,
      is_net_deduction: false,
      account_number: null,
      sort_order: 100 + idx,
    }))

    // 8d2. Derive shift-premium rows (OB-tillägg, övertid 50/100). The engine
    //      consumes start_time/end_time when present; rows without explicit
    //      times fall back to a default 08:00-17:00 shift (no pure-night/
    //      pure-weekend rules trigger for those days). The premium rate is
    //      applied to the employee's effectiveHourlyRate so monthly
    //      employees still get OB by deriving an hourly rate as
    //      monthly_salary / 173.
    let derivedPremiumRows: Array<{
      salary_run_employee_id: string
      company_id: string
      item_type: ShiftPremiumItemType
      description: string
      quantity: number
      amount: number
      is_taxable: boolean
      is_avgift_basis: boolean
      is_vacation_basis: boolean
      is_gross_deduction: boolean
      is_net_deduction: boolean
      account_number: string | null
      sort_order: number
    }> = []

    if (premiumRules.length > 0 && workedDayRows.length > 0) {
      const baseHourlyRate = effectiveHourlyRate({
        salary_type: emp.salary_type,
        hourly_rate: emp.hourly_rate,
        monthly_salary: runMonthlySalary,
        employment_degree: emp.employment_degree,
        hours_per_week: emp.hours_per_week,
      })
      const shifts: WorkedDayShift[] = workedDayRows.map((row) => ({
        work_date: row.work_date,
        hours: Number(row.hours),
        start_time: row.start_time,
        end_time: row.end_time,
      }))
      const premiumLines = computePremiumLines({
        employeeId: emp.id,
        baseHourlyRate,
        workedDays: shifts,
        rules: premiumRules,
      })
      derivedPremiumRows = premiumLines.map((line, idx) => ({
        salary_run_employee_id: sre.id,
        company_id: companyId,
        item_type: line.itemType,
        description: line.description,
        quantity: line.hours,
        amount: line.amount,
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: true,
        is_gross_deduction: false,
        is_net_deduction: false,
        account_number: null,
        sort_order: 300 + idx,
      }))
    }

    // 8e. Assemble the in-memory line item set fed to calculateSalary.
    const manualLineItems = (sre.line_items || [])
      // Everything the calculation derives is re-derived above; the rest are
      // manual lines (only the engine's own semesterersättning row counts as
      // derived: a manually entered one is a wage the operator decided on).
      // The line commands refuse hand edits to exactly these rows. A text row
      // is words only and never reaches the engine. Nor does the Grundlön/
      // Timlön row that shows Step 1: of the live pay type, or of the
      // snapshot's while 9a has yet to swap it (it deletes that row). A
      // base-salary row of another type is pay on top (crm#1331).
      .filter((li: Record<string, unknown>) => !isCalculatedLine(li) && !isTextRow(li))
      .filter((li: Record<string, unknown>) => !isBaseSalaryDisplayLine(li.item_type, [emp.salary_type, sre.salary_type]))
      .map((li: Record<string, unknown>) => ({
        itemType: li.item_type as SalaryLineItemType,
        amount: li.amount as number,
        isTaxable: li.is_taxable as boolean,
        isAvgiftBasis: li.is_avgift_basis as boolean,
        isVacationBasis: li.is_vacation_basis as boolean,
        isGrossDeduction: li.is_gross_deduction as boolean,
        isNetDeduction: li.is_net_deduction as boolean,
        oneOffTaxPercent: (li.one_off_tax_percent as number | null | undefined) ?? null,
      }))
    const derivedLineItems = absenceResult.lineItems.map((li) => ({
      itemType: li.item_type as SalaryLineItemType,
      amount: li.amount,
      isTaxable: li.is_taxable,
      isAvgiftBasis: li.is_avgift_basis,
      isVacationBasis: li.is_vacation_basis,
      isGrossDeduction: li.is_gross_deduction,
      isNetDeduction: false,
    }))
    const derivedBenefitLineItems = derivedBenefitRows.map((row) => ({
      itemType: row.item_type as SalaryLineItemType,
      amount: row.amount,
      isTaxable: true,
      isAvgiftBasis: true,
      isVacationBasis: false,
      isGrossDeduction: false,
      isNetDeduction: false,
    }))
    const derivedPremiumLineItems = derivedPremiumRows.map((row) => ({
      itemType: row.item_type as SalaryLineItemType,
      amount: row.amount,
      isTaxable: true,
      isAvgiftBasis: true,
      isVacationBasis: true,
      isGrossDeduction: false,
      isNetDeduction: false,
    }))
    const derivedRecurringLineItems = derivedRecurringRows.filter((row) => !isTextRow(row)).map((row) => ({
      itemType: row.item_type as SalaryLineItemType,
      amount: row.amount,
      isTaxable: row.is_taxable,
      isAvgiftBasis: row.is_avgift_basis,
      isVacationBasis: row.is_vacation_basis,
      isGrossDeduction: row.is_gross_deduction,
      isNetDeduction: row.is_net_deduction,
    }))
    const lineItems = [
      ...manualLineItems,
      ...derivedLineItems,
      ...derivedBenefitLineItems,
      ...derivedPremiumLineItems,
      ...derivedRecurringLineItems,
    ]

    // 8e0. Pay for the vacation days taken (issue #85, Semesterlagen 16 a,
    //      16 b, 8 and 22 §§; lib/salary/vacation-days-pay.ts): every vacation
    //      line without an amount is priced from the employee's rule, a line
    //      with an amount is paid as entered. The rows carry the engine's
    //      provenance and are replaced on every calculation (step 9c). A
    //      payslip whose days cannot be priced is refused by name below.
    const vacationDays = vacationDaysOff((sre.line_items || []) as Array<Record<string, unknown>>)
    const vacationPayRows: Array<Record<string, unknown>> = []
    let vacationPaySteps: CalculationStep[] = []
    const hasVacationDays =
      paidLikeDaysOff(vacationDays) > 0 || vacationDays.unpaid > 0 || vacationDays.advance > 0
    if (hasVacationDays) {
      const vacationPay = deriveVacationDaysPay({
        vacationRule: emp.vacation_rule,
        salaryType: hourlyPay ? 'hourly' : 'monthly',
        // The månadslön at the semestertillfälle: this run's salary at the
        // employment degree, never prorated for a partial month (16 a §).
        monthlySalary: hourlyPay ? 0 : degreeAdjustedMonthlySalary(runMonthlySalary, emp.employment_degree),
        semestertillaggRate: emp.semestertillagg_rate,
        dailyDivisor: dailyDivisor(emp.workdays_per_week),
        paidDaysPerDayOff: paidDaysPerDayOff(emp.vacation_days_per_year, emp.workdays_per_week),
        days: vacationDays,
        procentregelnDayValue:
          emp.vacation_rule === 'procentregeln' && paidLikeDaysOff(vacationDays) > 0
            ? procentregelnDayValue({
                paymentDate: run.payment_date,
                basis: vacationYearBasis,
                employmentStart: emp.employment_start,
                employmentEnd: emp.employment_end ?? null,
                vacationDaysPerYear: emp.vacation_days_per_year,
                vacationPayRate: emp.vacation_pay_rate ?? null,
                payslips: procentregelnBasisByEmployee.get(emp.id) ?? [],
              })
            : undefined,
      })
      if (!vacationPay.ok) {
        vacationPayIssues.push({
          employee: employeeName,
          message: vacationPay.reason.sv,
          message_en: vacationPay.reason.en,
        })
        continue
      }
      vacationPaySteps = vacationPay.steps
      for (const row of vacationPay.rows) {
        vacationPayRows.push({
          salary_run_employee_id: sre.id,
          company_id: companyId,
          item_type: 'vacation',
          calculation_source: VACATION_PAY_SOURCE,
          description: row.description,
          // No quantity: the days are on the operator's own line, which the
          // vacation ledger and vacation_days_taken count.
          quantity: null,
          amount: row.amount,
          is_taxable: true,
          is_avgift_basis: true,
          is_vacation_basis: row.is_vacation_basis,
          is_gross_deduction: row.is_gross_deduction,
          is_net_deduction: false,
          account_number: null,
          sort_order: row.sort_order,
        })
        lineItems.push({
          itemType: 'vacation',
          amount: row.amount,
          isTaxable: true,
          isAvgiftBasis: true,
          isVacationBasis: row.is_vacation_basis,
          isGrossDeduction: row.is_gross_deduction,
          isNetDeduction: false,
        })
      }
      if (vacationPay.rows.length > 0) vacationDaysPayEmployees.push(employeeName)
    }

    // 8e1. Semesterlön för rörliga lönedelar (Semesterlagen 16 a § tredje
    //      stycket, 26 § andra stycket, 29 §): under sammalöneregeln the
    //      variable pay that fell due during the semesterår earns the
    //      semesterlön percentage, paid in the first run after the year ends,
    //      or with the final pay when the employment has ended. Derived from
    //      the other payslips every calculation (nothing is stored but the
    //      row), less what an earlier payslip of the year already paid. The
    //      row carries the engine's provenance, so the next calculation
    //      replaces it like the semesterersättning row (step 9c).
    const variableVacationPayRows: Array<Record<string, unknown>> = []
    let variableVacationPayStep: CalculationStep | null = null
    if (emp.vacation_rule === 'sammaloneregeln') {
      const finalSettlement = Boolean(emp.employment_end && emp.employment_end <= periodEnd)
      const variable = payslipVariableVacationPay({
        paymentDate: run.payment_date,
        basis: vacationYearBasis,
        rate: resolveVacationPayRate(emp.vacation_days_per_year, emp.vacation_pay_rate),
        runs: variablePayRunsByEmployee.get(emp.id) ?? [],
        finalSettlement,
        thisRunVariablePay: sammaloneVariablePay(lineItems),
      })
      const amount = variable.owed.unpaid
      if (amount > 0) {
        // A final pay settles the running semesterår as well.
        const yearLabel = finalSettlement
          ? `${vacationYearLabel(variable.yearStart, vacationYearBasis)} och ${vacationYearLabel(currentVacationYearStart, vacationYearBasis)}`
          : vacationYearLabel(variable.yearStart, vacationYearBasis)
        const description = `Semesterlön rörliga lönedelar ${yearLabel}`
        variableVacationPayRows.push({
          salary_run_employee_id: sre.id,
          company_id: companyId,
          item_type: 'semesterersattning',
          calculation_source: VACATION_COMPENSATION_SOURCE,
          description,
          quantity: 1,
          amount,
          is_taxable: true,
          is_avgift_basis: true,
          is_vacation_basis: false,
          is_gross_deduction: false,
          is_net_deduction: false,
          account_number: null,
          sort_order: 51,
        })
        lineItems.push({
          itemType: 'semesterersattning',
          amount,
          isTaxable: true,
          isAvgiftBasis: true,
          isVacationBasis: false,
          isGrossDeduction: false,
          isNetDeduction: false,
        })
        variableVacationPayStep = {
          label: `${description} (Semesterlagen 16 a §)`,
          formula: finalSettlement
            ? 'rörlig lön sedan föregående semesterårs början (slutlön) × semesterlöneprocent − redan utbetalt'
            : 'rörlig lön under föregående semesterår × semesterlöneprocent − redan utbetalt',
          input: {
            variable_pay: variable.owed.variablePay,
            rate: variable.owed.rate,
            payslips: variable.owed.runCount,
            already_paid: variable.owed.alreadyPaid,
          },
          output: amount,
        }
        variableVacationPayEmployees.push(`${emp.first_name} ${emp.last_name}`)
      }
    }

    // 8e2. An employee's payment for a benefit lowers the taxable
    //      förmånsvärde (lib/salary/benefit-payments.ts). Checked on the FINAL
    //      set, not on the stored rows: steps 8d and 8d3 just rebuilt the
    //      benefit and recurring rows from their registers. Refuse by name
    //      rather than let the engine throw a 500 when the payslip cannot say
    //      which benefit the payment is for. Nothing has been written yet.
    const benefitResolution = resolveTaxableBenefits(lineItems)
    if (!benefitResolution.ok) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: benefitPaymentRefusalDetails(`${emp.first_name} ${emp.last_name}`, benefitResolution.error),
      }
    }
    // A bruttolöneavdrag of the same amount is the pre-fix workaround and now
    // lowers the tax base twice. It can also be a real bruttolöneavdrag, so
    // this warns on every calculation until the row is gone, never blocks.
    doubleBenefitAdjustments.push(
      ...describeDoubleBenefitAdjustments(
        `${emp.first_name} ${emp.last_name}`,
        collectDescribedLines((sre.line_items || []) as Array<Record<string, unknown>>, derivedRecurringRows),
        benefitResolution.benefits,
      ),
    )

    // 8f. Run the engine for this employee.
    const result = calculateSalary(
      {
        employmentType: emp.employment_type,
        salaryType: emp.salary_type,
        monthlySalary: runMonthlySalary || 0,
        hourlyRate: emp.hourly_rate || undefined,
        hoursWorked:
          derivedHoursWorked !== null && derivedHoursWorked > 0
            ? derivedHoursWorked
            : sre.hours_worked || undefined,
        employmentDegree: emp.employment_degree,
        taxTableNumber: emp.tax_table_number,
        taxColumn: emp.tax_column || 1,
        isSidoinkomst: emp.is_sidoinkomst,
        jamkningPercentage: emp.jamkning_percentage,
        jamkningValidFrom: emp.jamkning_valid_from,
        jamkningValidTo: emp.jamkning_valid_to,
        fSkattStatus: emp.f_skatt_status,
        extraTaxAmount: emp.extra_tax_amount ?? null,
        extraTaxPercentage: emp.extra_tax_percentage ?? null,
        personnummer: emp.personnummer,
        paymentDate: run.payment_date,
        vacationRule: emp.vacation_rule,
        vacationDaysPerYear: emp.vacation_days_per_year,
        semestertillaggRate: emp.semestertillagg_rate,
        vacationPayRate: emp.vacation_pay_rate ?? null,
        // Hourly pay's semesterlönegrundande frånvaro (Semesterlagen 16 b §);
        // absent when there is none, so such an input reads as before.
        qualifyingAbsenceHours: absenceResult.qualifyingAbsenceHours > 0 ? absenceResult.qualifyingAbsenceHours : undefined,
        dailyDivisor: dailyDivisor(emp.workdays_per_week),
        vaxaStodEligible: emp.vaxa_stod_eligible,
        vaxaStodStart: emp.vaxa_stod_start,
        vaxaStodEnd: emp.vaxa_stod_end,
        lineItems,
        periodStart,
        periodEnd,
        employmentStart: emp.employment_start,
        employmentEnd: emp.employment_end,
        roundNetToWholeKrona,
        calculationPolicy,
      },
      config,
      taxRates,
    )
    if (result.vaxaStodRefund) vaxaStodRefundEmployees.push(employeeName)
    // The breakdown names where the variable vacation pay came from, next to
    // the additions it is part of.
    if (variableVacationPayStep) {
      const grossIndex = result.steps.findIndex((step) => step.label === 'Bruttolön')
      result.steps.splice(grossIndex === -1 ? result.steps.length : grossIndex, 0, variableVacationPayStep)
    }
    // And every input of the pay derived from the vacation days, in the same
    // place, so a person can check each figure (vacation-days-pay.ts).
    if (vacationPaySteps.length > 0) {
      const grossIndex = result.steps.findIndex((step) => step.label === 'Bruttolön')
      result.steps.splice(grossIndex === -1 ? result.steps.length : grossIndex, 0, ...vacationPaySteps)
    }

    // Aggregated absence counts derived from per-day records.
    const sickDays = absenceResult.aggregated.sickDays
    const vabDays = absenceResult.aggregated.vabDays
    const parentalDays = absenceResult.aggregated.parentalDays
    const vacationDaysTaken = (sre.line_items || [])
      .filter((li: Record<string, unknown>) => li.item_type === 'vacation' && !isCalculatedLine(li))
      .reduce(
        (sum: number, li: Record<string, unknown>) => sum + ((li.quantity as number) || 0),
        0,
      )
    // The vacation lines hold days off; the ledger counts paid days. Frozen
    // on the row so a later change to the schedule never re-counts this
    // payslip's leave (Semesterlagen 12 a §, vacation-net-days.ts).
    const vacationPaidDaysPerDayOff = paidDaysPerDayOff(emp.vacation_days_per_year, emp.workdays_per_week)

    // Keep raw engine figures for the calculation trace, but snapshots and
    // run totals must use the same effective values (review-step overrides
    // applied) as the booking, the payslip and the bank file.
    const effective = effectiveRow({
      gross_salary: result.grossSalary,
      tax_withheld: result.taxWithheld,
      tax_withheld_override: sre.tax_withheld_override,
      net_salary: result.netSalary,
      avgifter_amount: result.avgifterAmount,
      avgifter_amount_override: sre.avgifter_amount_override,
      vacation_accrual: result.vacationAccrual,
      vacation_accrual_avgifter: result.vacationAccrualAvgifter,
      employee: { f_skatt_status: emp.f_skatt_status },
    })
    const effectiveTax = effective.tax_withheld
    const effectiveNet = effective.net_salary

    // 8g. Queue the per-employee row. Mirrors calendar-derived hours into the
    //     hours_worked snapshot column so downstream code (reports, storno via
    //     correct/route) sees a consistent value. Only these columns are
    //     written (step 9e): the inputs the calculation read, such as this
    //     month's salary, keep whatever was stored meanwhile.
    const snapshotHoursWorked =
      derivedHoursWorked !== null && derivedHoursWorked > 0
        ? derivedHoursWorked
        : sre.hours_worked
    const rosterColumns = {
      salary_type: emp.salary_type,
      hours_worked: snapshotHoursWorked,
      gross_salary: result.grossSalary,
      gross_deductions: result.grossDeductions,
      benefit_values: result.benefitValues,
      taxable_income: result.taxableIncome,
      tax_withheld: result.taxWithheld,
      // The förhöjt skatteavdrag part of tax_withheld, frozen so a payslip
      // downloaded again later prints the same split (lib/salary/extra-tax.ts).
      extra_tax_withheld: result.extraTaxWithheld,
      net_deductions: result.netDeductions,
      net_salary: result.netSalary,
      avgifter_rate: result.avgifterRate,
      avgifter_amount: result.avgifterAmount,
      avgifter_basis: result.avgifterBasis,
      avgifter_category: result.avgifterCategory,
      vacation_accrual: result.vacationAccrual,
      vacation_accrual_avgifter: result.vacationAccrualAvgifter,
      tax_table_number: emp.tax_table_number,
      tax_column: emp.tax_column,
      tax_table_year: paymentYear,
      sick_days: sickDays,
      vab_days: vabDays,
      parental_days: parentalDays,
      vacation_days_taken: vacationDaysTaken,
      vacation_paid_days_per_day_off: vacationPaidDaysPerDayOff,
      calculation_breakdown: { steps: result.steps },
      ytd_gross: roundOre((ytdByEmployee.get(sre.employee_id)?.gross || 0) + result.grossSalary),
      ytd_tax: roundOre((ytdByEmployee.get(sre.employee_id)?.tax || 0) + effectiveTax),
      ytd_net: ytdByEmployee.get(sre.employee_id)?.net === null ? null : roundOre((ytdByEmployee.get(sre.employee_id)?.net ?? 0) + effectiveNet),
    }
    rosterWrites.push({ id: sre.id, columns: rosterColumns })

    // 8h. The engine's own 'semesterersattning' line item (derived on every
    //     calculate). Replaced by provenance, not by item_type: a
    //     semesterersättning line the operator entered by hand (final
    //     settlement, engångsskatt) survives and was fed to the engine above.
    const vacationCompensationRows: Array<Record<string, unknown>> = []
    if (result.vacationCompensation > 0) {
      vacationCompensationRows.push({
        salary_run_employee_id: sre.id,
        company_id: companyId,
        item_type: 'semesterersattning',
        calculation_source: VACATION_COMPENSATION_SOURCE,
        description: 'Semesterersättning',
        quantity: 1,
        amount: Math.round(result.vacationCompensation * 100) / 100,
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: false,
        is_gross_deduction: false,
        is_net_deduction: false,
        account_number: null,
        sort_order: 50,
      })
    }

    // 8i. The derived 'oresavrundning' line item. All flags false: the
    //     rounding is not pay, not tax base, not avgift basis; it exists so
    //     the payslip shows the whole-krona step and the booking gets its 3740
    //     debit (credit when net_rounding = nearest rounded down). The old row
    //     is deleted unconditionally (step 9c) so toggling the setting off (or
    //     a net that lands on a whole krona) leaves no stale row behind.
    const roundingRows: Array<Record<string, unknown>> = []
    if (result.netRounding !== 0) {
      roundingRows.push({
        salary_run_employee_id: sre.id,
        company_id: companyId,
        item_type: 'oresavrundning',
        description: 'Öresavrundning',
        quantity: 1,
        amount: Math.round(result.netRounding * 100) / 100,
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_gross_deduction: false,
        is_net_deduction: false,
        account_number: null,
        sort_order: 900,
      })
    }

    derivedLineRows.push(
      ...hourlyLineRows,
      ...derivedBenefitRows,
      ...derivedRecurringRows,
      ...absenceRows,
      ...derivedPremiumRows,
      ...vacationCompensationRows,
      ...variableVacationPayRows,
      ...vacationPayRows,
      ...roundingRows,
    )

    totalGross += result.grossSalary
    totalTax += effectiveTax
    totalNet += effectiveNet
    totalAvgifter += effective.avgifter_amount
    totalVacationAccrual += result.vacationAccrual
    totalEmployerCost += effective.employer_cost
  }

  // 8z. Vacation days that could not be priced: refuse the run, naming every
  //     employee and what to do, before anything is written.
  if (vacationPayIssues.length > 0) {
    return {
      ok: false,
      code: 'SALARY_RUN_VACATION_PAY_UNDETERMINED',
      details: { reason: 'vacation_pay_undetermined', issues: vacationPayIssues },
      messageSv: vacationPayIssues.map((issue) => `${issue.employee}: ${issue.message}`).join(' '),
      messageEn: vacationPayIssues.map((issue) => `${issue.employee}: ${issue.message_en}`).join(' '),
    }
  }

  // 9. Write what the loop derived. Every employee was priced without a
  //    refusal, so from here the writes are the whole calculation: a handful
  //    of statements whatever the roster size, one update per roster row,
  //    and the per-employee display fixes that only touch rows when
  //    something changed. Each write that
  //    fails stops the calculation with DATABASE_ERROR and leaves the run in
  //    draft without its totals, as a failure part-way through the old
  //    per-employee loop did; the next calculation deletes and rewrites every
  //    derived row, so it repairs whatever a failed one left.
  //
  // 9a. Stale pay-type snapshots: new Grundlön/Timlön line, old one deleted,
  //     snapshot rewritten (lib/salary/base-salary-line.ts).
  for (const sre of staleSalaryTypeRows) {
    const emp = sre.employee
    const hourly = emp.salary_type === 'hourly'
    const { error: refreshError } = await refreshRunEmployeeSalaryType(supabase, {
      companyId,
      salaryRunEmployeeId: sre.id,
      salaryType: emp.salary_type,
      monthlySalary: runMonthlySalaryFor(emp),
      amount: hourly ? roundOre((emp.hourly_rate || 0) * (sre.hours_worked || 0)) : 0,
      quantity: hourly ? (sre.hours_worked ?? null) : null,
      unitPrice: hourly ? (emp.hourly_rate ?? null) : null,
    })
    if (refreshError) {
      return { ok: false, code: 'DATABASE_ERROR', details: refreshError }
    }
  }

  // 9b. Grundlön amounts that changed. Display-only, so, as before, a failed
  //     update does not fail the calculation: the next one rewrites it.
  for (const { salaryRunEmployeeId, amount } of monthlyLineAmounts) {
    await supabase
      .from('salary_line_items')
      .update({ amount })
      .eq('salary_run_employee_id', salaryRunEmployeeId)
      .eq('company_id', companyId)
      .eq('item_type', 'monthly_salary')
  }

  // 9c. Delete every row the calculation derives, for the whole roster: the
  //     calculated absence and premium types and the öresavrundning row, the
  //     förmån and recurring rows (by back-link), every row carrying the
  //     engine's provenance (its semesterersättning row and the vacation rows
  //     priced from vacation days: calculation_source is only ever written by
  //     the calculation, NULL is manual), and the Timlön rows the loop
  //     re-derived from the calendar. One statement each, one after the
  //     other (a query builder runs when it is awaited).
  const rosterRowIds = roster.map((sre) => sre.id as string)
  const derivedRowDeletes =
    rosterRowIds.length === 0
      ? []
      : [
          supabase
            .from('salary_line_items')
            .delete()
            .in('salary_run_employee_id', rosterRowIds)
            .eq('company_id', companyId)
            .in('item_type', [...DERIVED_ABSENCE_TYPES, ...DERIVED_PREMIUM_TYPES, 'oresavrundning']),
          supabase
            .from('salary_line_items')
            .delete()
            .in('salary_run_employee_id', rosterRowIds)
            .eq('company_id', companyId)
            .not('source_benefit_id', 'is', null),
          supabase
            .from('salary_line_items')
            .delete()
            .in('salary_run_employee_id', rosterRowIds)
            .eq('company_id', companyId)
            .not('source_recurring_line_id', 'is', null),
          supabase
            .from('salary_line_items')
            .delete()
            .in('salary_run_employee_id', rosterRowIds)
            .eq('company_id', companyId)
            .not('calculation_source', 'is', null),
          ...(hourlyLineRefreshIds.length === 0
            ? []
            : [
                supabase
                  .from('salary_line_items')
                  .delete()
                  .in('salary_run_employee_id', hourlyLineRefreshIds)
                  .eq('company_id', companyId)
                  .eq('item_type', 'hourly_salary'),
              ]),
        ]
  for (const statement of derivedRowDeletes) {
    const { error: deleteError } = await statement
    if (deleteError) {
      return { ok: false, code: 'DATABASE_ERROR', details: deleteError }
    }
  }

  // 9d. Every derived row in one insert, employee by employee in roster
  //     order. Rows without a back-link or provenance column get NULL there,
  //     which is the column default.
  if (derivedLineRows.length > 0) {
    const { error: insertError } = await supabase.from('salary_line_items').insert(derivedLineRows)
    if (insertError) {
      return { ok: false, code: 'DATABASE_ERROR', details: insertError }
    }
  }

  // 9e. Roster rows: one update each, carrying only the columns 8g
  //     computed. Not an upsert: its insert half needs every NOT NULL
  //     column (employment_degree, monthly_salary) and its update half
  //     would then write back the values read at the start over an edit
  //     made since. Ten at a time; the first failure in roster order is
  //     reported and no further batch starts.
  for (let offset = 0; offset < rosterWrites.length; offset += ROSTER_WRITE_CONCURRENCY) {
    const batch = rosterWrites.slice(offset, offset + ROSTER_WRITE_CONCURRENCY)
    const results = await Promise.all(
      batch.map(({ id: rowId, columns }) =>
        supabase.from('salary_run_employees').update(columns).eq('id', rowId).eq('company_id', companyId),
      ),
    )
    const rosterError = results.find((r) => r.error)?.error
    if (rosterError) {
      return { ok: false, code: 'DATABASE_ERROR', details: rosterError }
    }
  }

  // 10. Update run totals + freeze the calculation_params snapshot. The
  //     company's calculation conventions ride along under
  //     salary_calculation_policy so the run keeps the conventions it was
  //     calculated with when the company changes them later.
  const { data: updatedRun, error: updateError } = await supabase
    .from('salary_runs')
    .update({
      total_gross: Math.round(totalGross * 100) / 100,
      total_tax: Math.round(totalTax * 100) / 100,
      total_net: Math.round(totalNet * 100) / 100,
      total_avgifter: Math.round(totalAvgifter * 100) / 100,
      total_vacation_accrual: Math.round(totalVacationAccrual * 100) / 100,
      total_employer_cost: Math.round(totalEmployerCost * 100) / 100,
      calculation_params: {
        ...serializePayrollConfig(config),
        salary_calculation_policy: calculationPolicy,
        // Only when on, so a run calculated without it keeps its snapshot shape.
        ...(regionalSupport ? { [REGIONAL_SUPPORT_PARAM]: true } : {}),
      },
    })
    .eq('id', id)
    // Defense-in-depth: scope the write to the company explicitly. The
    // first SELECT confirmed `company_id = companyId` for this id, but the
    // CLAUDE.md rule is that every write carries the filter so the
    // intent is explicit at the SQL layer even if upstream code is later
    // refactored.
    .eq('company_id', companyId)
    .select()
    .single()

  if (updateError) {
    return { ok: false, code: 'DATABASE_ERROR', details: updateError }
  }

  // 11. Warnings: non-blocking annotations the caller should surface.
  const warnings: string[] = []
  if (taxTableSource === 'fallback') {
    warnings.push(
      `Skatteverkets skattetabell-API är inte nåbart: beräkningen använder lokal reservdata för ${paymentYear}. Kontrollera att Skatteverket inte publicerat ändringar innan lönekörningen bokförs.`,
    )
  } else if (taxTableSource === 'mixed') {
    warnings.push(
      `Skatteverkets skattetabell-API svarade bara delvis: vissa skattetabeller kommer från lokal reservdata för ${paymentYear}. Kontrollera att Skatteverket inte publicerat ändringar innan lönekörningen bokförs.`,
    )
  }
  if (lakarintygEmployees.length > 0) {
    warnings.push(
      `Läkarintyg krävs från och med dag 8: ${lakarintygEmployees.join(', ')}. ` +
        `Kontrollera att läkarintyg finns innan lönekörningen godkänns.`,
    )
  }
  if (fkReportingEmployees.length > 0) {
    warnings.push(
      `Försäkringskassan tar över sjuklön från dag 15: ${fkReportingEmployees.join(', ')}. ` +
        `Säkerställ att anmälan till FK är gjord.`,
    )
  }
  if (hourlyKarensEmployees.length > 0) {
    warnings.push(
      `Karensavdraget för timavlönade bygger på Timmar per vecka hos den anställde: ${hourlyKarensEmployees.join(', ')}. ` +
        `Är det inte den genomsnittliga veckoarbetstiden, ändra Timmar per vecka och beräkna om.`,
    )
  }
  const doubleAdjustmentWarning = doubleBenefitAdjustmentWarning(doubleBenefitAdjustments)
  if (doubleAdjustmentWarning) warnings.push(doubleAdjustmentWarning)
  const vaxaStodWarning = vaxaStodRefundWarning(vaxaStodRefundEmployees)
  if (vaxaStodWarning) warnings.push(vaxaStodWarning)
  if (variableVacationPayEmployees.length > 0) {
    warnings.push(
      `Semesterlön för rörliga lönedelar (Semesterlagen 16 a §) har lagts till för ${variableVacationPayEmployees.join(', ')}. ` +
        `Beloppet bygger på lönekörningarna i Accounted; ta bort en manuellt inlagd rad för samma ersättning så att den inte betalas två gånger.`,
    )
  }

  if (vacationDaysPayEmployees.length > 0) {
    warnings.push(
      `Semesterlön för uttagna semesterdagar har räknats fram för ${vacationDaysPayEmployees.join(', ')} ` +
        '(semestertillägg, semesterlön eller semesterlöneavdrag enligt semesterregeln). En semesterrad med eget belopp räknas inte om; ' +
        'ta bort en annan manuellt inlagd rad för samma ersättning så att den inte betalas två gånger.',
    )
  }

  opLog.info('salary calculation complete', {
    requestId,
    salaryRunId: id,
    warningCount: warnings.length,
    taxTableSource,
  })

  return { ok: true, run: updatedRun as Record<string, unknown>, warnings }
}
