/**
 * Shared salary-run roster commands: attach/remove an employee on a DRAFT run.
 *
 * Single source of truth consumed by the internal dashboard routes
 * (app/api/salary/runs/[id]/employees/**) and the v1 REST routes. Attaching
 * snapshots the employee's pay config onto salary_run_employees (so later
 * employee edits don't retroactively change an open run) and seeds the base
 * salary line item.
 *
 * Result-object convention mirrors lib/salary/run-calculation.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getLineItemAccount } from '@/lib/salary/account-mapping'
import { roundOre } from '@/lib/money'
import { SALARY_OVERRIDE_MAX } from '@/lib/api/schemas'
import type { SalaryLineItemType } from '@/types'

export type RunEmployeeResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown> }

/** Upper bound for hours in one pay month: 31 days of 24 hours. */
export const HOURS_WORKED_MAX = 744

export interface SalaryRunEmployeeRow {
  id: string
  salary_run_id: string
  employee_id: string
  company_id: string
  employment_degree: number
  monthly_salary: number
  salary_type: string
  hours_worked: number | null
  tax_table_number: number | null
  tax_column: number | null
  created_at: string
  updated_at: string
}

async function assertRunDraftForRoster(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunId: string,
): Promise<RunEmployeeResult<{ id: string; status: string; period_year: number; period_month: number }>> {
  const { data: run, error } = await supabase
    .from('salary_runs')
    .select('id, status, period_year, period_month')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  if (!run) {
    return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  }
  if ((run as { status: string }).status !== 'draft') {
    return {
      ok: false,
      code: 'SALARY_RUN_EMPLOYEES_NOT_DRAFT',
      details: { current_status: (run as { status: string }).status },
    }
  }
  return { ok: true, data: run as { id: string; status: string; period_year: number; period_month: number } }
}

export async function addEmployeeToRun(
  supabase: SupabaseClient,
  args: {
    companyId: string
    salaryRunId: string
    employeeId: string
    hoursWorked?: number | null
    /** Validate + resolve only; return the would-be snapshot without writing. */
    dryRun?: boolean
  },
): Promise<RunEmployeeResult<SalaryRunEmployeeRow | (Omit<SalaryRunEmployeeRow, 'id' | 'created_at' | 'updated_at'> & { id: null })>> {
  const gate = await assertRunDraftForRoster(supabase, args.companyId, args.salaryRunId)
  if (!gate.ok) return gate

  const { data: employee, error: empError } = await supabase
    .from('employees')
    .select(
      'id, employment_degree, monthly_salary, hourly_rate, salary_type, employment_type, tax_table_number, tax_column',
    )
    .eq('id', args.employeeId)
    .eq('company_id', args.companyId)
    .eq('is_active', true)
    .maybeSingle()

  if (empError) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: empError.message } }
  }
  if (!employee) {
    return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
  }

  const { data: existing, error: dupError } = await supabase
    .from('salary_run_employees')
    .select('id')
    .eq('salary_run_id', args.salaryRunId)
    .eq('employee_id', args.employeeId)
    .maybeSingle()

  if (dupError) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: dupError.message } }
  }
  if (existing) {
    return {
      ok: false,
      code: 'SALARY_RUN_EMPLOYEE_DUPLICATE',
      details: { salary_run_employee_id: (existing as { id: string }).id },
    }
  }

  const emp = employee as {
    id: string
    employment_degree: number
    monthly_salary: number | null
    hourly_rate: number | null
    salary_type: string
    employment_type: string
    tax_table_number: number | null
    tax_column: number | null
  }

  const snapshot = {
    salary_run_id: args.salaryRunId,
    employee_id: emp.id,
    company_id: args.companyId,
    employment_degree: emp.employment_degree,
    monthly_salary: emp.monthly_salary || 0,
    salary_type: emp.salary_type,
    hours_worked: args.hoursWorked ?? null,
    tax_table_number: emp.tax_table_number,
    tax_column: emp.tax_column,
  }

  if (args.dryRun) {
    return { ok: true, data: { ...snapshot, id: null } }
  }

  const { data: sre, error: sreError } = await supabase
    .from('salary_run_employees')
    .insert(snapshot)
    .select()
    .single()

  if (sreError) {
    // Race with a concurrent attach: the pre-flight passed but the insert
    // tripped the unique constraint.
    if ((sreError as { code?: string }).code === '23505') {
      return { ok: false, code: 'SALARY_RUN_EMPLOYEE_DUPLICATE' }
    }
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: sreError.message } }
  }

  // Seed the base salary line so the run displays a sensible gross before
  // the first :calculate.
  const baseSalaryType: SalaryLineItemType =
    emp.salary_type === 'monthly' ? 'monthly_salary' : 'hourly_salary'
  const baseAmount =
    emp.salary_type === 'monthly'
      ? roundOre((emp.monthly_salary || 0) * (emp.employment_degree / 100))
      : roundOre((emp.hourly_rate || 0) * (args.hoursWorked || 0))

  const { error: lineError } = await supabase.from('salary_line_items').insert({
    salary_run_employee_id: (sre as { id: string }).id,
    company_id: args.companyId,
    item_type: baseSalaryType,
    description: emp.salary_type === 'monthly' ? 'Grundlön' : 'Timlön',
    quantity: emp.salary_type === 'hourly' ? args.hoursWorked ?? null : null,
    unit_price: emp.salary_type === 'hourly' ? emp.hourly_rate : null,
    amount: baseAmount,
    is_taxable: true,
    is_avgift_basis: true,
    is_vacation_basis: true,
    account_number: getLineItemAccount(baseSalaryType, emp.employment_type as never),
    sort_order: 0,
  })

  if (lineError) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: lineError.message } }
  }

  return { ok: true, data: sre as unknown as SalaryRunEmployeeRow }
}

