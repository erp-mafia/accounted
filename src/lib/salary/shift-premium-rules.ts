/**
 * Shift premium rules (OB-tillagg / overtid): the CRUD service behind the
 * dashboard routes, the v1 REST mirror and the settings panel.
 *
 * The table (shift_premium_rules, migration 20260526120900) has fed
 * lib/salary/shift-premium-engine.ts since May 2026, but nothing could write
 * to it: every rule had to be inserted by hand in the database. This module
 * is the one write path, so both API surfaces share the same checks:
 *
 *   - every named employee must belong to the company (an id from another
 *     tenant would be silently ignored by the engine and the rule would
 *     look configured while paying nobody);
 *   - the scope pair stays consistent (all employees XOR named employees),
 *     also for partial updates, where the stored row supplies the other half.
 *
 * Time values travel as 'HH:MM'. Postgres stores TIME as 'HH:MM:SS', so
 * reads normalise back to 'HH:MM' and both surfaces agree on one shape.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ShiftPremiumRule } from '@/types'
import {
  shiftPremiumScopeIsConsistent,
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

function normaliseRow(row: Record<string, unknown>): ShiftPremiumRule {
  return {
    ...(row as unknown as ShiftPremiumRule),
    start_time: toClockTime(String(row.start_time)),
    end_time: toClockTime(String(row.end_time)),
    // NUMERIC(5,2) arrives as a string over PostgREST.
    premium_percent: Number(row.premium_percent),
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
      'id, company_id, name, applies_to_all_employees, applies_to_employee_ids, day_of_week, start_time, end_time, premium_percent, item_type, priority, is_active, created_at, updated_at, created_by',
    )
    .eq('company_id', args.companyId)
  if (!args.includeInactive) query = query.eq('is_active', true)

  const { data, error } = await query
    .order('priority', { ascending: false })
    .order('name', { ascending: true })
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
      'id, company_id, name, applies_to_all_employees, applies_to_employee_ids, day_of_week, start_time, end_time, premium_percent, item_type, priority, is_active, created_at, updated_at, created_by',
    )
    .eq('company_id', args.companyId)
    .eq('id', args.ruleId)
    .maybeSingle()
  if (error) return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  if (!data) return { ok: false, code: 'SHIFT_PREMIUM_RULE_NOT_FOUND' }
  return { ok: true, data: normaliseRow(data as Record<string, unknown>) }
}

/**
 * Every named employee must exist in this company. Returns the ids that do
 * not, so the caller can name them instead of failing on the first.
 */
export async function findForeignEmployeeIds(
  supabase: SupabaseClient,
  companyId: string,
  employeeIds: string[],
): Promise<ShiftPremiumRuleResult<string[]>> {
  if (employeeIds.length === 0) return { ok: true, data: [] }
  const { data, error } = await supabase
    .from('employees')
    .select('id')
    .eq('company_id', companyId)
    .in('id', employeeIds)
  if (error) return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  const known = new Set((data ?? []).map((r) => (r as { id: string }).id))
  return { ok: true, data: employeeIds.filter((id) => !known.has(id)) }
}

export async function createShiftPremiumRule(
  supabase: SupabaseClient,
  args: { companyId: string; userId: string; input: CreateShiftPremiumRuleInput },
): Promise<ShiftPremiumRuleResult<ShiftPremiumRule>> {
  const { companyId, userId, input } = args

  const foreign = await findForeignEmployeeIds(supabase, companyId, input.applies_to_employee_ids)
  if (!foreign.ok) return foreign
  if (foreign.data.length > 0) {
    return {
      ok: false,
      code: 'SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND',
      details: { missing_employee_ids: foreign.data },
    }
  }

  const { data, error } = await supabase
    .from('shift_premium_rules')
    .insert({
      company_id: companyId,
      created_by: userId,
      name: input.name,
      day_of_week: [...input.day_of_week].sort((a, b) => a - b),
      start_time: input.start_time,
      end_time: input.end_time,
      premium_percent: input.premium_percent,
      item_type: input.item_type,
      priority: input.priority,
      applies_to_all_employees: input.applies_to_all_employees,
      applies_to_employee_ids: input.applies_to_employee_ids,
      is_active: input.is_active,
    })
    .select(
      'id, company_id, name, applies_to_all_employees, applies_to_employee_ids, day_of_week, start_time, end_time, premium_percent, item_type, priority, is_active, created_at, updated_at, created_by',
    )
    .single()
  if (error || !data) {
    return {
      ok: false,
      code: error?.code === '23514' ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
      details: { message: error?.message ?? 'insert returned no row' },
    }
  }
  return { ok: true, data: normaliseRow(data as Record<string, unknown>) }
}

