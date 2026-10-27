/**
 * Shift premium rules (OB-tillägg / övertid): the CRUD service behind the
 * dashboard routes, the v1 REST mirror and the settings panel.
 *
 * The table (shift_premium_rules, migrations 20260526120900 and
 * 20261027213119) feeds lib/salary/shift-premium-engine.ts inside every
 * salary calculation. This module is the one write path, so both API
 * surfaces share the same checks:
 *
 *   - every named employee must belong to the company (an id from another
 *     tenant would be silently ignored by the engine and the rule would
 *     look configured while paying nobody);
 *   - a monthly_divisor rule never names an hourly-paid employee: the form
 *     divides the månadslön, which an hourly-paid employee does not have, so
 *     the engine would pass them over;
 *   - the scope pair (all employees XOR named employees), the amount field of
 *     the form and the validity order hold on the MERGED state of an update,
 *     where the stored row supplies what the patch leaves out.
 *
 * Deleting a rule that a payslip line derives from is refused by the schema
 * (salary_line_items.source_premium_rule_id is a NO ACTION foreign key), so
 * such a rule is switched off instead and the line keeps its source. Ending
 * a rule on a date (valid_to) is the normal way to stop it.
 *
 * Time values travel as 'HH:MM'. Postgres stores TIME as 'HH:MM:SS', so
 * reads normalise back to 'HH:MM' and both surfaces agree on one shape.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ShiftPremiumAmountForm, ShiftPremiumRule } from '@/types'
import {
  shiftPremiumAmountFieldError,
  shiftPremiumAmountMessage,
  shiftPremiumScopeIsConsistent,
  SHIFT_PREMIUM_VALIDITY_MESSAGE,
  type CreateShiftPremiumRuleInput,
  type UpdateShiftPremiumRuleInput,
} from '@/lib/api/schemas'

export type ShiftPremiumRuleResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown> }

// The select list is repeated as a literal at every call site on purpose:
// tests/schema/no-phantom-columns.test.ts can only check literal strings.

/** 'HH:MM:SS' (Postgres TIME) to 'HH:MM'. Already-short values pass through. */
export function toClockTime(value: string): string {
  return value.length > 5 ? value.slice(0, 5) : value
}

/** NUMERIC arrives as a string over PostgREST; null stays null. */
function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function normaliseRow(row: Record<string, unknown>): ShiftPremiumRule {
  return {
    ...(row as unknown as ShiftPremiumRule),
    start_time: toClockTime(String(row.start_time)),
    end_time: toClockTime(String(row.end_time)),
    amount_form: (row.amount_form as ShiftPremiumAmountForm | undefined) ?? 'percent_of_hourly',
    premium_percent: toNumberOrNull(row.premium_percent),
    monthly_divisor: toNumberOrNull(row.monthly_divisor),
    sek_per_hour: toNumberOrNull(row.sek_per_hour),
    hourly_divisor: toNumberOrNull(row.hourly_divisor),
    valid_from: (row.valid_from as string | null | undefined) ?? null,
    valid_to: (row.valid_to as string | null | undefined) ?? null,
    day_of_week: [...((row.day_of_week as number[]) ?? [])].sort((a, b) => a - b),
    applies_to_employee_ids: (row.applies_to_employee_ids as string[]) ?? [],
  }
}

export async function listShiftPremiumRules(
  supabase: SupabaseClient,
  args: { companyId: string; includeInactive?: boolean },
): Promise<ShiftPremiumRuleResult<ShiftPremiumRule[]>> {
  let query = supabase
    .from('shift_premium_rules')
    .select(
      'id, company_id, name, applies_to_all_employees, applies_to_employee_ids, day_of_week, start_time, end_time, amount_form, premium_percent, monthly_divisor, sek_per_hour, hourly_divisor, valid_from, valid_to, item_type, priority, is_active, created_at, updated_at, created_by',
    )
    .eq('company_id', args.companyId)
  if (!args.includeInactive) query = query.eq('is_active', true)

  const { data, error } = await query
    .order('priority', { ascending: false })
    .order('name', { ascending: true })
    .order('valid_from', { ascending: true, nullsFirst: true })
  if (error) return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  return { ok: true, data: (data ?? []).map((r) => normaliseRow(r as Record<string, unknown>)) }
}

