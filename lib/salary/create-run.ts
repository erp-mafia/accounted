import type { SupabaseClient } from '@supabase/supabase-js'
import { getLineItemAccount } from './account-mapping'

export interface CreateSalaryRunResult {
  run: Record<string, unknown>
  employeeCount: number
}

/**
 * Thrown when the period already has a non-corrected run. Carries the
 * existing run's id and status so every caller (dashboard route, MCP
 * executor) can point the user at it instead of at a bare conflict: the
 * digest's "already exists but no way to find it" gap.
 */
export class SalaryRunExistsError extends Error {
  readonly existingId: string | null
  readonly existingStatus: string | null

  constructor(existingId: string | null, existingStatus: string | null) {
    super(
      existingId
        ? `Salary run already exists for this period (id ${existingId}, status ${existingStatus ?? 'unknown'})`
        : 'Salary run already exists for this period',
    )
    this.name = 'SalaryRunExistsError'
    this.existingId = existingId
    this.existingStatus = existingStatus
  }
}

/**
 * Create a draft salary run and seed a base line for every active employee.
 *
 * There is no single-statement RPC for this fan-out, so it is not atomic at the
 * DB level. To avoid leaving a half-populated run behind on a mid-loop failure,
 * we compensating-delete the parent run on any error: FK cascade
 * (salary_run_employees → salary_runs, salary_line_items → salary_run_employees,
 * both ON DELETE CASCADE) cleans up any children already inserted.
 *
 * Extracted so the MCP tool and any future route share one implementation.
 */
export async function createSalaryRunWithEmployees(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: {
    periodYear: number
    periodMonth: number
    paymentDate: string
    voucherSeries?: string
    notes?: string
  },
): Promise<CreateSalaryRunResult> {
  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .insert({
      company_id: companyId,
      user_id: userId,
      period_year: params.periodYear,
      period_month: params.periodMonth,
      payment_date: params.paymentDate,
      // Omitted → DB defaults ('A' / NULL) so the MCP commit path is unchanged.
      ...(params.voucherSeries ? { voucher_series: params.voucherSeries } : {}),
      ...(params.notes ? { notes: params.notes } : {}),
    })
    .select()
    .single()
  if (runError || !run) {
    if (runError?.code === '23505') {
      // The partial unique index (status != 'corrected') guarantees at most
      // one live run per period; surface it so the caller can continue with
      // gnubok_get_salary_run / the run page instead of guessing.
      const { data: existing } = await supabase
        .from('salary_runs')
        .select('id, status')
        .eq('company_id', companyId)
        .eq('period_year', params.periodYear)
        .eq('period_month', params.periodMonth)
        .neq('status', 'corrected')
        .limit(1)
        .maybeSingle()
      const row = (existing ?? null) as { id: string; status: string } | null
      throw new SalaryRunExistsError(row?.id ?? null, row?.status ?? null)
    }
    throw new Error(runError?.message ?? 'Failed to create salary run')
  }

  try {
    const { data: employees } = await supabase
      .from('employees')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', true)

    // Pay period bounds (inclusive): used to skip employees whose employment
    // does not overlap the run. employment_start is NOT NULL on employees;
    // employment_end is nullable for ongoing employments.
    const periodStart = `${params.periodYear}-${String(params.periodMonth).padStart(2, '0')}-01`
    const periodEnd = new Date(Date.UTC(params.periodYear, params.periodMonth, 0))
      .toISOString()
      .slice(0, 10)

    const eligibleEmployees = (employees || []).filter((emp) => {
      if (emp.employment_start && emp.employment_start > periodEnd) return false
      if (emp.employment_end && emp.employment_end < periodStart) return false
      return true
    })

    for (const emp of eligibleEmployees) {
      const baseAmount =
        emp.salary_type === 'monthly'
          ? Math.round((emp.monthly_salary || 0) * (emp.employment_degree / 100) * 100) / 100
          : 0

      const { data: sre, error: sreErr } = await supabase
        .from('salary_run_employees')
        .insert({
          salary_run_id: run.id,
          employee_id: emp.id,
          company_id: companyId,
          employment_degree: emp.employment_degree,
          monthly_salary: emp.monthly_salary || 0,
          salary_type: emp.salary_type,
          tax_table_number: emp.tax_table_number,
          tax_column: emp.tax_column,
        })
        .select()
        .single()
      if (sreErr || !sre) {
        throw new Error(`Failed to add employee ${emp.id}: ${sreErr?.message ?? 'unknown error'}`)
      }

      const itemType = emp.salary_type === 'monthly' ? 'monthly_salary' : 'hourly_salary'
      const { error: liErr } = await supabase.from('salary_line_items').insert({
        salary_run_employee_id: sre.id,
        company_id: companyId,
        item_type: itemType,
        description: emp.salary_type === 'monthly' ? 'Grundlön' : 'Timlön',
        amount: baseAmount,
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: true,
        account_number: getLineItemAccount(itemType as never, emp.employment_type),
        sort_order: 0,
      })
      if (liErr) {
        throw new Error(`Failed to add base line for employee ${emp.id}: ${liErr.message}`)
      }
    }

    return { run: run as Record<string, unknown>, employeeCount: eligibleEmployees.length }
  } catch (err) {
    // Compensating delete: never leave a half-populated run. Cascade removes
    // any salary_run_employees / salary_line_items already inserted.
    await supabase.from('salary_runs').delete().eq('id', run.id).eq('company_id', companyId)
    throw err
  }
}
