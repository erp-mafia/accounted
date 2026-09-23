/**
 * Shared employee recurring line (återkommande lönerad) commands.
 *
 * Single source of truth for reading and writing employee_recurring_lines
 * rows, consumed by the internal dashboard routes
 * (app/api/salary/employees/[id]/recurring-lines/**) and the v1 REST routes
 * (app/api/v1/.../employees/[id]/recurring-lines/**).
 *
 * A recurring line is a standing payslip row (a monthly gross deduction for
 * a benefit bike, a union fee, a net deduction for a benefit the employee
 * pays for, ...) that the calculation engine derives into every salary run
 * whose payment_date falls inside valid_from..valid_to
 * (lib/salary/run-calculation.ts, step 8d3). Rules enforced here so they
 * cannot drift between surfaces:
 *   - the amount sign follows the item type: every supported type is a
 *     deduction and must be negative, mirroring the
 *     employee_recurring_lines_amount_sign CHECK;
 *   - valid_to, when set, is on or after valid_from, checked against the
 *     MERGED state on update (the partial schema only sees the body);
 *   - account_number is a four-digit BAS number or null (null lets the
 *     engine fall back to its item-type mapping);
 *   - money is rounded with roundOre();
 *   - deleting a line that a run has already derived from is refused by the
 *     NO ACTION FK on salary_line_items.source_recurring_line_id; the line is
 *     deactivated instead so the provenance link stays intact.
 *
 * Result-object convention mirrors lib/salary/absence.ts:
 * `{ ok: true, data } | { ok: false, code, details?, cause? }` where `code`
 * is a key in lib/errors/structured-errors.ts. `cause` carries the raw
 * database error for surfaces that render their own copy (the dashboard's
 * getErrorMessage); it is never part of `details`, so the v1 envelope never
 * echoes database internals.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import {
  RECURRING_LINE_PERIOD_ORDER_MESSAGE,
  type CreateEmployeeRecurringLineSchema,
  type UpdateEmployeeRecurringLineSchema,
} from '@/lib/api/schemas'
import { ACCOUNT_NUMBER_MESSAGE, ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'
import { roundOre } from '@/lib/money'
import {
  validateRecurringLineAmount,
  type RecurringLineItemType,
} from '@/lib/salary/recurring-lines'

export interface RecurringLineFailure {
  ok: false
  /** A key in lib/errors/structured-errors.ts. */
  code: string
  /** Wire-safe context (issues, ids, counts). Never the raw DB error. */
  details?: Record<string, unknown>
  /** The raw database error, for callers that map it to their own copy. */
  cause?: unknown
}

export type RecurringLineResult<T> = { ok: true; data: T } | RecurringLineFailure

export interface EmployeeRecurringLineRow {
  id: string
  employee_id: string
  company_id: string
  user_id: string
  item_type: RecurringLineItemType
  description: string
  amount: number
  account_number: string | null
  valid_from: string
  valid_to: string | null
  metadata: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
}

/** The would-be row a dry-run create returns: no id, no timestamps yet. */
export type EmployeeRecurringLinePreview = Omit<
  EmployeeRecurringLineRow,
  'id' | 'created_at' | 'updated_at'
> & { id: null; created_at: null; updated_at: null }

export type CreateEmployeeRecurringLineInput = z.infer<typeof CreateEmployeeRecurringLineSchema>
export type UpdateEmployeeRecurringLineInput = z.infer<typeof UpdateEmployeeRecurringLineSchema>

export type DeleteEmployeeRecurringLineOutcome =
  | { id: string; deleted: true }
  | { id: string; deleted: false; deactivated: true }

/** Every column on the table, as a literal so the phantom-column scanner
 * can verify the select. The dashboard historically selected `*`; listing
 * the columns keeps its payload identical. */
export const RECURRING_LINE_COLUMNS =
  'id, employee_id, company_id, user_id, item_type, description, amount, account_number, ' +
  'valid_from, valid_to, metadata, is_active, created_at, updated_at'

function validationFailure(field: string, message: string): RecurringLineFailure {
  return { ok: false, code: 'VALIDATION_ERROR', details: { issues: [{ field, message }] } }
}