export async function getShiftPremiumRule(
  supabase: SupabaseClient,
  args: { companyId: string; ruleId: string },
): Promise<ShiftPremiumRuleResult<ShiftPremiumRule>> {
  const { data, error } = await supabase
    .from('shift_premium_rules')
    .select(
      'id, company_id, name, applies_to_all_employees, applies_to_employee_ids, day_of_week, start_time, end_time, amount_form, premium_percent, monthly_divisor, sek_per_hour, hourly_divisor, valid_from, valid_to, item_type, priority, is_active, created_at, updated_at, created_by',
    )
    .eq('company_id', args.companyId)
    .eq('id', args.ruleId)
    .maybeSingle()
  if (error) return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  if (!data) return { ok: false, code: 'SHIFT_PREMIUM_RULE_NOT_FOUND' }
  return { ok: true, data: normaliseRow(data as Record<string, unknown>) }
}

/**
 * The named employees as the company holds them: the ids it does not own,
 * and the owned ones that are hourly-paid (outside a monthly_divisor rule).
 */
export async function checkNamedEmployees(
  supabase: SupabaseClient,
  companyId: string,
  employeeIds: string[],
): Promise<ShiftPremiumRuleResult<{ foreign: string[]; hourly: string[] }>> {
  if (employeeIds.length === 0) return { ok: true, data: { foreign: [], hourly: [] } }
  const { data, error } = await supabase
    .from('employees')
    .select('id, salary_type')
    .eq('company_id', companyId)
    .in('id', employeeIds)
  if (error) return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  const rows = (data ?? []) as Array<{ id: string; salary_type: string | null }>
  const known = new Set(rows.map((r) => r.id))
  return {
    ok: true,
    data: {
      foreign: employeeIds.filter((id) => !known.has(id)),
      hourly: rows.filter((r) => r.salary_type === 'hourly').map((r) => r.id),
    },
  }
}

/**
 * The checks every write runs on the rule it would leave behind: named
 * employees exist in the company, and a monthly_divisor rule names no
 * hourly-paid employee. Shared with the dry runs of the v1 routes.
 */
export async function verifyNamedEmployees(
  supabase: SupabaseClient,
  args: { companyId: string; amountForm: ShiftPremiumAmountForm; employeeIds: string[] },
): Promise<ShiftPremiumRuleResult<null>> {
  const checked = await checkNamedEmployees(supabase, args.companyId, args.employeeIds)
  if (!checked.ok) return checked
  if (checked.data.foreign.length > 0) {
    return {
      ok: false,
      code: 'SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND',
      details: { missing_employee_ids: checked.data.foreign },
    }
  }
  if (args.amountForm === 'monthly_divisor' && checked.data.hourly.length > 0) {
    return {
      ok: false,
      code: 'SHIFT_PREMIUM_RULE_HOURLY_EMPLOYEE',
      details: { hourly_employee_ids: checked.data.hourly },
    }
  }
  return { ok: true, data: null }
}

function mapWriteError(error: { code?: string; message?: string } | null, fallback: string) {
  // 23514: a CHECK the schemas mirror (amount fields, validity, bounds).
  return {
    ok: false as const,
    code: error?.code === '23514' ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
    details: { message: error?.message ?? fallback },
  }
}

export async function createShiftPremiumRule(
  supabase: SupabaseClient,
  args: { companyId: string; userId: string; input: CreateShiftPremiumRuleInput },
): Promise<ShiftPremiumRuleResult<ShiftPremiumRule>> {
  const { companyId, userId, input } = args

  const employeesOk = await verifyNamedEmployees(supabase, {
    companyId,
    amountForm: input.amount_form,
    employeeIds: input.applies_to_employee_ids,
  })
  if (!employeesOk.ok) return employeesOk

  const { data, error } = await supabase
    .from('shift_premium_rules')
    .insert({
      company_id: companyId,
      created_by: userId,
      name: input.name,
      day_of_week: [...input.day_of_week].sort((a, b) => a - b),
      start_time: input.start_time,
      end_time: input.end_time,
      amount_form: input.amount_form,
      premium_percent: input.premium_percent ?? null,
      monthly_divisor: input.monthly_divisor ?? null,
      sek_per_hour: input.sek_per_hour ?? null,
      hourly_divisor: input.hourly_divisor ?? null,
      valid_from: input.valid_from,
      valid_to: input.valid_to ?? null,
      item_type: input.item_type,
      priority: input.priority,
      applies_to_all_employees: input.applies_to_all_employees,
      applies_to_employee_ids: input.applies_to_employee_ids,
      is_active: input.is_active,
    })
    .select(
      'id, company_id, name, applies_to_all_employees, applies_to_employee_ids, day_of_week, start_time, end_time, amount_form, premium_percent, monthly_divisor, sek_per_hour, hourly_divisor, valid_from, valid_to, item_type, priority, is_active, created_at, updated_at, created_by',
    )
    .single()
  if (error || !data) return mapWriteError(error, 'insert returned no row')
  return { ok: true, data: normaliseRow(data as Record<string, unknown>) }
}

