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
 *   - account_number is an override only: null books on the default the
 *     booking resolves from the item type and the employee
 *     (account-mapping.ts lineItemAccount), and changing a line's item type
 *     clears a stored account unless the patch sets one.
 *   - A line the calculation owns is never added, edited or deleted by hand
 *     (SALARY_LINE_CALCULATED): the next calculation, which every run needs
 *     before booking, would silently undo it (#3185, calculated-line-items.ts).
 *   - A text row carries words and no money; every other row needs a non-zero
 *     amount of a sign its type can mean, except a vacation row carrying days
 *     (text-rows.ts). A text row is forced to amount 0 and no account, and a
 *     row is never turned into or out of a text row.
 *   - The flags are the type's (line-item-roles.ts payslipLineFlags): no input
 *     carries them, and they are written on every insert and retype.
 *   - Every write clears the run's calculation first
 *     (invalidate-calculation.ts): the figures must be recalculated.
 *   - The payslip's own Grundlön or Timlön is the calculation's (Step 1 prices
 *     it from the pay type): no row of that type is added or typed by hand.
 *     The other base type is pay on top, such as extra hours at timlön on a
 *     monthly payslip (line-item-roles.ts, crm#1331).
 *   - No row names an account in 2710-2739: the run books its tax and
 *     avgifter there itself, from the numbers the AGI declares
 *     (line-account-override.ts isRunComputedTaxAccount).
 *
 * Result-object convention mirrors lib/salary/run-calculation.ts:
 * `{ ok: true, data } | { ok: false, code, details? }` where `code` is a key
 * in lib/errors/structured-errors.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { CreateSalaryLineItemSchema, UpdateSalaryLineItemSchema } from '@/lib/api/schemas'
import { validateOneOffTaxLine } from '@/lib/salary/one-off-tax'
import { validateVacationCategoryLine } from '@/lib/salary/vacation-category'
import { roundOre } from '@/lib/money'
import { isCalculatedLine, isCalculatedLineType } from '@/lib/salary/calculated-line-items'
import { invalidateRunCalculation } from '@/lib/salary/invalidate-calculation'
import { isBaseSalaryDisplayLine, isBaseSalaryLineType, payslipLineFlags } from '@/lib/salary/line-item-roles'
import { RUN_COMPUTED_TAX_ACCOUNT_MESSAGE, isRunComputedTaxAccount } from '@/lib/salary/line-account-override'
import type { SalaryLineItemType } from '@/types'
import {
  TEXT_ROW_RETYPE_MESSAGE,
  isTextRow,
  normalizeTextRow,
  validatePayslipLineContent,
} from '@/lib/salary/text-rows'

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

/** The columns that say whether the calculation owns a line (not part of the row callers see). */
const PROVENANCE_COLUMNS = 'calculation_source, source_benefit_id, source_recurring_line_id'

/**
 * Load a line and verify it belongs to the given run (via its sre), and say
 * whether the calculation owns it.
 */
async function loadLineInRun(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunId: string,
  lineId: string,
): Promise<PayslipLineResult<{ line: SalaryLineItemRow; calculated: boolean }>> {
  const { data, error } = await supabase
    .from('salary_line_items')
    .select(`${LINE_COLUMNS}, ${PROVENANCE_COLUMNS}, salary_run_employee:salary_run_employees(salary_run_id)`)
    .eq('id', lineId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  const row = data as
    | (SalaryLineItemRow & {
        salary_run_employee?: { salary_run_id: string } | null
        calculation_source?: string | null
        source_benefit_id?: string | null
        source_recurring_line_id?: string | null
      })
    | null
  if (!row || row.salary_run_employee?.salary_run_id !== salaryRunId) {
    return { ok: false, code: 'SALARY_LINE_NOT_FOUND' }
  }
  const {
    salary_run_employee: _sre,
    calculation_source,
    source_benefit_id,
    source_recurring_line_id,
    ...line
  } = row
  const calculated = isCalculatedLine({
    item_type: line.item_type,
    calculation_source,
    source_benefit_id,
    source_recurring_line_id,
  })
  return { ok: true, data: { line: line as SalaryLineItemRow, calculated } }
}

/** The refusal for a line the calculation owns. */
function calculatedLineRefusal(details: Record<string, unknown>): PayslipLineResult<never> {
  return { ok: false, code: 'SALARY_LINE_CALCULATED', details }
}

/** The refusal for an account the run books itself (2710-2739), judged on the account the row would store. */
function taxAccountRefusal(accountNumber: unknown): PayslipLineResult<never> | null {
  if (typeof accountNumber !== 'string' || !isRunComputedTaxAccount(accountNumber)) return null
  return {
    ok: false,
    code: 'VALIDATION_ERROR',
    details: { field: 'account_number', message: RUN_COMPUTED_TAX_ACCOUNT_MESSAGE },
  }
}

export const OWN_MONTHLY_SALARY_LINE_MESSAGE =
  'Grundlönen för en månadsavlönad räknas fram av lönekörningen från månadslönen och visas på raden Grundlön. ' +
  'Ändra lönen för den här lönekörningen i stället. Extra timmar läggs som Timlön, ett annat tillägg som Övrigt.'
export const OWN_HOURLY_SALARY_LINE_MESSAGE =
  'Timlönen för en timavlönad räknas fram av lönekörningen från de arbetade timmarna och visas på raden Timlön. ' +
  'Ändra timmarna i stället. Extra ersättning med ett annat timpris läggs som Övrigt.'

/**
 * Refuses a Grundlön/Timlön row of the payslip's own pay type: Step 1 prices
 * that pay from the monthly salary or the worked hours and never reads the
 * row, so a second one would be printed and paid nothing (crm#1331). Judged
 * against the run's snapshot and the employee's current pay type, since the
 * next calculation makes the current one the payslip's. The other base type
 * is accepted: it is pay on top.
 */
async function ownBaseSalaryLineRefusal(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunEmployeeId: string,
  itemType: unknown,
): Promise<PayslipLineResult<never> | null> {
  if (!isBaseSalaryLineType(itemType)) return null
  const { data, error } = await supabase
    .from('salary_run_employees')
    .select('salary_type, employee:employees(salary_type)')
    .eq('id', salaryRunEmployeeId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  const row = data as { salary_type?: string | null; employee?: { salary_type?: string | null } | null } | null
  if (!isBaseSalaryDisplayLine(itemType, [row?.salary_type, row?.employee?.salary_type])) return null
  return {
    ok: false,
    code: 'VALIDATION_ERROR',
    details: {
      field: 'item_type',
      message: itemType === 'monthly_salary' ? OWN_MONTHLY_SALARY_LINE_MESSAGE : OWN_HOURLY_SALARY_LINE_MESSAGE,
    },
  }
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
  if (isCalculatedLineType(args.input.item_type)) {
    return calculatedLineRefusal({ item_type: args.input.item_type })
  }

  const gate = await assertRunDraft(supabase, args.companyId, args.salaryRunId)
  if (!gate.ok) return gate

  const sre = await resolveRunEmployee(supabase, args.companyId, args.salaryRunId, args.target)
  if (!sre.ok) return sre

  const ownBase = await ownBaseSalaryLineRefusal(supabase, args.companyId, sre.data.id, args.input.item_type)
  if (ownBase) return ownBase

  const input = args.input
  const text = isTextRow(input)
  const flags = payslipLineFlags(input.item_type as SalaryLineItemType)
  // Words and no money on a text row; a non-zero amount on any other row
  // (the dialog's rule, now every door's: a 0 kr row printed "0,00").
  // Judged on the amount as stored: 0,004 kr rounds to a 0 kr row.
  const contentIssue = validatePayslipLineContent({
    ...input,
    amount: typeof input.amount === 'number' ? roundOre(input.amount) : input.amount,
  })
  if (contentIssue) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: contentIssue.field, message: contentIssue.message } }
  }
  // Engångsskatt only on a positive taxable addition of an eligible type;
  // the same rule the DB CHECK enforces, answered here as a 400 with a
  // Swedish reason instead of a 23514.
  const oneOffError = validateOneOffTaxLine({ ...input, ...flags, amount: input.amount ?? 0 })
  if (oneOffError) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'one_off_tax_percent', message: oneOffError } }
  }
  // A vacation category only on a vacation line, a saved year only with
  // category 'saved' (the same rule the two DB CHECKs enforce as 23514).
  const categoryError = validateVacationCategoryLine(input)
  if (categoryError) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'vacation_category', message: categoryError } }
  }
  // A text row has no account to choose. Any other row's account is an
  // override only; without one the booking resolves the default.
  const accountNumber = text ? null : input.account_number || null
  const taxAccount = taxAccountRefusal(accountNumber)
  if (taxAccount) return taxAccount

  const row = {
    salary_run_employee_id: sre.data.id,
    company_id: args.companyId,
    item_type: input.item_type,
    description: text ? normalizeTextRow(input.description) : input.description,
    quantity: input.quantity ?? null,
    unit_price: input.unit_price ?? null,
    // validatePayslipLineContent guaranteed a finite amount on a money row;
    // a vacation row that carries only its days is stored at 0 kr.
    amount: text ? 0 : roundOre(input.amount ?? 0),
    ...flags,
    account_number: accountNumber,
    sort_order: input.sort_order,
    one_off_tax_percent: input.one_off_tax_percent ?? null,
    vacation_category: input.vacation_category ?? null,
    vacation_saved_year: input.vacation_saved_year ?? null,
  }

  if (args.dryRun) {
    return { ok: true, data: { ...row, id: null } }
  }

  const invalidated = await invalidateRunCalculation(supabase, args.companyId, { salaryRunEmployeeId: sre.data.id })
  if (invalidated) return invalidated

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
  if (args.patch.item_type !== undefined && isCalculatedLineType(args.patch.item_type)) {
    return calculatedLineRefusal({ salary_line_item_id: args.lineId, item_type: args.patch.item_type })
  }

  const gate = await assertRunDraft(supabase, args.companyId, args.salaryRunId)
  if (!gate.ok) return gate

  const loaded = await loadLineInRun(supabase, args.companyId, args.salaryRunId, args.lineId)
  if (!loaded.ok) return loaded
  if (loaded.data.calculated) {
    return calculatedLineRefusal({ salary_line_item_id: args.lineId, item_type: loaded.data.line.item_type })
  }
  const existing = { data: loaded.data.line }
  // Retyping a row into the payslip's own Grundlön/Timlön (an edit of that
  // row itself keeps its type and is not judged here).
  if (args.patch.item_type !== undefined && args.patch.item_type !== existing.data.item_type) {
    const ownBase = await ownBaseSalaryLineRefusal(
      supabase,
      args.companyId,
      existing.data.salary_run_employee_id,
      args.patch.item_type,
    )
    if (ownBase) return ownBase
  }
  const text = isTextRow(existing.data)
  if (args.patch.item_type !== undefined && isTextRow(args.patch) !== text) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'item_type', message: TEXT_ROW_RETYPE_MESSAGE } }
  }

  // The flags are the type's whatever the patch holds; a retype brings its own.
  const updates: Record<string, unknown> = {
    ...args.patch,
    ...payslipLineFlags((args.patch.item_type ?? existing.data.item_type) as SalaryLineItemType),
  }
  // A stored account belonged to the old item type (a bonus turned into a
  // union deduction must not stay on 7210): a type change drops it so the
  // line books on its new type's default, unless the patch names one.
  if (
    updates.item_type !== undefined &&
    updates.item_type !== loaded.data.line.item_type &&
    !('account_number' in updates)
  ) {
    updates.account_number = null
  }
  if (typeof updates.amount === 'number') {
    updates.amount = roundOre(updates.amount)
  }
  if (text) {
    // A text row stays words only whatever the patch says about its account;
    // an amount in the patch must be 0 (checked below).
    updates.account_number = null
    if (typeof updates.description === 'string') updates.description = normalizeTextRow(updates.description)
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
  // changes the type or the sign can invalidate a percentage set earlier.
  const merged = { ...existing.data, ...updates } as SalaryLineItemRow
  // The content rule on the merged row, but only when the patch touches what
  // decides it, so an unrelated edit of a 0 kr row stored before the rule
  // existed still goes through. A text row is always checked.
  const touchesContent = text || ['amount', 'quantity', 'item_type'].some((key) => key in updates)
  const contentIssue = touchesContent ? validatePayslipLineContent(merged) : null
  if (contentIssue) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: contentIssue.field, message: contentIssue.message } }
  }
  const oneOffError = validateOneOffTaxLine(merged)
  if (oneOffError) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'one_off_tax_percent', message: oneOffError } }
  }
  const categoryError = validateVacationCategoryLine(merged)
  if (categoryError) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'vacation_category', message: categoryError } }
  }
  // Only an account the patch names (a text row's is already forced null),
  // so an unrelated edit of a row stored before the refusal still goes
  // through.
  const taxAccount = taxAccountRefusal(updates.account_number)
  if (taxAccount) return taxAccount

  if (args.dryRun) {
    return { ok: true, data: { ...existing.data, ...updates } as SalaryLineItemRow }
  }

  const invalidated = await invalidateRunCalculation(supabase, args.companyId, {
    salaryRunEmployeeId: existing.data.salary_run_employee_id,
  })
  if (invalidated) return invalidated

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
  if (existing.data.calculated) {
    return calculatedLineRefusal({ salary_line_item_id: args.lineId, item_type: existing.data.line.item_type })
  }

  if (args.dryRun) {
    return { ok: true, data: { deleted: true, salary_line_item_id: args.lineId } }
  }

  const invalidated = await invalidateRunCalculation(supabase, args.companyId, {
    salaryRunEmployeeId: existing.data.line.salary_run_employee_id,
  })
  if (invalidated) return invalidated

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