export async function updateShiftPremiumRule(
  supabase: SupabaseClient,
  args: { companyId: string; ruleId: string; input: UpdateShiftPremiumRuleInput },
): Promise<ShiftPremiumRuleResult<ShiftPremiumRule>> {
  const { companyId, ruleId, input } = args

  const existing = await getShiftPremiumRule(supabase, { companyId, ruleId })
  if (!existing.ok) return existing

  // Scope is validated on the MERGED state: a patch that only flips
  // applies_to_all_employees to false must not leave the stored empty list
  // behind (a rule that applies to nobody but reads as configured).
  const mergedAll = input.applies_to_all_employees ?? existing.data.applies_to_all_employees
  const mergedIds = input.applies_to_employee_ids ?? existing.data.applies_to_employee_ids
  if (!shiftPremiumScopeIsConsistent(mergedAll, mergedIds)) {
    return { ok: false, code: 'SHIFT_PREMIUM_RULE_SCOPE_INVALID' }
  }

  if (input.applies_to_employee_ids !== undefined) {
    const foreign = await findForeignEmployeeIds(supabase, companyId, input.applies_to_employee_ids)
    if (!foreign.ok) return foreign
    if (foreign.data.length > 0) {
      return {
        ok: false,
        code: 'SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND',
        details: { missing_employee_ids: foreign.data },
      }
    }
  }

  // Literal keys with undefined for untouched fields: JSON serialisation
  // drops them, so PostgREST only sees the patched columns, and the phantom
  // column scanner can read every key.
  const { data, error } = await supabase
    .from('shift_premium_rules')
    .update({
      name: input.name,
      day_of_week: input.day_of_week ? [...input.day_of_week].sort((a, b) => a - b) : undefined,
      start_time: input.start_time,
      end_time: input.end_time,
      premium_percent: input.premium_percent,
      item_type: input.item_type,
      priority: input.priority,
      applies_to_all_employees: input.applies_to_all_employees,
      applies_to_employee_ids: input.applies_to_employee_ids,
      is_active: input.is_active,
    })
    .eq('company_id', companyId)
    .eq('id', ruleId)
    .select(
      'id, company_id, name, applies_to_all_employees, applies_to_employee_ids, day_of_week, start_time, end_time, premium_percent, item_type, priority, is_active, created_at, updated_at, created_by',
    )
    .single()
  if (error || !data) {
    if (error?.code === 'PGRST116') return { ok: false, code: 'SHIFT_PREMIUM_RULE_NOT_FOUND' }
    return {
      ok: false,
      code: error?.code === '23514' ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
      details: { message: error?.message ?? 'update returned no row' },
    }
  }
  return { ok: true, data: normaliseRow(data as Record<string, unknown>) }
}

/**
 * Hard delete. Rules are configuration, not rakenskapsinformation: derived
 * premium lines are regenerated from the current rules on every calculation
 * of an open run, and a booked run's verifikat is immutable regardless, so
 * nothing legal hangs on the rule row. Deleting an unknown id is reported,
 * not silently swallowed.
 */
export async function deleteShiftPremiumRule(
  supabase: SupabaseClient,
  args: { companyId: string; ruleId: string },
): Promise<ShiftPremiumRuleResult<{ id: string; deleted: true }>> {
  const { data, error } = await supabase
    .from('shift_premium_rules')
    .delete()
    .eq('company_id', args.companyId)
    .eq('id', args.ruleId)
    .select('id')
  if (error) return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  if (!data || data.length === 0) return { ok: false, code: 'SHIFT_PREMIUM_RULE_NOT_FOUND' }
  return { ok: true, data: { id: args.ruleId, deleted: true } }
}