type AmountFields = {
  premium_percent: number | null
  monthly_divisor: number | null
  sek_per_hour: number | null
  hourly_divisor: number | null
}

/**
 * The amount fields an update writes. Sending amount_form switches the form:
 * the fields of the other forms are cleared, so the caller names only the
 * new form's field. Without amount_form the stored form stays and the patch
 * may only touch its own field (and hourly_divisor on a percent rule).
 */
function mergeAmountFields(
  existing: ShiftPremiumRule,
  input: UpdateShiftPremiumRuleInput,
): { form: ShiftPremiumAmountForm; fields: AmountFields } {
  const form = input.amount_form ?? existing.amount_form
  const switching = input.amount_form !== undefined && input.amount_form !== existing.amount_form
  const keep = (key: keyof AmountFields) => (switching ? null : existing[key])
  return {
    form,
    fields: {
      premium_percent: input.premium_percent ?? keep('premium_percent'),
      monthly_divisor: input.monthly_divisor ?? keep('monthly_divisor'),
      sek_per_hour: input.sek_per_hour ?? keep('sek_per_hour'),
      hourly_divisor: input.hourly_divisor !== undefined ? input.hourly_divisor : keep('hourly_divisor'),
    },
  }
}

export interface MergedShiftPremiumRule {
  /** The rule as the update would leave it. */
  rule: ShiftPremiumRule
  /** The columns the update writes (undefined = untouched). */
  patch: Record<string, unknown>
}

/**
 * The rule an update would leave behind, with every merged-state check
 * applied. Reads nothing but the named employees; the v1 dry run answers
 * with `rule`, the update writes `patch`.
 */
export async function mergeShiftPremiumRuleUpdate(
  supabase: SupabaseClient,
  args: { companyId: string; existing: ShiftPremiumRule; input: UpdateShiftPremiumRuleInput },
): Promise<ShiftPremiumRuleResult<MergedShiftPremiumRule>> {
  const { companyId, existing, input } = args

  // Scope is validated on the MERGED state: a patch that only flips
  // applies_to_all_employees to false must not leave the stored empty list
  // behind (a rule that applies to nobody but reads as configured).
  const mergedAll = input.applies_to_all_employees ?? existing.applies_to_all_employees
  const mergedIds = input.applies_to_employee_ids ?? existing.applies_to_employee_ids
  if (!shiftPremiumScopeIsConsistent(mergedAll, mergedIds)) {
    return { ok: false, code: 'SHIFT_PREMIUM_RULE_SCOPE_INVALID' }
  }

  const { form, fields } = mergeAmountFields(existing, input)
  const amountError = shiftPremiumAmountFieldError(form, fields)
  if (amountError) {
    return {
      ok: false,
      code: 'SHIFT_PREMIUM_RULE_FORM_INVALID',
      details: { field: amountError, message: shiftPremiumAmountMessage(amountError) },
    }
  }

  const mergedFrom = input.valid_from ?? existing.valid_from
  const mergedTo = input.valid_to !== undefined ? input.valid_to : existing.valid_to
  if (mergedFrom && mergedTo && mergedTo < mergedFrom) {
    return {
      ok: false,
      code: 'SHIFT_PREMIUM_RULE_VALIDITY_INVALID',
      details: { field: 'valid_to', message: SHIFT_PREMIUM_VALIDITY_MESSAGE },
    }
  }

  // Re-verify the named employees whenever the list or the form changes:
  // switching a rule to monthly_divisor must not keep an hourly-paid name.
  if (input.applies_to_employee_ids !== undefined || form !== existing.amount_form) {
    const employeesOk = await verifyNamedEmployees(supabase, {
      companyId,
      amountForm: form,
      employeeIds: mergedAll ? [] : mergedIds,
    })
    if (!employeesOk.ok) return employeesOk
  }

  const amountTouched =
    input.amount_form !== undefined ||
    input.premium_percent !== undefined ||
    input.monthly_divisor !== undefined ||
    input.sek_per_hour !== undefined ||
    input.hourly_divisor !== undefined

  const patch: Record<string, unknown> = {
    name: input.name,
    day_of_week: input.day_of_week ? [...input.day_of_week].sort((a, b) => a - b) : undefined,
    start_time: input.start_time,
    end_time: input.end_time,
    valid_from: input.valid_from,
    valid_to: input.valid_to,
    item_type: input.item_type,
    priority: input.priority,
    applies_to_all_employees: input.applies_to_all_employees,
    applies_to_employee_ids: input.applies_to_employee_ids,
    is_active: input.is_active,
    ...(amountTouched ? { amount_form: form, ...fields } : {}),
  }

  const rule = {
    ...existing,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  } as ShiftPremiumRule
  return { ok: true, data: { rule, patch } }
}