function lineNotFound(lineId: string): RecurringLineFailure {
  return {
    ok: false,
    code: 'NOT_FOUND',
    details: { resource: 'employee_recurring_line', employee_recurring_line_id: lineId },
  }
}

function dbFailure(
  error: { code?: string; message?: string },
  code: string = 'INTERNAL_ERROR',
): RecurringLineFailure {
  // The raw PostgreSQL message stays on `cause` (dashboard rendering via
  // getErrorMessage); the wire-facing details carry only the SQLSTATE.
  return { ok: false, code, details: { pg_code: error.code }, cause: error }
}

/**
 * Map a failed write. 42501 is a privilege/RLS denial (a server-side
 * configuration bug, kept distinct from INTERNAL_ERROR so it is
 * diagnosable); 23514 is a CHECK violation, which the callers' schemas
 * mirror, so it only fires for non-schema input: bad input, not a fault.
 */
function mapWriteError(error: { code?: string; message?: string }): RecurringLineFailure {
  if (error.code === '42501') return dbFailure(error, 'DB_PERMISSION_DENIED')
  if (error.code === '23514') return dbFailure(error, 'VALIDATION_ERROR')
  return dbFailure(error)
}

async function assertEmployee(
  supabase: SupabaseClient,
  companyId: string,
  employeeId: string,
): Promise<RecurringLineResult<{ id: string }>> {
  // maybeSingle separates the two empty outcomes: a lookup failure is an
  // internal error, only zero rows is EMPLOYEE_NOT_FOUND.
  const { data, error } = await supabase
    .from('employees')
    .select('id')
    .eq('id', employeeId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) return dbFailure(error)
  if (!data) return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
  return { ok: true, data: data as { id: string } }
}

/** Inclusive bound: valid_to on the same day as valid_from is legal, and a
 * null valid_to (open-ended line) always is. */
function periodFailure(validFrom: string | null, validTo: string | null): RecurringLineFailure | null {
  if (validFrom !== null && validTo !== null && validTo < validFrom) {
    return validationFailure('valid_to', RECURRING_LINE_PERIOD_ORDER_MESSAGE)
  }
  return null
}

/** Mirrors employee_recurring_lines_account_format: four digits or null. */
function accountFailure(accountNumber: string | null | undefined): RecurringLineFailure | null {
  if (accountNumber === null || accountNumber === undefined) return null
  if (!ACCOUNT_NUMBER_RE.test(accountNumber)) {
    return validationFailure('account_number', ACCOUNT_NUMBER_MESSAGE)
  }
  return null
}

function amountFailure(itemType: RecurringLineItemType, amount: number): RecurringLineFailure | null {
  const message = validateRecurringLineAmount(itemType, amount)
  return message ? validationFailure('amount', message) : null
}

export async function listEmployeeRecurringLines(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    /** true: active lines only; false: deactivated only; omitted: every line. */
    isActive?: boolean
  },
): Promise<RecurringLineResult<EmployeeRecurringLineRow[]>> {
  const emp = await assertEmployee(supabase, args.companyId, args.employeeId)
  if (!emp.ok) return emp

  let query = supabase
    .from('employee_recurring_lines')
    .select('id, employee_id, company_id, user_id, item_type, description, amount, account_number, valid_from, valid_to, metadata, is_active, created_at, updated_at')
    .eq('employee_id', args.employeeId)
    .eq('company_id', args.companyId)
    .order('valid_from', { ascending: false })

  if (args.isActive !== undefined) {
    query = query.eq('is_active', args.isActive)
  }

  const { data, error } = await query
  if (error) return dbFailure(error)
  return { ok: true, data: (data ?? []) as unknown as EmployeeRecurringLineRow[] }
}