export interface SetRunSalaryData {
  salary_run_employee_id: string
  employee_id: string
  salary_type: string
  employment_degree: number
  previous_monthly_salary: number
  monthly_salary: number
  /** Hourly employees: the per-run hours before and after this change. */
  previous_hours_worked: number | null
  hours_worked: number | null
  /** Hourly employees: the rate the Timlön display line is priced at. */
  hourly_rate: number | null
}

/**
 * Set THIS RUN's base salary for one employee (salary_run_employees.monthly_salary),
 * leaving the employee master record untouched. Draft runs only. 0 is valid
 * (an intentional nollkörning). The calculation engine reads this per-run value,
 * so the displayed 'Grundlön' line refresh here is display-only; a recalculation
 * derives gross from the column, never from the line.
 */
export async function setRunEmployeeSalary(
  supabase: SupabaseClient,
  args: {
    companyId: string
    salaryRunId: string
    employeeId: string
    /** Monthly-paid employees: this run's gross base salary. */
    monthlySalary?: number
    /** Hourly-paid employees: this run's hours (only when the period has no
     * calendar days, which the calculation would otherwise derive from). */
    hoursWorked?: number
    /** Validate + resolve only; return the would-be change without writing. */
    dryRun?: boolean
  },
): Promise<RunEmployeeResult<SetRunSalaryData>> {
  const hasMonthly = args.monthlySalary !== undefined
  const hasHours = args.hoursWorked !== undefined
  if (hasMonthly === hasHours) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { message: 'Pass exactly one of monthly_salary or hours_worked' },
    }
  }
  // Single enforcement point for the bounds: the cookie route's Zod schema,
  // the v1 body schema and the MCP tool all funnel through here. The salary
  // cap also keeps roundOre far away from Infinity (1e307 * 100 overflows).
  if (
    hasMonthly &&
    (!Number.isFinite(args.monthlySalary) ||
      (args.monthlySalary as number) < 0 ||
      (args.monthlySalary as number) > SALARY_OVERRIDE_MAX)
  ) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'monthly_salary', max: SALARY_OVERRIDE_MAX },
    }
  }
  if (
    hasHours &&
    (!Number.isFinite(args.hoursWorked) ||
      (args.hoursWorked as number) < 0 ||
      (args.hoursWorked as number) > HOURS_WORKED_MAX)
  ) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'hours_worked', max: HOURS_WORKED_MAX },
    }
  }
  const gate = await assertRunDraftForRoster(supabase, args.companyId, args.salaryRunId)
  if (!gate.ok) return gate

  const { data: sre, error: sreError } = await supabase
    .from('salary_run_employees')
    .select('id, employee_id, salary_type, employment_degree, monthly_salary, hours_worked')
    .eq('salary_run_id', args.salaryRunId)
    .eq('employee_id', args.employeeId)
    .eq('company_id', args.companyId)
    .maybeSingle()

  if (sreError) {
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      details: { message: sreError.message, code: sreError.code },
    }
  }
  if (!sre) {
    return { ok: false, code: 'SALARY_RUN_EMPLOYEE_NOT_FOUND' }
  }

  const row = sre as {
    id: string
    employee_id: string
    salary_type: string
    employment_degree: number
    monthly_salary: number
    hours_worked: number | null
  }

  // The field must match how the employee is paid: a monthly figure on an
  // hourly row would be ignored by the engine (hourly gross = rate x hours)
  // and hours on a monthly row would never price anything.
  if ((hasMonthly && row.salary_type !== 'monthly') || (hasHours && row.salary_type !== 'hourly')) {
    return {
      ok: false,
      code: 'SALARY_RUN_SALARY_FIELD_MISMATCH',
      details: { salary_type: row.salary_type },
    }
  }

  const monthly = hasMonthly ? roundOre(args.monthlySalary as number) : row.monthly_salary
  const hours = hasHours ? roundOre(args.hoursWorked as number) : row.hours_worked
  let hourlyRate: number | null = null

  if (hasHours) {
    // Calendar days win at calculation time (run-calculation derives
    // hours_worked from salary_worked_days when any exist in the period), so
    // a per-run override would be silently discarded. Refuse instead of
    // staging a change that cannot take effect.
    const periodStart = `${gate.data.period_year}-${String(gate.data.period_month).padStart(2, '0')}-01`
    const periodEnd = new Date(Date.UTC(gate.data.period_year, gate.data.period_month, 0))
      .toISOString()
      .slice(0, 10)
    const { data: workedDays, error: workedError } = await supabase
      .from('salary_worked_days')
      .select('hours')
      .eq('company_id', args.companyId)
      .eq('employee_id', args.employeeId)
      .gte('work_date', periodStart)
      .lte('work_date', periodEnd)
    if (workedError) {
      return { ok: false, code: 'INTERNAL_ERROR', details: { message: workedError.message } }
    }
    const calendarHours = ((workedDays ?? []) as Array<{ hours: number | string }>).reduce(
      (sum, d) => roundOre(sum + Number(d.hours)),
      0,
    )
    if (calendarHours > 0) {
      return {
        ok: false,
        code: 'SALARY_RUN_HOURS_FROM_CALENDAR',
        details: { calendar_hours: calendarHours, period_start: periodStart, period_end: periodEnd },
      }
    }

    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select('hourly_rate')
      .eq('id', args.employeeId)
      .eq('company_id', args.companyId)
      .maybeSingle()
    if (empError) {
      return { ok: false, code: 'INTERNAL_ERROR', details: { message: empError.message } }
    }
    hourlyRate = (employee as { hourly_rate: number | null } | null)?.hourly_rate ?? null
  }

  const data: SetRunSalaryData = {
    salary_run_employee_id: row.id,
    employee_id: row.employee_id,
    salary_type: row.salary_type,
    employment_degree: row.employment_degree,
    previous_monthly_salary: row.monthly_salary,
    monthly_salary: monthly,
    previous_hours_worked: row.hours_worked,
    hours_worked: hours,
    hourly_rate: hourlyRate,
  }

  if (args.dryRun) {
    return { ok: true, data }
  }

  // Clearing calculation_breakdown is what makes a stale booking impossible:
  // both book preflights (MCP gnubok_book_salary_run and the v1/UI path via
  // advanceAndBookSalaryRun) refuse roster rows without a breakdown, so a
  // salary change after a calculation forces a recalculation before booking
  // instead of silently booking gross/tax derived from the old salary.
  const { error: updError } = await supabase
    .from('salary_run_employees')
    .update(
      hasHours
        ? { hours_worked: hours, calculation_breakdown: null }
        : { monthly_salary: monthly, calculation_breakdown: null },
    )
    .eq('id', row.id)
    .eq('company_id', args.companyId)

  if (updError) {
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      details: { message: updError.message, code: updError.code },
    }
  }

  // Keep the displayed 'Grundlön' line consistent before the next calculation.
  // Display-only: the engine recomputes baseSalary from monthly_salary at calc
  // time, and the next calculation rewrites this row anyway, so a failure here
  // must not fail the request: the salary write above has already committed,
  // and reporting failure for an applied change is worse than a briefly stale
  // display row (matches the pre-refactor route behavior).
  if (hasMonthly) {
    const baseAmount = roundOre(monthly * (row.employment_degree / 100))
    await supabase
      .from('salary_line_items')
      .update({ amount: baseAmount })
      .eq('salary_run_employee_id', row.id)
      .eq('company_id', args.companyId)
      .eq('item_type', 'monthly_salary')
  } else {
    const baseAmount = roundOre((hourlyRate || 0) * (hours || 0))
    await supabase
      .from('salary_line_items')
      .update({ amount: baseAmount, quantity: hours, unit_price: hourlyRate })
      .eq('salary_run_employee_id', row.id)
      .eq('company_id', args.companyId)
      .eq('item_type', 'hourly_salary')
  }

  return { ok: true, data }
}

