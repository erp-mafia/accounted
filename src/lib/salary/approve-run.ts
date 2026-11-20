/**
 * Salary-run approval: the one rule set every door applies before a run is
 * authorized for payment, and the review → approved step itself.
 *
 * Four doors approve a run: the dashboard approve route, the v1 :approve
 * verb, and the MCP book tool (gnubok_book_salary_run) at staging and at
 * approval (advanceAndBookSalaryRun walks a calculated run through approval
 * on its way to booked). Each used to carry its own copy of these checks,
 * and they drifted: v1 demanded bank details for an employee with nothing
 * to pay out, and the MCP book tool let a draft through without the review
 * step's "is it calculated at all" rule.
 *
 * The rules:
 *   - blocking: a roster row without a calculation (calculation_breakdown),
 *     and, for a run still in draft (the MCP walk skips the review step), a
 *     run that was never calculated. Never overridable: the verifikat would
 *     carry figures nobody calculated.
 *   - bank details: an employee with a payout (effectiveNetPayout > 0) whose
 *     clearing and account number name no payable account. A zero payout
 *     (nollkörning, or a net fully used by a nettolöneavdrag) produces no
 *     payment-file line, so it needs no destination account: the same rule
 *     the pain.001 and Bankgirot LB generators apply. Overridable where the
 *     door offers it (the dashboard's "Godkänn ändå"; the MCP walk records
 *     them as warnings), because the payment-file step refuses them anyway.
 *   - warnings: F-skatt not verified (f-skatt.md: 30 % skatteavdrag and full
 *     avgifter apply), and no email (the lönebesked cannot be sent).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { eventBus } from '@/lib/events'
import { effectiveNetPayout, type EffectiveNetInput } from '@/lib/salary/payment/effective-net'
import { employeeBankDetailsRemark } from '@/lib/payments/bank-account'
import { runCalculationState, type RunCalculationSource } from '@/lib/salary/calculation-state'
import { refreshRunYtd } from '@/lib/salary/ytd'

/** The roster columns validateRunForApproval reads. */
export const APPROVAL_ROSTER_SELECT =
  'employee_id, calculation_breakdown, net_salary, tax_withheld, tax_withheld_override, employee:employees(first_name, last_name, clearing_number, bank_account_number, email, f_skatt_status)'

export interface ApprovalEmployee {
  first_name: string
  last_name: string
  clearing_number: string | null
  bank_account_number: string | null
  email: string | null
  f_skatt_status?: string | null
}

export interface ApprovalRosterRow extends EffectiveNetInput {
  employee_id: string
  calculation_breakdown?: unknown
  employee: ApprovalEmployee | null
}

export interface RunApprovalVerdict {
  /** Employees without a calculation, by name (employee id when nameless). */
  uncalculated: string[]
  /** Never overridable: one sentence per problem. */
  blocking: string[]
  /** Overridable where the door allows it: one sentence per employee. */
  bankDetails: string[]
  warnings: string[]
}

const NOT_CALCULATED_SV = 'Lönekörningen är inte beräknad: beräkna den först.'

function employeeName(row: ApprovalRosterRow): string {
  const emp = row.employee
  return (emp ? `${emp.first_name ?? ''} ${emp.last_name ?? ''}`.trim() : '') || row.employee_id
}

/**
 * Every problem with approving this roster, collected across all employees
 * so the caller fixes them in one pass. `run`, when given and still a draft,
 * adds the review step's run-level rule: a run never calculated is refused
 * even with an empty roster.
 */
export function validateRunForApproval(
  roster: readonly ApprovalRosterRow[],
  run?: RunCalculationSource,
): RunApprovalVerdict {
  const verdict: RunApprovalVerdict = { uncalculated: [], blocking: [], bankDetails: [], warnings: [] }

  if (run?.status === 'draft' && runCalculationState(run, roster) === 'not_calculated') {
    verdict.blocking.push(NOT_CALCULATED_SV)
  }

  for (const row of roster) {
    const name = employeeName(row)
    if (row.calculation_breakdown == null) {
      verdict.uncalculated.push(name)
      verdict.blocking.push(`${name}: Beräkning saknas, kör beräkning först`)
    }
    const emp = row.employee
    if (!emp) continue
    if (emp.f_skatt_status === 'not_verified') {
      verdict.warnings.push(
        `${name}: F-skatt ej verifierad: 30% skatteavdrag och fulla avgifter tillämpas (f-skatt.md)`,
      )
    }
    const bankRemark =
      effectiveNetPayout(row) > 0
        ? employeeBankDetailsRemark(name, emp.clearing_number, emp.bank_account_number)
        : null
    if (bankRemark) verdict.bankDetails.push(bankRemark)
    if (!emp.email) {
      verdict.warnings.push(`${name}: E-post saknas, lönebesked kan inte skickas`)
    }
  }
  return verdict
}

