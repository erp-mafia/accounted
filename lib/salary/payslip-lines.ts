/**
 * Shared payslip line-item commands.
 *
 * Single source of truth for creating, updating, and deleting
 * salary_line_items rows, consumed by:
 *   - the internal dashboard routes (app/api/salary/runs/[id]/lines/**)
 *   - the v1 REST routes (app/api/v1/.../salary-runs/[id]/.../lines/**)
 *   - the MCP staged-operation executor (update_payslip_line)
 *
 * Rules enforced here so they cannot drift between surfaces:
 *   - Lines are only editable while the run is in `draft` (BFL 5 kap: once
 *     the run advances, its numbers feed a verifikation).
 *   - The target salary_run_employee must belong to the given run.
 *   - Money is rounded via roundOre() (never naive Math.round(x*100)/100).
 *   - account_number auto-resolves from the item type when not supplied.
 *
 * Result-object convention mirrors lib/salary/run-calculation.ts:
 * `{ ok: true, data } | { ok: false, code, details? }` where `code` is a key
 * in lib/errors/structured-errors.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { CreateSalaryLineItemSchema, UpdateSalaryLineItemSchema } from '@/lib/api/schemas'
import { getLineItemAccount } from '@/lib/salary/account-mapping'
import { validateOneOffTaxLine } from '@/lib/salary/one-off-tax'
import { validateVacationCategoryLine } from '@/lib/salary/vacation-category'
import { roundOre } from '@/lib/money'
import type { SalaryLineItemType } from '@/types'

export type PayslipLineResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown> }

export interface SalaryLineItemRow {
  id: string
  salary_run_employee_id: string
  company_id: string
  item_type: string
  description: string
  quantity: number | null
  unit_price: number | null
  amount: number
  is_taxable: boolean
  is_avgift_basis: boolean
  is_vacation_basis: boolean
  is_gross_deduction: boolean
  is_net_deduction: boolean
  account_number: string | null
  sort_order: number
  /** Engångsskatt percentage (lib/salary/one-off-tax.ts); null = taxed by the table. */
  one_off_tax_percent?: number | null
  /** Vacation pool a 'vacation' line draws from (lib/salary/vacation-category.ts); null = paid. */
  vacation_category?: string | null
  /** Origin year of the sparade dagar a 'saved' line consumes; null = oldest first. */
  vacation_saved_year?: string | null
  created_at: string
  updated_at: string
}

export type CreatePayslipLineInput = Omit<
  z.infer<typeof CreateSalaryLineItemSchema>,
  'salary_run_employee_id'
>
export type UpdatePayslipLineInput = z.infer<typeof UpdateSalaryLineItemSchema>

/** Address the target row either by the join-row id (internal UI) or by the
 * employee id (v1/MCP callers, who know employee_id but not the sre id). */
export type PayslipLineTarget = { salaryRunEmployeeId: string } | { employeeId: string }

const LINE_COLUMNS =
  'id, salary_run_employee_id, company_id, item_type, description, quantity, unit_price, amount, ' +
  'is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction, ' +
  'account_number, sort_order, one_off_tax_percent, vacation_category, vacation_saved_year, ' +
  'created_at, updated_at'

/**
 * Verify the run exists in this company and is still a draft.
 * Exported so surfaces that only need the gate (dry-run previews) can reuse it.
 */
export async function assertRunDraft(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunId: string,
): Promise<PayslipLineResult<{ id: string; status: string }>> {
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
      code: 'SALARY_RUN_LINE_NOT_DRAFT',
      details: { current_status: (run as { status: string }).status },
    }
  }
  return { ok: true, data: run as { id: string; status: string } }
}

/** Resolve the salary_run_employees row for a target within a run. */
export async function resolveRunEmployee(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunId: string,
  target: PayslipLineTarget,
): Promise<PayslipLineResult<{ id: string; employee_id: string }>> {
  let query = supabase
    .from('salary_run_employees')
    .select('id, employee_id')
    .eq('salary_run_id', salaryRunId)
    .eq('company_id', companyId)

  if ('salaryRunEmployeeId' in target) {
    query = query.eq('id', target.salaryRunEmployeeId)
  } else {
    query = query.eq('employee_id', target.employeeId)
  }

  const { data: sre, error } = await query.maybeSingle()
  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  if (!sre) {
    return { ok: false, code: 'SALARY_RUN_EMPLOYEE_NOT_FOUND' }
  }
  return { ok: true, data: sre as { id: string; employee_id: string } }
}

