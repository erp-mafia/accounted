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
 * The function does NOT advance the salary_runs status. That's the route's
 * responsibility: the dashboard leaves the run in `draft` (an explicit
 * `/review` verb does the freeze), while v1 collapses calculate+review into
 * a single verb. Routes layer the status transition on top of this result.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateSalary } from './calculation-engine'
import { loadPayrollConfig, serializePayrollConfig } from './payroll-config'
import { fetchAllTaxTableRatesForRun, TaxTableUnavailableError } from './tax-tables'
import { loadAndDeriveAbsence } from './derive-absence-line-items'
import { getLineItemAccount } from './account-mapping'
import { computePremiumLines } from './shift-premium-engine'
import type { WorkedDayShift } from './shift-premium-engine'
import type { Logger } from '@/lib/logger'
import type { SalaryLineItemType, ShiftPremiumRule, ShiftPremiumItemType } from '@/types'

/** Item types that the calculator derives from per-day absence records. */
const DERIVED_ABSENCE_TYPES: SalaryLineItemType[] = [
  'sick_karens',
  'sick_day2_14',
  'sick_day15_plus',
  'vab',
  'parental_leave',
  'unpaid_leave',
]

/**
 * Item types that the calculator derives from shift_premium_rules + worked
 * days. These are wiped at the start of each per-employee pass and
 * regenerated so the displayed line items always match the latest rules.
 */
const DERIVED_PREMIUM_TYPES: ShiftPremiumItemType[] = [
  'overtime_50',
  'overtime_100',
  'ob_weekday_evening',
  'ob_weekend',
  'ob_night',
  'ob_holiday',
]

/**
 * Effective hourly rate used as the base for shift-premium computation.
 *   - Hourly employees: their stored hourly_rate.
 *   - Monthly employees: monthly_salary / 173 (common Swedish derivation for
 *     full-time monthly → hourly, matches the timlön conventions used in
 *     CBAs). Applied even to part-timers since the engine multiplies by
 *     actually-worked premium hours.
 */
function effectiveHourlyRate(emp: {
  salary_type: 'monthly' | 'hourly'
  hourly_rate: number | null
  monthly_salary: number | null
}): number {
  if (emp.salary_type === 'hourly') return emp.hourly_rate || 0
  const monthly = emp.monthly_salary || 0
  return monthly > 0 ? Math.round((monthly / 173) * 100) / 100 : 0
}