export async function updateShiftPremiumRule(
  supabase: SupabaseClient,
  args: { companyId: string; ruleId: string; input: UpdateShiftPremiumRuleInput },
): Promise<ShiftPremiumRuleResult<ShiftPremiumRule>> {
  const { companyId, ruleId, input } = args

  const existing = await getShiftPremiumRule(supabase, { companyId, ruleId })
  if (!existing.ok) return existing

  const merged = await mergeShiftPremiumRuleUpdate(supabase, { companyId, existing: existing.data, input })
  if (!merged.ok) return merged
  const { patch } = merged.data

  // Literal keys with undefined for untouched fields: JSON serialisation
  // drops them, so PostgREST only sees the patched columns, and the phantom
  // column scanner can read every key.
  const { data, error } = await supabase
    .from('shift_premium_rules')
    .update({
      name: patch.name,
      day_of_week: patch.day_of_week,
      start_time: patch.start_time,
      end_time: patch.end_time,
      amount_form: patch.amount_form,
      premium_percent: patch.premium_percent,
      monthly_divisor: patch.monthly_divisor,
      sek_per_hour: patch.sek_per_hour,
      hourly_divisor: patch.hourly_divisor,
      valid_from: patch.valid_from,
      valid_to: patch.valid_to,
      item_type: patch.item_type,
      priority: patch.priority,
      applies_to_all_employees: patch.applies_to_all_employees,
      applies_to_employee_ids: patch.applies_to_employee_ids,
      is_active: patch.is_active,
    })
    .eq('company_id', companyId)
    .eq('id', ruleId)
    .select(
      'id, company_id, name, applies_to_all_employees, applies_to_employee_ids, day_of_week, start_time, end_time, amount_form, premium_percent, monthly_divisor, sek_per_hour, hourly_divisor, valid_from, valid_to, item_type, priority, is_active, created_at, updated_at, created_by',
    )
    .single()
  if (error || !data) {
    if (error?.code === 'PGRST116') return { ok: false, code: 'SHIFT_PREMIUM_RULE_NOT_FOUND' }
    return mapWriteError(error, 'update returned no row')
  }
  return { ok: true, data: normaliseRow(data as Record<string, unknown>) }
}

export interface ShiftPremiumRuleDeletion {
  id: string
  /** The row is gone: no payslip line derived from it. */
  deleted: boolean
  /** A payslip line derives from it: kept and switched off instead. */
  deactivated: boolean
}

/**
 * Remove a rule. Rules are configuration, so a rule nothing derives from is
 * hard-deleted. A rule a payslip line already derives from (draft or booked)
 * is kept and switched off: the NO ACTION key on
 * salary_line_items.source_premium_rule_id refuses the delete (23503), and the
 * line keeps the rule it was paid under. A switched-off rule derives nothing
 * on the next calculation. Deleting an unknown id is reported, not swallowed.
 */
export async function deleteShiftPremiumRule(
  supabase: SupabaseClient,
  args: { companyId: string; ruleId: string },
): Promise<ShiftPremiumRuleResult<ShiftPremiumRuleDeletion>> {
  const { data, error } = await supabase
    .from('shift_premium_rules')
    .delete()
    .eq('company_id', args.companyId)
    .eq('id', args.ruleId)
    .select('id')
  if (error?.code === '23503') {
    const { data: off, error: offError } = await supabase
      .from('shift_premium_rules')
      .update({ is_active: false })
      .eq('company_id', args.companyId)
      .eq('id', args.ruleId)
      .select('id')
    if (offError) return { ok: false, code: 'INTERNAL_ERROR', details: { message: offError.message } }
    if (!off || off.length === 0) return { ok: false, code: 'SHIFT_PREMIUM_RULE_NOT_FOUND' }
    return { ok: true, data: { id: args.ruleId, deleted: false, deactivated: true } }
  }
  if (error) return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  if (!data || data.length === 0) return { ok: false, code: 'SHIFT_PREMIUM_RULE_NOT_FOUND' }
  return { ok: true, data: { id: args.ruleId, deleted: true, deactivated: false } }
}