export async function removeEmployeeFromRun(
  supabase: SupabaseClient,
  args: {
    companyId: string
    salaryRunId: string
    employeeId: string
    /** Validate + resolve only; do not delete. */
    dryRun?: boolean
  },
): Promise<RunEmployeeResult<{ deleted: true; employee_id: string }>> {
  const gate = await assertRunDraftForRoster(supabase, args.companyId, args.salaryRunId)
  if (!gate.ok) return gate

  const { data: sre, error: sreError } = await supabase
    .from('salary_run_employees')
    .select('id')
    .eq('salary_run_id', args.salaryRunId)
    .eq('employee_id', args.employeeId)
    .eq('company_id', args.companyId)
    .maybeSingle()

  if (sreError) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: sreError.message } }
  }
  if (!sre) {
    return { ok: false, code: 'SALARY_RUN_EMPLOYEE_NOT_FOUND' }
  }

  if (args.dryRun) {
    return { ok: true, data: { deleted: true, employee_id: args.employeeId } }
  }

  // Cascades to salary_line_items via ON DELETE CASCADE.
  const { error } = await supabase
    .from('salary_run_employees')
    .delete()
    .eq('salary_run_id', args.salaryRunId)
    .eq('employee_id', args.employeeId)
    .eq('company_id', args.companyId)

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  return { ok: true, data: { deleted: true, employee_id: args.employeeId } }
}