/** Benefit-type → line-item-type mapping for the derived benefit rows. */
const BENEFIT_TYPE_TO_LINE_ITEM: Record<string, SalaryLineItemType> = {
  bike: 'benefit_bike',
  car: 'benefit_car',
  meals: 'benefit_meals',
  housing: 'benefit_housing',
  wellness: 'benefit_wellness',
  other: 'benefit_other',
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
  | { ok: false; code: string; details?: unknown; status?: number }

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

  // 2. Load year config.
  const config = await loadPayrollConfig(supabase, paymentYear)

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

  // 6. YTD aggregation across prior BOOKED runs in the same period_year.
  //    Drives the engine's progressive-tax + capped-avgift calculations.
  const { data: priorRuns } = await supabase
    .from('salary_run_employees')
    .select(
      'employee_id, gross_salary, tax_withheld, net_salary, salary_run:salary_runs!inner(period_year, period_month, status)',
    )
    .eq('company_id', companyId)
    .eq('salary_run.period_year', run.period_year)
    .eq('salary_run.status', 'booked')
    .lt('salary_run.period_month', run.period_month)

  const ytdByEmployee = new Map<string, { gross: number; tax: number; net: number }>()
  for (const prior of (priorRuns || []) as Array<{
    employee_id: string
    gross_salary: number
    tax_withheld: number
    net_salary: number
  }>) {
    const current = ytdByEmployee.get(prior.employee_id) || { gross: 0, tax: 0, net: 0 }
    current.gross += prior.gross_salary
    current.tax += prior.tax_withheld
    current.net += prior.net_salary
    ytdByEmployee.set(prior.employee_id, current)
  }

  // 7. Pay period bounds: used to load per-day absence + worked-day records.
  const periodYear = run.period_year as number
  const periodMonth = run.period_month as number
  const periodStart = `${periodYear}-${String(periodMonth).padStart(2, '0')}-01`
  const periodEndDate = new Date(Date.UTC(periodYear, periodMonth, 0)) // last day of month
  const periodEnd = periodEndDate.toISOString().slice(0, 10)

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

  // 8. Per-employee calculation loop.
  for (const sre of runEmployees) {
    const emp = sre.employee
    if (!emp) continue

    // 8a. Derive absence line items from per-day records.
    const absenceResult = await loadAndDeriveAbsence({
      supabase,
      companyId,
      employeeId: emp.id,
      monthlySalary: sre.monthly_salary || 0,
      payrollConfig: config,
      periodStart,
      periodEnd,
    })

    // 8b. For hourly employees, derive worked hours from the calendar.
    //     For all employees (when premium rules exist), the same rows feed
    //     the shift-premium engine in 8z below.
    let derivedHoursWorked: number | null = null
    let workedDayRows: Array<{ work_date: string; hours: number; start_time: string | null; end_time: string | null }> = []
    if (emp.salary_type === 'hourly' || premiumRules.length > 0) {
      const { data: workedDays, error: workedError } = await supabase
        .from('salary_worked_days')
        .select('hours, work_date, start_time, end_time')
        .eq('company_id', companyId)
        .eq('employee_id', emp.id)
        .gte('work_date', periodStart)
        .lte('work_date', periodEnd)
      if (workedError) {
        return { ok: false, code: 'DATABASE_ERROR', details: workedError }
      }
      workedDayRows = (workedDays ?? []) as typeof workedDayRows
    }
    if (emp.salary_type === 'hourly') {
      derivedHoursWorked = workedDayRows.reduce(
        (sum, d) => Math.round((sum + Number(d.hours)) * 100) / 100,
        0,
      )
      opLog.info('Derived hours_worked from calendar', {
        employeeId: emp.id,
        periodStart,
        periodEnd,
        rowCount: workedDayRows.length,
        derivedHoursWorked,
      })

      // Refresh the hourly_salary line item so the displayed Lönerader table
      // matches what the engine actually calculated.
      if (derivedHoursWorked > 0 && (emp.hourly_rate || 0) > 0) {
        const baseAmount =
          Math.round((emp.hourly_rate as number) * derivedHoursWorked * 100) / 100
        await supabase
          .from('salary_line_items')
          .delete()
          .eq('salary_run_employee_id', sre.id)
          .eq('item_type', 'hourly_salary')
        await supabase.from('salary_line_items').insert({
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
          account_number: getLineItemAccount('hourly_salary'),
          sort_order: 0,
        })
      }
    }

    // Refresh the monthly 'Grundlön' line so the displayed Lönerader table
    // matches the per-run monthly salary the engine actually uses. The engine
    // recomputes baseSalary from sre.monthly_salary (not from this line item),
    // so this update is display-only: it keeps the row consistent after the
    // user edits this month's salary on the draft.
    if (emp.salary_type === 'monthly') {
      const baseAmount =
        Math.round((sre.monthly_salary || 0) * (emp.employment_degree / 100) * 100) / 100
      await supabase
        .from('salary_line_items')
        .update({ amount: baseAmount })
        .eq('salary_run_employee_id', sre.id)
        .eq('company_id', companyId)
        .eq('item_type', 'monthly_salary')
    }

    const employeeName = `${emp.first_name} ${emp.last_name}`
    if (absenceResult.flagLakarintyg) lakarintygEmployees.push(employeeName)
    if (absenceResult.flagFkReporting) fkReportingEmployees.push(employeeName)

    // 8c. Replace derived absence rows.
    const { error: delAbsErr } = await supabase
      .from('salary_line_items')
      .delete()
      .eq('salary_run_employee_id', sre.id)
      .in('item_type', DERIVED_ABSENCE_TYPES)
    if (delAbsErr) {
      return { ok: false, code: 'DATABASE_ERROR', details: delAbsErr }
    }

    // 8d. Derive benefit line items from employee_benefits.
    const { data: activeBenefits, error: benefitsErr } = await supabase
      .from('employee_benefits')
      .select('id, benefit_type, description, monthly_value')
      .eq('employee_id', emp.id)
      .eq('company_id', companyId)
      .eq('is_active', true)
      .lte('valid_from', run.payment_date)
      .or(`valid_to.is.null,valid_to.gte.${run.payment_date}`)
    if (benefitsErr) {
      return { ok: false, code: 'DATABASE_ERROR', details: benefitsErr }
    }

    const { error: delBenefitErr } = await supabase
      .from('salary_line_items')
      .delete()
      .eq('salary_run_employee_id', sre.id)
      .not('source_benefit_id', 'is', null)
    if (delBenefitErr) {
      return { ok: false, code: 'DATABASE_ERROR', details: delBenefitErr }
    }

    const derivedBenefitRows = (activeBenefits ?? [])
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
          account_number: getLineItemAccount(itemType, emp.employment_type),
          sort_order: 200 + idx,
          source_benefit_id: b.id,
        }
      })

    if (derivedBenefitRows.length > 0) {
      const { error: insBenefitErr } = await supabase
        .from('salary_line_items')
        .insert(derivedBenefitRows)
      if (insBenefitErr) {
        return { ok: false, code: 'DATABASE_ERROR', details: insBenefitErr }
      }
    }

    if (absenceResult.lineItems.length > 0) {
      const rows = absenceResult.lineItems.map((li, idx) => ({
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
        account_number: getLineItemAccount(li.item_type),
        sort_order: 100 + idx,
      }))
      const { error: insAbsErr } = await supabase.from('salary_line_items').insert(rows)
      if (insAbsErr) {
        return { ok: false, code: 'DATABASE_ERROR', details: insAbsErr }
      }
    }

    // 8d2. Derive shift-premium rows (OB-tillägg, övertid 50/100). The engine
    //      consumes start_time/end_time when present; rows without explicit
    //      times fall back to a default 08:00-17:00 shift (no pure-night/
    //      pure-weekend rules trigger for those days). The premium rate is
    //      applied to the employee's effectiveHourlyRate so monthly
    //      employees still get OB by deriving an hourly rate as
    //      monthly_salary / 173.
    const { error: delPremiumErr } = await supabase
      .from('salary_line_items')
      .delete()
      .eq('salary_run_employee_id', sre.id)
      .in('item_type', DERIVED_PREMIUM_TYPES as unknown as string[])
    if (delPremiumErr) {
      return { ok: false, code: 'DATABASE_ERROR', details: delPremiumErr }
    }

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
      account_number: string
      sort_order: number
    }> = []

    if (premiumRules.length > 0 && workedDayRows.length > 0) {
      const baseHourlyRate = effectiveHourlyRate({
        salary_type: emp.salary_type,
        hourly_rate: emp.hourly_rate,
        monthly_salary: sre.monthly_salary,
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
        account_number: getLineItemAccount(line.itemType, emp.employment_type),
        sort_order: 300 + idx,
      }))
      if (derivedPremiumRows.length > 0) {
        const { error: insPremiumErr } = await supabase
          .from('salary_line_items')
          .insert(derivedPremiumRows)
        if (insPremiumErr) {
          return { ok: false, code: 'DATABASE_ERROR', details: insPremiumErr }
        }
      }
    }

    // 8e. Assemble the in-memory line item set fed to calculateSalary.
    const manualLineItems = (sre.line_items || [])
      .filter((li: Record<string, unknown>) => {
        if (DERIVED_ABSENCE_TYPES.includes(li.item_type as SalaryLineItemType)) return false
        if (DERIVED_PREMIUM_TYPES.includes(li.item_type as ShiftPremiumItemType)) return false
        if (li.source_benefit_id) return false
        if (li.item_type === 'semesterersattning') return false
        return true
      })
      .map((li: Record<string, unknown>) => ({
        itemType: li.item_type as SalaryLineItemType,
        amount: li.amount as number,
        isTaxable: li.is_taxable as boolean,
        isAvgiftBasis: li.is_avgift_basis as boolean,
        isVacationBasis: li.is_vacation_basis as boolean,
        isGrossDeduction: li.is_gross_deduction as boolean,
        isNetDeduction: li.is_net_deduction as boolean,
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
    const lineItems = [...manualLineItems, ...derivedLineItems, ...derivedBenefitLineItems, ...derivedPremiumLineItems]

    // 8f. Run the engine for this employee.
    const result = calculateSalary(
      {
        employmentType: emp.employment_type,
        salaryType: emp.salary_type,
        monthlySalary: sre.monthly_salary || 0,
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
        personnummer: emp.personnummer,
        paymentDate: run.payment_date,
        vacationRule: emp.vacation_rule,
        vacationDaysPerYear: emp.vacation_days_per_year,
        semestertillaggRate: emp.semestertillagg_rate,
        vaxaStodEligible: emp.vaxa_stod_eligible,
        vaxaStodStart: emp.vaxa_stod_start,
        vaxaStodEnd: emp.vaxa_stod_end,
        lineItems,
        periodStart,
        periodEnd,
        employmentStart: emp.employment_start,
        employmentEnd: emp.employment_end,
      },
      config,
      taxRates.map((r) => ({
        tableYear: r.tableYear,
        tableNumber: r.tableNumber,
        columnNumber: r.columnNumber,
        incomeFrom: r.incomeFrom,
        incomeTo: r.incomeTo,
        taxAmount: r.taxAmount,
      })),
    )

    // Aggregated absence counts derived from per-day records.
    const sickDays = absenceResult.aggregated.sickDays
    const vabDays = absenceResult.aggregated.vabDays
    const parentalDays = absenceResult.aggregated.parentalDays
    const vacationDays = (sre.line_items || [])
      .filter((li: Record<string, unknown>) => li.item_type === 'vacation')
      .reduce(
        (sum: number, li: Record<string, unknown>) => sum + ((li.quantity as number) || 0),
        0,
      )

    // 8g. Write the per-employee row. Mirrors calendar-derived hours into the
    //     hours_worked snapshot column so downstream code (reports, storno via
    //     correct/route) sees a consistent value.
    const snapshotHoursWorked =
      derivedHoursWorked !== null && derivedHoursWorked > 0
        ? derivedHoursWorked
        : sre.hours_worked
    const { error: empUpdateError } = await supabase
      .from('salary_run_employees')
      .update({
        hours_worked: snapshotHoursWorked,
        gross_salary: result.grossSalary,
        gross_deductions: result.grossDeductions,
        benefit_values: result.benefitValues,
        taxable_income: result.taxableIncome,
        tax_withheld: result.taxWithheld,
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
        vacation_days_taken: vacationDays,
        calculation_breakdown: { steps: result.steps },
        ytd_gross:
          Math.round(
            ((ytdByEmployee.get(sre.employee_id)?.gross || 0) + result.grossSalary) * 100,
          ) / 100,
        ytd_tax:
          Math.round(
            ((ytdByEmployee.get(sre.employee_id)?.tax || 0) + result.taxWithheld) * 100,
          ) / 100,
        ytd_net:
          Math.round(
            ((ytdByEmployee.get(sre.employee_id)?.net || 0) + result.netSalary) * 100,
          ) / 100,
      })
      .eq('id', sre.id)

    if (empUpdateError) {
      return { ok: false, code: 'DATABASE_ERROR', details: empUpdateError }
    }

    // 8h. Replace any existing 'semesterersattning' line item (the engine
    //     derives it on every calculate).
    const { error: delSemErr } = await supabase
      .from('salary_line_items')
      .delete()
      .eq('salary_run_employee_id', sre.id)
      .eq('item_type', 'semesterersattning')
    if (delSemErr) {
      return { ok: false, code: 'DATABASE_ERROR', details: delSemErr }
    }
    if (result.vacationCompensation > 0) {
      const { error: insSemErr } = await supabase.from('salary_line_items').insert({
        salary_run_employee_id: sre.id,
        company_id: companyId,
        item_type: 'semesterersattning',
        description: 'Semesterersättning',
        quantity: 1,
        amount: Math.round(result.vacationCompensation * 100) / 100,
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: false,
        is_gross_deduction: false,
        is_net_deduction: false,
        account_number: getLineItemAccount('semesterersattning', emp.employment_type),
        sort_order: 50,
      })
      if (insSemErr) {
        return { ok: false, code: 'DATABASE_ERROR', details: insSemErr }
      }
    }

    totalGross += result.grossSalary
    totalTax += result.taxWithheld
    totalNet += result.netSalary
    totalAvgifter += result.avgifterAmount
    totalVacationAccrual += result.vacationAccrual
    totalEmployerCost += result.totalEmployerCost
  }

  // 9. Update run totals + freeze the calculation_params snapshot.
  const { data: updatedRun, error: updateError } = await supabase
    .from('salary_runs')
    .update({
      total_gross: Math.round(totalGross * 100) / 100,
      total_tax: Math.round(totalTax * 100) / 100,
      total_net: Math.round(totalNet * 100) / 100,
      total_avgifter: Math.round(totalAvgifter * 100) / 100,
      total_vacation_accrual: Math.round(totalVacationAccrual * 100) / 100,
      total_employer_cost: Math.round(totalEmployerCost * 100) / 100,
      calculation_params: serializePayrollConfig(config),
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

  // 10. Warnings: non-blocking annotations the caller should surface.
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

  opLog.info('salary calculation complete', {
    requestId,
    salaryRunId: id,
    warningCount: warnings.length,
    taxTableSource,
  })

  return { ok: true, run: updatedRun as Record<string, unknown>, warnings }
}
