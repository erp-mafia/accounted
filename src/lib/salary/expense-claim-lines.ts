/**
 * Utlägg on the payslip ("Betala ut via lön", #2331).
 *
 * An employee's registered expense claim (2820 K at registration) can be
 * repaid with the next salary instead of by a bank transfer. The payslip
 * carries one `expense_reimbursement` line per claim, linked through
 * salary_line_items.source_expense_claim_id:
 *
 *   - the calculation engine adds the line to the net payout only (no tax,
 *     no arbetsgivaravgifter, outside the AGI gross)
 *   - the salary verifikat debits the claim's liability account (2820) for it
 *   - once the run is booked, settle_expense_claims_via_salary_run marks the
 *     claims paid with an expense_payout_batches row that points at the
 *     salary verifikat: the same batch mechanism as the bank-side payout,
 *     without a second verifikat
 *
 * Everything that touches a draft payslip goes through the same gates as the
 * other line commands (lib/salary/payslip-lines.ts): draft only, the
 * employee must be on the run.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre, sumOre } from '@/lib/money'
import {
  assertRunDraft,
  resolveRunEmployee,
  type PayslipLineResult,
  type SalaryLineItemRow,
} from '@/lib/salary/payslip-lines'

/** After mileage (100), absence (200/250), premiums (300); before rounding (900). */
export const EXPENSE_REIMBURSEMENT_SORT_ORDER = 500

const LINE_COLUMNS =
  'id, salary_run_employee_id, company_id, item_type, description, quantity, unit_price, amount, ' +
  'is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction, ' +
  'account_number, sort_order, source_expense_claim_id, created_at, updated_at'

export type ExpenseClaimLineRow = SalaryLineItemRow & { source_expense_claim_id: string | null }

export interface OpenExpenseClaim {
  id: string
  description: string
  expense_date: string
  amount_sek: number
  liability_account: string
}

/**
 * The employee's registered claims that are not yet scheduled on any payslip
 * line (this run or another draft). Oldest first, like the worklist.
 */
export async function listOpenExpenseClaimsForEmployee(
  supabase: SupabaseClient,
  companyId: string,
  employeeId: string,
): Promise<OpenExpenseClaim[]> {
  const { data: claims, error } = await supabase
    .from('expense_claims')
    .select('id, description, expense_date, amount_sek, liability_account')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('status', 'registered')
    .order('expense_date', { ascending: true })
    .order('id', { ascending: true })
  if (error) throw new Error(`Failed to list open expense claims: ${error.message}`)
  const rows = (claims ?? []) as Array<Omit<OpenExpenseClaim, 'amount_sek'> & { amount_sek: number | string }>
  if (rows.length === 0) return []

  const { data: linked, error: linkedError } = await supabase
    .from('salary_line_items')
    .select('source_expense_claim_id')
    .eq('company_id', companyId)
    .in('source_expense_claim_id', rows.map((r) => r.id))
  if (linkedError) throw new Error(`Failed to read scheduled expense claims: ${linkedError.message}`)
  const scheduled = new Set(
    ((linked ?? []) as Array<{ source_expense_claim_id: string | null }>)
      .map((l) => l.source_expense_claim_id)
      .filter((id): id is string => Boolean(id)),
  )

  return rows
    .filter((r) => !scheduled.has(r.id))
    .map((r) => ({ ...r, amount_sek: roundOre(Number(r.amount_sek)) }))
}

export interface AddedExpenseClaimLines {
  lines: ExpenseClaimLineRow[]
  claim_count: number
  total_sek: number
}

/**
 * "Lägg till öppna utlägg": one expense_reimbursement line per open claim,
 * amount and liability account copied from the claim so the booking relieves
 * exactly what registration booked. The partial unique index on
 * source_expense_claim_id is the last line of defense against the same claim
 * landing on two payslips; a race there surfaces as
 * EXPENSE_CLAIM_ALREADY_ON_PAYSLIP.
 */