export async function createEmployeeRecurringLine(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    userId: string
    input: CreateEmployeeRecurringLineInput
    /** Validate only; return the would-be row without writing. */
    dryRun?: boolean
  },
): Promise<RecurringLineResult<EmployeeRecurringLineRow | EmployeeRecurringLinePreview>> {
  const { input } = args

  // Input rules first: they need no database round trip, and a caller that
  // bypassed the schema (MCP, scripts) gets the same field-level answer.
  const invalid =
    amountFailure(input.item_type, input.amount) ??
    periodFailure(input.valid_from, input.valid_to ?? null) ??
    accountFailure(input.account_number)
  if (invalid) return invalid

  const emp = await assertEmployee(supabase, args.companyId, args.employeeId)
  if (!emp.ok) return emp

  const row = {
    employee_id: args.employeeId,
    company_id: args.companyId,
    user_id: args.userId,
    item_type: input.item_type,
    description: input.description,
    amount: roundOre(input.amount),
    account_number: input.account_number ?? null,
    valid_from: input.valid_from,
    valid_to: input.valid_to ?? null,
    metadata: input.metadata ?? {},
    is_active: input.is_active ?? true,
  }

  if (args.dryRun) {
    return { ok: true, data: { ...row, id: null, created_at: null, updated_at: null } }
  }

  const { data, error } = await supabase
    .from('employee_recurring_lines')
    .insert({
      employee_id: row.employee_id,
      company_id: row.company_id,
      user_id: row.user_id,
      item_type: row.item_type,
      description: row.description,
      amount: row.amount,
      account_number: row.account_number,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      metadata: row.metadata,
      is_active: row.is_active,
    })
    .select('id, employee_id, company_id, user_id, item_type, description, amount, account_number, valid_from, valid_to, metadata, is_active, created_at, updated_at')
    .single()

  if (error) return mapWriteError(error)
  return { ok: true, data: data as unknown as EmployeeRecurringLineRow }
}

export async function updateEmployeeRecurringLine(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    lineId: string
    patch: UpdateEmployeeRecurringLineInput
    /** Validate against the stored row and return the merged result without writing. */
    dryRun?: boolean
  },
): Promise<RecurringLineResult<EmployeeRecurringLineRow>> {
  const { patch } = args

  // The (id, employee_id, company_id) filter is the ownership check: a line
  // under another employee or company is simply not found.
  const { data: existingRow, error: fetchError } = await supabase
    .from('employee_recurring_lines')
    .select('id, employee_id, company_id, user_id, item_type, description, amount, account_number, valid_from, valid_to, metadata, is_active, created_at, updated_at')
    .eq('id', args.lineId)
    .eq('employee_id', args.employeeId)
    .eq('company_id', args.companyId)
    .maybeSingle()

  // Only zero rows means the line is not there. A transport/DB failure is
  // not a missing record and must not be reported as one.
  if (fetchError && fetchError.code !== 'PGRST116') return dbFailure(fetchError)
  if (!existingRow) return lineNotFound(args.lineId)
  const existing = existingRow as unknown as EmployeeRecurringLineRow

  // Amount sign against the stored item_type: the partial schema cannot
  // check this because item_type is not patchable and never in the body.
  if (patch.amount !== undefined) {
    const invalid = amountFailure(existing.item_type, patch.amount)
    if (invalid) return invalid
  }

  // Validity period against the MERGED state: when only one half is patched
  // the other half lives on the stored row.
  const mergedValidFrom = patch.valid_from ?? existing.valid_from ?? null
  const mergedValidTo = patch.valid_to !== undefined ? patch.valid_to : (existing.valid_to ?? null)
  const invalidPeriod = periodFailure(mergedValidFrom, mergedValidTo)
  if (invalidPeriod) return invalidPeriod

  const invalidAccount = accountFailure(patch.account_number)
  if (invalidAccount) return invalidAccount

  // Explicit literal keys (not a body spread) so the phantom-column scanner
  // can verify every column this update can touch.
  const updates: Record<string, unknown> = {}
  if (patch.description !== undefined) updates.description = patch.description
  if (patch.amount !== undefined) updates.amount = roundOre(patch.amount)
  if (patch.account_number !== undefined) updates.account_number = patch.account_number
  if (patch.valid_from !== undefined) updates.valid_from = patch.valid_from
  if (patch.valid_to !== undefined) updates.valid_to = patch.valid_to
  if (patch.metadata !== undefined) updates.metadata = patch.metadata
  if (patch.is_active !== undefined) updates.is_active = patch.is_active

  // Nothing to change: answer with the stored row instead of issuing an
  // empty UPDATE.
  if (Object.keys(updates).length === 0) return { ok: true, data: existing }

  if (args.dryRun) {
    return { ok: true, data: { ...existing, ...updates } as EmployeeRecurringLineRow }
  }

  const { data, error } = await supabase
    .from('employee_recurring_lines')
    // Literal keys so the phantom-column scanner can verify every column;
    // undefined values are dropped by supabase-js serialisation.
    .update({
      description: updates.description,
      amount: updates.amount,
      account_number: updates.account_number,
      valid_from: updates.valid_from,
      valid_to: updates.valid_to,
      metadata: updates.metadata,
      is_active: updates.is_active,
    })
    .eq('id', args.lineId)
    .eq('employee_id', args.employeeId)
    .eq('company_id', args.companyId)
    .select('id, employee_id, company_id, user_id, item_type, description, amount, account_number, valid_from, valid_to, metadata, is_active, created_at, updated_at')
    .single()

  if (error) {
    // The row's existence was established above, so this is a write failure.
    // PGRST116 (zero rows) is the one shape that still means not-found: the
    // row was deleted or moved out of the company between fetch and update.
    if (error.code === 'PGRST116') return lineNotFound(args.lineId)
    // Both the amount sign and the merged period were validated above, so a
    // check_violation here is a concurrent write that moved the other half
    // of the period after our check. Answer with the period copy.
    if (error.code === '23514') {
      return {
        ...validationFailure('valid_to', RECURRING_LINE_PERIOD_ORDER_MESSAGE),
        cause: error,
      }
    }
    return mapWriteError(error)
  }
  if (!data) return lineNotFound(args.lineId)

  return { ok: true, data: data as unknown as EmployeeRecurringLineRow }
}

