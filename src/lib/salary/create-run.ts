import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveDefaultSeriesForSource } from '@/lib/bookkeeping/voucher-series-resolver'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import { degreeAdjustedMonthlySalary } from './work-schedule'
import { runMonthlySalaryFor } from './base-salary-line'
import { baseSalaryLineType, payslipLineFlags } from './line-item-roles'
import {
  assertNoDeviationOverlap,
  resolveDeviationWindowForNewRun,
  type DateWindow,
} from './deviation-period'

export interface CreateSalaryRunResult {
  run: Record<string, unknown>
  employeeCount: number
  /** The avvikelseperiod snapshotted on the run (absence + worked days are read from it). */
  deviationWindow: DateWindow
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

const log = createLogger('salary/create-run')

/**
 * The verifikationsserie a new salary run books into: the explicit letter
 * when the caller sent one, else the company's own salary series
 * (default_voucher_series_per_source_type.salary_payment, the map the
 * systemdokumentation publishes; 'A' for a company without one). One rule
 * for the dashboard, v1 and MCP, so an agent or an integration never books
 * lön into another series than the company documented. A failed settings
 * read throws: guessing 'A' would book into the wrong series.
 */
export async function resolveSalaryRunSeries(
  supabase: SupabaseClient,
  companyId: string,
  explicit?: string | null,
): Promise<string> {
  if (explicit) return explicit
  const { data, error } = await supabase
    .from('company_settings')
    .select('default_voucher_series_per_source_type')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to load voucher series settings: ${error.message}`)
  }
  return resolveDefaultSeriesForSource(
    (data ?? null) as Parameters<typeof resolveDefaultSeriesForSource>[0],
    'salary_payment',
  )
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
 * The avvikelseperiod is resolved here too (explicit dates win, else the
 * company setting) and refused when it overlaps another live run, so every
 * creation path (dashboard, MCP, correction) gets the same guard. Throws
 * SalaryDeviationPeriodError for an invalid or overlapping window.
 *
 * The series follows resolveSalaryRunSeries, and salary_run.created is
 * emitted here once the run exists, so every door (dashboard, v1, MCP
 * approval) books into the same series and fires the same event.
 * seedEmployees false leaves the roster empty: v1 documents an empty run
 * that the caller fills with POST /salary-runs/{id}/employees.
 */
export async function createSalaryRunWithEmployees(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: {
    periodYear: number
    periodMonth: number
    paymentDate: string
    /** Explicit verifikationsserie. Omit to use the company's salary series. */
    voucherSeries?: string
    notes?: string
    /** Explicit avvikelseperiod (both or neither). Omit to use the company setting. */
    deviationPeriodStart?: string | null
    deviationPeriodEnd?: string | null
    /** Seed a base line per eligible employee (default true). */
    seedEmployees?: boolean
  },
): Promise<CreateSalaryRunResult> {
  const { window: deviationWindow } = await resolveDeviationWindowForNewRun(supabase, companyId, {
    periodYear: params.periodYear,
    periodMonth: params.periodMonth,
    explicitStart: params.deviationPeriodStart,
    explicitEnd: params.deviationPeriodEnd,
  })
  await assertNoDeviationOverlap(supabase, companyId, deviationWindow)
  const voucherSeries = await resolveSalaryRunSeries(supabase, companyId, params.voucherSeries)

  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .insert({
      company_id: companyId,
      user_id: userId,
      period_year: params.periodYear,
      period_month: params.periodMonth,
      payment_date: params.paymentDate,
      deviation_period_start: deviationWindow.start,
      deviation_period_end: deviationWindow.end,
      voucher_series: voucherSeries,
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

  let employeeCount = 0
  try {
    const { data: employees } = params.seedEmployees === false
      ? { data: [] }
      : await supabase
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
          ? degreeAdjustedMonthlySalary(emp.monthly_salary, emp.employment_degree)
          : 0

      const { data: sre, error: sreErr } = await supabase
        .from('salary_run_employees')
        .insert({
          salary_run_id: run.id,
          employee_id: emp.id,
          company_id: companyId,
          employment_degree: emp.employment_degree,
          monthly_salary: runMonthlySalaryFor(emp),
          salary_type: emp.salary_type,
          tax_table_number: emp.tax_table_number,
          tax_column: emp.tax_column,
        })
        .select()
        .single()
      if (sreErr || !sre) {
        throw new Error(`Failed to add employee ${emp.id}: ${sreErr?.message ?? 'unknown error'}`)
      }

      const itemType = baseSalaryLineType(emp.salary_type)
      const { error: liErr } = await supabase.from('salary_line_items').insert({
        salary_run_employee_id: sre.id,
        company_id: companyId,
        item_type: itemType,
        description: emp.salary_type === 'monthly' ? 'Grundlön' : 'Timlön',
        amount: baseAmount,
        ...payslipLineFlags(itemType),
        account_number: null,
        sort_order: 0,
      })
      if (liErr) {
        throw new Error(`Failed to add base line for employee ${emp.id}: ${liErr.message}`)
      }
    }
    employeeCount = eligibleEmployees.length
  } catch (err) {
    // Compensating delete: never leave a half-populated run. Cascade removes
    // any salary_run_employees / salary_line_items already inserted.
    await supabase.from('salary_runs').delete().eq('id', run.id).eq('company_id', companyId)
    throw err
  }

  // The run exists: a failed emit must not undo it (the bus logs handler
  // failures itself; this guards the emit call).
  try {
    await eventBus.emit({
      type: 'salary_run.created',
      payload: {
        salaryRunId: run.id as string,
        periodYear: params.periodYear,
        periodMonth: params.periodMonth,
        userId,
        companyId,
      },
    })
  } catch (err) {
    log.warn('salary_run.created emit failed', { error: err instanceof Error ? err.message : 'unknown' })
  }

  return {
    run: run as Record<string, unknown>,
    employeeCount,
    deviationWindow,
  }
}