export async function addOpenExpenseClaimsToPayslip(
  supabase: SupabaseClient,
  args: { companyId: string; salaryRunId: string; employeeId: string },
): Promise<PayslipLineResult<AddedExpenseClaimLines>> {
  const gate = await assertRunDraft(supabase, args.companyId, args.salaryRunId)
  if (!gate.ok) return gate

  const sre = await resolveRunEmployee(supabase, args.companyId, args.salaryRunId, {
    employeeId: args.employeeId,
  })
  if (!sre.ok) return sre

  const claims = await listOpenExpenseClaimsForEmployee(supabase, args.companyId, args.employeeId)
  if (claims.length === 0) {
    return { ok: false, code: 'SALARY_RUN_NO_OPEN_EXPENSE_CLAIMS' }
  }

  const rows = claims.map((claim, index) => ({
    salary_run_employee_id: sre.data.id,
    company_id: args.companyId,
    item_type: 'expense_reimbursement',
    description: `Utlägg: ${claim.description} (${claim.expense_date})`,
    quantity: null,
    unit_price: null,
    amount: claim.amount_sek,
    is_taxable: false,
    is_avgift_basis: false,
    is_vacation_basis: false,
    is_gross_deduction: false,
    is_net_deduction: false,
    account_number: claim.liability_account,
    sort_order: EXPENSE_REIMBURSEMENT_SORT_ORDER + index,
    source_expense_claim_id: claim.id,
  }))

  const { data: created, error } = await supabase
    .from('salary_line_items')
    .insert(rows)
    .select(LINE_COLUMNS)
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return { ok: false, code: 'EXPENSE_CLAIM_ALREADY_ON_PAYSLIP' }
    }
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }

  const lines = (created ?? []) as unknown as ExpenseClaimLineRow[]
  return {
    ok: true,
    data: {
      lines,
      claim_count: claims.length,
      total_sek: sumOre(claims.map((c) => c.amount_sek)),
    },
  }
}

export interface PayslipLineForClaim {
  line_id: string
  salary_run_id: string
  run_status: string
  period_year: number
  period_month: number
}

/**
 * Where a claim is scheduled, if anywhere. deleteExpenseClaim consults this
 * before posting the storno: on a draft run the FK cascade simply drops the
 * line, but once the run has left draft its stored totals include the line,
 * so the claim must stay until the line is removed from the payslip.
 */
export async function findPayslipLineForClaim(
  supabase: SupabaseClient,
  companyId: string,
  claimId: string,
): Promise<PayslipLineForClaim | null> {
  const { data, error } = await supabase
    .from('salary_line_items')
    .select('id, salary_run_employee:salary_run_employees(salary_run_id, salary_run:salary_runs(id, status, period_year, period_month))')
    .eq('company_id', companyId)
    .eq('source_expense_claim_id', claimId)
    .maybeSingle()
  if (error) throw new Error(`Failed to look up the claim's payslip line: ${error.message}`)
  if (!data) return null
  const row = data as unknown as {
    id: string
    salary_run_employee: {
      salary_run_id: string
      salary_run: { id: string; status: string; period_year: number; period_month: number } | null
    } | null
  }
  const run = row.salary_run_employee?.salary_run
  if (!run) return null
  return {
    line_id: row.id,
    salary_run_id: run.id,
    run_status: run.status,
    period_year: run.period_year,
    period_month: run.period_month,
  }
}

interface RosterLineLike {
  employee_id: string
  line_items: Array<Record<string, unknown>> | null
}

interface LinkedClaimLine {
  claim_id: string
  employee_id: string
  amount: number
}

function linkedClaimLines(roster: RosterLineLike[]): LinkedClaimLine[] {
  const linked: LinkedClaimLine[] = []
  for (const sre of roster) {
    for (const li of sre.line_items ?? []) {
      const claimId = li.source_expense_claim_id
      if (typeof claimId !== 'string' || !claimId) continue
      linked.push({ claim_id: claimId, employee_id: sre.employee_id, amount: Number(li.amount) || 0 })
    }
  }
  return linked
}

/** True when any payslip line on the roster repays an expense claim. */
export function rosterHasLinkedExpenseClaims(roster: RosterLineLike[]): boolean {
  return linkedClaimLines(roster).length > 0
}

export type LinkedClaimProblem = {
  claim_id: string
  reason: 'missing' | 'not_open' | 'employee_mismatch' | 'amount_mismatch'
}

export type LinkedClaimsCheck =
  | { ok: true; claim_count: number }
  | { ok: false; code: 'SALARY_RUN_EXPENSE_CLAIM_NOT_OPEN'; details: { claims: LinkedClaimProblem[] } }