export async function deleteEmployeeRecurringLine(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    lineId: string
    /** Resolve the outcome (delete vs deactivate) without writing. */
    dryRun?: boolean
  },
): Promise<RecurringLineResult<DeleteEmployeeRecurringLineOutcome>> {
  if (args.dryRun) {
    // The real path learns "referenced" from the FK at delete time; the
    // preview has to ask, so it can tell the caller which outcome to expect.
    const { data: existing, error: fetchError } = await supabase
      .from('employee_recurring_lines')
      .select('id')
      .eq('id', args.lineId)
      .eq('employee_id', args.employeeId)
      .eq('company_id', args.companyId)
      .maybeSingle()
    if (fetchError) return dbFailure(fetchError)
    if (!existing) return lineNotFound(args.lineId)

    const { count, error: countError } = await supabase
      .from('salary_line_items')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', args.companyId)
      .eq('source_recurring_line_id', args.lineId)
    if (countError) return dbFailure(countError)

    return (count ?? 0) > 0
      ? { ok: true, data: { id: args.lineId, deleted: false, deactivated: true } }
      : { ok: true, data: { id: args.lineId, deleted: true } }
  }

  // Delete-first, no pre-check: the FK from salary_line_items is NO ACTION,
  // so the database itself refuses (23503) whenever any derived row
  // references the line, including one inserted by a calculation racing
  // this request. A referenced line is deactivated instead: the provenance
  // link stays intact, the next recalculation drops draft derived rows and
  // never re-derives.
  // Selecting the deleted row separates "deleted" from "matched nothing": a
  // filtered DELETE reports no error when the id is unknown or belongs to
  // another company.
  const { data: deleted, error } = await supabase
    .from('employee_recurring_lines')
    .delete()
    .eq('id', args.lineId)
    .eq('employee_id', args.employeeId)
    .eq('company_id', args.companyId)
    .select('id')
    .maybeSingle()

  if (error && error.code !== '23503') return dbFailure(error)

  if (error) {
    const { error: deactivateError } = await supabase
      .from('employee_recurring_lines')
      .update({ is_active: false })
      .eq('id', args.lineId)
      .eq('employee_id', args.employeeId)
      .eq('company_id', args.companyId)

    if (deactivateError) return dbFailure(deactivateError)
    return { ok: true, data: { id: args.lineId, deleted: false, deactivated: true } }
  }

  if (!deleted) return lineNotFound(args.lineId)
  return { ok: true, data: { id: args.lineId, deleted: true } }
}
