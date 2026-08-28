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
import type { SalaryLineItemType } from '@/types'

export type RunEmployeeResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown> }

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
): Promise<RunEmployeeResult<{ id: string; status: string }>> {
  const { data: run, error } = await supabase
    .from('salary_runs')
    .select('id, status')
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
  return { ok: true, data: run as { id: string; status: string } }
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
    monthlySalary: number
    /** Validate + resolve only; return the would-be change without writing. */
    dryRun?: boolean
  },
): Promise<RunEmployeeResult<SetRunSalaryData>> {
  if (!Number.isFinite(args.monthlySalary) || args.monthlySalary < 0) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'monthly_salary' } }
  }
  const gate = await assertRunDraftForRoster(supabase, args.companyId, args.salaryRunId)
  if (!gate.ok) return gate

  const monthly = roundOre(args.monthlySalary)

  const { data: sre, error: sreError } = await supabase
    .from('salary_run_employees')
    .select('id, employee_id, salary_type, employment_degree, monthly_salary')
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

  const row = sre as {
    id: string
    employee_id: string
    salary_type: string
    employment_degree: number
    monthly_salary: number
  }

  const data: SetRunSalaryData = {
    salary_run_employee_id: row.id,
    employee_id: row.employee_id,
    salary_type: row.salary_type,
    employment_degree: row.employment_degree,
    previous_monthly_salary: row.monthly_salary,
    monthly_salary: monthly,
  }

  if (args.dryRun) {
    return { ok: true, data }
  }

  const { error: updError } = await supabase
    .from('salary_run_employees')
    .update({ monthly_salary: monthly })
    .eq('id', row.id)
    .eq('company_id', args.companyId)

  if (updError) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: updError.message } }
  }

  // Keep the displayed 'Grundlön' line consistent before the next calculation.
  // Display-only: the engine recomputes baseSalary from monthly_salary at calc
  // time, but this avoids a stale row until then.
  if (row.salary_type === 'monthly') {
    const baseAmount = roundOre(monthly * (row.employment_degree / 100))
    const { error: lineError } = await supabase
      .from('salary_line_items')
      .update({ amount: baseAmount })
      .eq('salary_run_employee_id', row.id)
      .eq('company_id', args.companyId)
      .eq('item_type', 'monthly_salary')
    if (lineError) {
      return { ok: false, code: 'INTERNAL_ERROR', details: { message: lineError.message } }
    }
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