/**
 * Pre-booking gate: every claim the payslip repays must still be registered,
 * belong to the line's employee and carry the line's amount. Run BEFORE the
 * verifikat is posted: a refusal here costs nothing, while a refusal from the
 * settle RPC afterwards would leave a posted 2820 debit with no claim behind
 * it. Zero queries when no line is linked.
 */
export async function assertLinkedExpenseClaimsOpen(
  supabase: SupabaseClient,
  companyId: string,
  roster: RosterLineLike[],
): Promise<LinkedClaimsCheck> {
  const linked = linkedClaimLines(roster)
  if (linked.length === 0) return { ok: true, claim_count: 0 }

  const { data, error } = await supabase
    .from('expense_claims')
    .select('id, status, employee_id, amount_sek')
    .eq('company_id', companyId)
    .in('id', [...new Set(linked.map((l) => l.claim_id))])
  if (error) throw new Error(`Failed to verify the payslip's expense claims: ${error.message}`)
  const byId = new Map(
    ((data ?? []) as Array<{ id: string; status: string; employee_id: string | null; amount_sek: number | string }>)
      .map((c) => [c.id, c] as const),
  )

  const problems: LinkedClaimProblem[] = []
  for (const line of linked) {
    const claim = byId.get(line.claim_id)
    if (!claim) {
      problems.push({ claim_id: line.claim_id, reason: 'missing' })
    } else if (claim.status !== 'registered') {
      problems.push({ claim_id: line.claim_id, reason: 'not_open' })
    } else if (claim.employee_id !== line.employee_id) {
      problems.push({ claim_id: line.claim_id, reason: 'employee_mismatch' })
    } else if (roundOre(line.amount) !== roundOre(Number(claim.amount_sek))) {
      problems.push({ claim_id: line.claim_id, reason: 'amount_mismatch' })
    }
  }
  if (problems.length > 0) {
    return { ok: false, code: 'SALARY_RUN_EXPENSE_CLAIM_NOT_OPEN', details: { claims: problems } }
  }
  return { ok: true, claim_count: linked.length }
}

export interface SettledExpenseClaims {
  claim_count: number
  already_settled: number
  total_sek: number
  batches: Array<{ batch_id: string; employee_id: string; total_sek: number; claim_count: number }>
}

export type SettleExpenseClaimsResult =
  | { ok: true; data: SettledExpenseClaims }
  | { ok: false; code: string; detail?: string }

interface SettleRpcRow {
  ok: boolean
  code?: string
  details?: unknown
  claim_count?: number
  already_settled?: number
  total_sek?: number | string
  batches?: Array<{ batch_id: string; employee_id: string; total_sek: number | string; claim_count: number }>
}

/**
 * Mark the claims a booked run repays as paid, through the
 * settle_expense_claims_via_salary_run RPC (migration 20260906210300). The
 * RPC locks the claims, refuses anything not open, and writes one
 * expense_payout_batches row per person pointing at the salary verifikat.
 * Idempotent: a retry after a partial failure counts the already settled
 * claims instead of refusing them.
 */
export async function settleExpenseClaimsForBookedRun(
  supabase: SupabaseClient,
  args: { companyId: string; userId: string; salaryRunId: string },
): Promise<SettleExpenseClaimsResult> {
  const { data, error } = await supabase.rpc('settle_expense_claims_via_salary_run', {
    p_company_id: args.companyId,
    p_salary_run_id: args.salaryRunId,
    // Honored only for service-role callers (API-key / MCP paths); an
    // authenticated caller is pinned to its own auth.uid() by the RPC.
    p_user_id: args.userId,
  })
  if (error) {
    return { ok: false, code: 'SETTLE_FAILED', detail: error.message }
  }
  const row = (data ?? null) as SettleRpcRow | null
  if (!row) return { ok: false, code: 'SETTLE_FAILED', detail: 'empty RPC response' }
  if (!row.ok) {
    return {
      ok: false,
      code: row.code ?? 'SETTLE_FAILED',
      detail: row.details ? JSON.stringify(row.details) : undefined,
    }
  }
  return {
    ok: true,
    data: {
      claim_count: row.claim_count ?? 0,
      already_settled: row.already_settled ?? 0,
      total_sek: roundOre(Number(row.total_sek ?? 0)),
      batches: (row.batches ?? []).map((b) => ({
        batch_id: b.batch_id,
        employee_id: b.employee_id,
        total_sek: roundOre(Number(b.total_sek)),
        claim_count: b.claim_count,
      })),
    },
  }
}