/** Load a line and verify it belongs to the given run (via its sre). */
async function loadLineInRun(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunId: string,
  lineId: string,
): Promise<PayslipLineResult<SalaryLineItemRow>> {
  const { data, error } = await supabase
    .from('salary_line_items')
    .select(`${LINE_COLUMNS}, salary_run_employee:salary_run_employees(salary_run_id)`)
    .eq('id', lineId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  const row = data as (SalaryLineItemRow & { salary_run_employee?: { salary_run_id: string } | null }) | null
  if (!row || row.salary_run_employee?.salary_run_id !== salaryRunId) {
    return { ok: false, code: 'SALARY_LINE_NOT_FOUND' }
  }
  const { salary_run_employee: _sre, ...line } = row
  return { ok: true, data: line as SalaryLineItemRow }
}

export async function createPayslipLine(
  supabase: SupabaseClient,
  args: {
    companyId: string
    salaryRunId: string
    target: PayslipLineTarget
    input: CreatePayslipLineInput
    /** Validate + resolve only; return the would-be row (id null) without writing. */
    dryRun?: boolean
  },
): Promise<PayslipLineResult<SalaryLineItemRow | (Omit<SalaryLineItemRow, 'id' | 'created_at' | 'updated_at'> & { id: null })>> {
  const gate = await assertRunDraft(supabase, args.companyId, args.salaryRunId)
  if (!gate.ok) return gate

  const sre = await resolveRunEmployee(supabase, args.companyId, args.salaryRunId, args.target)
  if (!sre.ok) return sre

  const input = args.input
  // Engångsskatt only on a positive taxable addition of an eligible type;
  // the same rule the DB CHECK enforces, answered here as a 400 with a
  // Swedish reason instead of a 23514.
  const oneOffError = validateOneOffTaxLine(input)
  if (oneOffError) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'one_off_tax_percent', message: oneOffError } }
  }
  // A vacation category only on a vacation line, a saved year only with
  // category 'saved' (the same rule the two DB CHECKs enforce as 23514).
  const categoryError = validateVacationCategoryLine(input)
  if (categoryError) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'vacation_category', message: categoryError } }
  }
  const accountNumber =
    input.account_number || getLineItemAccount(input.item_type as SalaryLineItemType)

  const row = {
    salary_run_employee_id: sre.data.id,
    company_id: args.companyId,
    item_type: input.item_type,
    description: input.description,
    quantity: input.quantity ?? null,
    unit_price: input.unit_price ?? null,
    amount: roundOre(input.amount),
    is_taxable: input.is_taxable,
    is_avgift_basis: input.is_avgift_basis,
    is_vacation_basis: input.is_vacation_basis,
    is_gross_deduction: input.is_gross_deduction,
    is_net_deduction: input.is_net_deduction,
    account_number: accountNumber,
    sort_order: input.sort_order,
    one_off_tax_percent: input.one_off_tax_percent ?? null,
    vacation_category: input.vacation_category ?? null,
    vacation_saved_year: input.vacation_saved_year ?? null,
  }

  if (args.dryRun) {
    return { ok: true, data: { ...row, id: null } }
  }

  const { data: created, error } = await supabase
    .from('salary_line_items')
    .insert(row)
    .select(LINE_COLUMNS)
    .single()

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  return { ok: true, data: created as unknown as SalaryLineItemRow }
}

export async function updatePayslipLine(
  supabase: SupabaseClient,
  args: {
    companyId: string
    salaryRunId: string
    lineId: string
    patch: UpdatePayslipLineInput
    /** Validate + resolve only; return the merged row without writing. */
    dryRun?: boolean
  },
): Promise<PayslipLineResult<SalaryLineItemRow>> {
  const gate = await assertRunDraft(supabase, args.companyId, args.salaryRunId)
  if (!gate.ok) return gate

  const existing = await loadLineInRun(supabase, args.companyId, args.salaryRunId, args.lineId)
  if (!existing.ok) return existing

  const updates: Record<string, unknown> = { ...args.patch }
  if (typeof updates.amount === 'number') {
    updates.amount = roundOre(updates.amount)
  }
  // Moving the category off 'saved' (null returns the line to paid days)
  // retires the origin year with it unless the caller sets the year itself.
  if (
    'vacation_category' in updates &&
    updates.vacation_category !== 'saved' &&
    !('vacation_saved_year' in updates)
  ) {
    updates.vacation_saved_year = null
  }
  // Validate the row as it will read after the patch: a sparse update that
  // flips a flag or the sign can invalidate a percentage set earlier.
  const merged = { ...existing.data, ...updates } as SalaryLineItemRow
  const oneOffError = validateOneOffTaxLine(merged)
  if (oneOffError) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'one_off_tax_percent', message: oneOffError } }
  }
  const categoryError = validateVacationCategoryLine(merged)
  if (categoryError) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'vacation_category', message: categoryError } }
  }

  if (args.dryRun) {
    return { ok: true, data: { ...existing.data, ...updates } as SalaryLineItemRow }
  }

  const { data: updated, error } = await supabase
    .from('salary_line_items')
    .update(updates)
    .eq('id', args.lineId)
    .eq('company_id', args.companyId)
    .select(LINE_COLUMNS)
    .maybeSingle()

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  if (!updated) {
    return { ok: false, code: 'SALARY_LINE_NOT_FOUND' }
  }
  return { ok: true, data: updated as unknown as SalaryLineItemRow }
}

export async function deletePayslipLine(
  supabase: SupabaseClient,
  args: {
    companyId: string
    salaryRunId: string
    lineId: string
    /** Validate + resolve only; do not delete. */
    dryRun?: boolean
  },
): Promise<PayslipLineResult<{ deleted: true; salary_line_item_id: string }>> {
  const gate = await assertRunDraft(supabase, args.companyId, args.salaryRunId)
  if (!gate.ok) return gate

  const existing = await loadLineInRun(supabase, args.companyId, args.salaryRunId, args.lineId)
  if (!existing.ok) return existing

  if (args.dryRun) {
    return { ok: true, data: { deleted: true, salary_line_item_id: args.lineId } }
  }

  const { error } = await supabase
    .from('salary_line_items')
    .delete()
    .eq('id', args.lineId)
    .eq('company_id', args.companyId)

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  return { ok: true, data: { deleted: true, salary_line_item_id: args.lineId } }
}
