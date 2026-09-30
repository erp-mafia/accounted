/**
 * approved -> paid: record that a salary run's net pay has gone out.
 *
 * One implementation behind the v1 verb POST /salary-runs/{id}/mark-paid and
 * the MCP tool gnubok_mark_salary_run_paid
 * (lib/operations/salary-run-structure.ts). It initiates no payment and posts
 * no verifikat: booking does that, and the book step walks an approved run
 * through paid by itself (advanceAndBookSalaryRun in lib/salary/book-run.ts),
 * so marking paid first is only needed when the payment should be on record
 * before the run is booked. paid_at is the server clock, never a
 * caller-supplied date, so the audit trail says when it was recorded. No
 * event: the verifikat event fires from the book step.
 *
 * A dry run reads and checks and writes nothing (it is also the MCP staging
 * preview).
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'

export interface SalaryRunMarkedPaid {
  id: string
  status: 'paid'
  paid_at: string
}

export async function markSalaryRunPaid(
  ctx: Pick<OperationContext, 'supabase' | 'companyId'>,
  salaryRunId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<SalaryRunMarkedPaid>> {
  const { supabase, companyId } = ctx

  const { data: existing, error: fetchError } = await supabase
    .from('salary_runs')
    .select('id, status, period_year, period_month, payment_date, total_net')
    .eq('company_id', companyId)
    .eq('id', salaryRunId)
    .maybeSingle()
  if (fetchError) return { ok: false, code: 'UNKNOWN_ERROR', error: fetchError }
  if (!existing) return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }

  const run = existing as {
    status: string
    period_year: number | null
    period_month: number | null
    payment_date: string | null
    total_net: number | null
  }
  if (run.status !== 'approved') {
    return { ok: false, code: 'SALARY_RUN_MARK_PAID_NOT_APPROVED', details: { current_status: run.status } }
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        salary_run_id: salaryRunId,
        would_advance_status_from: 'approved',
        would_advance_status_to: 'paid',
        period_year: run.period_year,
        period_month: run.period_month,
        payment_date: run.payment_date,
        total_net: run.total_net,
        note: 'Records that the salaries were paid. Nothing is booked and no payment is made.',
      },
    }
  }

  // The status filter makes a concurrent transition a zero-row update
  // instead of overwriting whatever the run moved on to.
  const { data, error } = await supabase
    .from('salary_runs')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('id', salaryRunId)
    .eq('status', 'approved')
    .select('id, status, paid_at')
    .maybeSingle()
  if (error) return { ok: false, code: 'UNKNOWN_ERROR', error }
  if (!data) {
    return { ok: false, code: 'SALARY_RUN_MARK_PAID_NOT_APPROVED', details: { reason: 'race' } }
  }

  return { ok: true, data: data as SalaryRunMarkedPaid }
}