export type ApproveRunResult =
  | { ok: true; data: { run: Record<string, unknown> | null; warnings: string[]; verdict: RunApprovalVerdict } }
  | { ok: false; code: string; details?: Record<string, unknown>; dbError?: unknown; verdict?: RunApprovalVerdict }

export interface ApproveRunArgs {
  companyId: string
  userId: string
  salaryRunId: string
  log: Logger
}

/**
 * review → approved, for the dashboard route and the v1 verb. Refusal codes:
 * SALARY_RUN_NOT_FOUND, SALARY_RUN_APPROVE_NOT_REVIEW, SALARY_APPROVE_BLOCKED
 * (a blocking problem) and SALARY_APPROVE_BANK_DETAILS_MISSING (bank details,
 * unless `force`); each carries the verdict so the door can phrase it.
 * `dryRun` validates and answers without writing (run: null). The update is
 * optimistic-locked on status='review', so a concurrent approval answers
 * NOT_REVIEW instead of approving and emitting twice.
 */
export async function approveReviewedSalaryRun(
  supabase: SupabaseClient,
  args: ApproveRunArgs,
  options: { force?: boolean; dryRun?: boolean; columns?: string } = {},
): Promise<ApproveRunResult> {
  const { companyId, userId, salaryRunId, log } = args

  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('id, status')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (runError) return { ok: false, code: 'SALARY_RUN_APPROVE_FAILED', dbError: runError }
  if (!run) return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  const status = (run as { status: string }).status
  if (status !== 'review') {
    return { ok: false, code: 'SALARY_RUN_APPROVE_NOT_REVIEW', details: { current_status: status } }
  }

  const { data: roster, error: rosterError } = await supabase
    .from('salary_run_employees')
    .select(APPROVAL_ROSTER_SELECT)
    .eq('salary_run_id', salaryRunId)
    .eq('company_id', companyId)
  if (rosterError) return { ok: false, code: 'SALARY_RUN_APPROVE_FAILED', dbError: rosterError }

  const verdict = validateRunForApproval((roster ?? []) as unknown as ApprovalRosterRow[])
  if (verdict.blocking.length > 0) {
    return { ok: false, code: 'SALARY_APPROVE_BLOCKED', verdict }
  }
  if (verdict.bankDetails.length > 0 && !options.force) {
    return { ok: false, code: 'SALARY_APPROVE_BANK_DETAILS_MISSING', verdict }
  }
  // Forced past missing bank details: keep them on the answer, so the caller
  // can still remind the user to complete them before the payment file.
  const warnings = options.force ? [...verdict.bankDetails, ...verdict.warnings] : verdict.warnings

  if (options.dryRun) return { ok: true, data: { run: null, warnings, verdict } }

  const { data: approved, error } = await supabase
    .from('salary_runs')
    .update({ status: 'approved', approved_by: userId, approved_at: new Date().toISOString() })
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .eq('status', 'review')
    .select(options.columns ?? '*')
    .maybeSingle()
  if (error) return { ok: false, code: 'SALARY_RUN_APPROVE_FAILED', dbError: error }
  if (!approved) return { ok: false, code: 'SALARY_RUN_APPROVE_NOT_REVIEW', details: { reason: 'race' } }

  // Approval is the first status from which lönebesked can be sent, so the
  // payslip's "Ackumulerat" snapshot is brought up to date here: a run
  // calculated before an earlier month was authorized still carries a YTD
  // missing that month. Non-fatal, YTD is display only.
  const ytdRefresh = await refreshRunYtd(supabase, { companyId, salaryRunId })
  if (!ytdRefresh.ok) {
    log.warn('YTD refresh failed after approval', { salaryRunId, message: ytdRefresh.message })
  }

  try {
    await eventBus.emit({
      type: 'salary_run.approved',
      payload: { salaryRunId, approvedBy: userId, userId, companyId },
    })
  } catch (err) {
    log.warn('salary_run.approved emit failed', { salaryRunId, message: err instanceof Error ? err.message : String(err) })
  }

  return { ok: true, data: { run: approved as unknown as Record<string, unknown>, warnings, verdict } }
}
