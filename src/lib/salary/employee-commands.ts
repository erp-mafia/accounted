/**
 * Employee master-data commands: the one create and update every door runs.
 *
 * Doors: the dashboard routes (app/api/salary/employees and [id]), the v1
 * routes (app/api/v1/companies/[companyId]/employees and [id]), and the MCP
 * staging tools (gnubok_create_employee / gnubok_update_employee, which run
 * these in dry-run) with their commit executors. Each door parses its own
 * request shape and phrases the result; the rules live here, so a door
 * cannot skip one (the v1 PATCH used to skip the EF-owner rule, and the MCP
 * create skipped the personnummer check digit).
 *
 * PII contract: these functions NEVER receive a plaintext personnummer. The
 * door validates and seals it with sealPersonnummer; the service gets only
 * { personnummer_encrypted, personnummer_last4 }, which is also all that
 * pending_operations.params ever holds. Every row a command returns is
 * masked (maskRow, maskEmployeeForResponse's shape): no ciphertext, no last4,
 * the display form under `personnummer_masked`.
 *
 * Soft delete is lib/salary/employee-soft-delete.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { CreateEmployeeSchema, UpdateEmployeeSchema } from '@/lib/api/schemas'
import {
  decryptPersonnummer,
  encryptPersonnummer,
  extractLast4,
  maskPersonnummer,
  validatePersonnummer,
} from '@/lib/salary/personnummer'
import { REDACTED_PERSONNUMMER } from '@/lib/salary/personnummer-format'
import { getCompanyEntityType } from '@/lib/company/context'
import { isEmploymentTypeAllowedForEntity, EF_OWNER_EMPLOYMENT_ERROR } from '@/lib/salary/employment-rules'
import { validateEmployeeBankAccount } from '@/lib/salary/payment/bank-account'
import { jamkningIssueFromDbError, validateJamkning, type JamkningFields } from '@/lib/salary/jamkning-rules'
import { extraTaxIssueFromDbError, validateExtraTax } from '@/lib/salary/extra-tax'
import { validateEmployeeUpdate, type EmployeeUpdateIssue } from '@/lib/salary/employee-update-rules'

export type EmployeeCommandResult<T> =
  | { ok: true; data: T }
  | {
      ok: false
      code: string
      details?: Record<string, unknown>
      /** The raw database error behind INTERNAL_ERROR, for the door to classify. */
      cause?: unknown
    }

export interface EmployeeSummaryResult {
  /** Null on a dry run of a create: no row exists yet. */
  employee_id: string | null
  first_name: string
  last_name: string
  personnummer_masked: string
  is_active: boolean
}

/** A command's answer: the summary, plus the masked row in the caller's columns. */
export type EmployeeCommandData = EmployeeSummaryResult & {
  row: Record<string, unknown>
}

export interface EmployeeUpdateData extends EmployeeCommandData {
  /** The stored row before the update, masked, in the caller's columns. */
  previous: Record<string, unknown>
  /** The columns the update writes (empty for a no-op). */
  changes: Record<string, unknown>
}

/** A personnummer as the service receives it: sealed for storage. */
export interface SealedIdentity {
  personnummer_encrypted: string
  personnummer_last4: string
}

/**
 * Validate a plaintext personnummer and seal it for storage: the one check
 * every door runs before a personnummer reaches the service (date and Luhn
 * check digit, so a number Skatteverket would reject on the AGI is refused
 * at entry). A masked display value is refused explicitly:
 * validatePersonnummer strips non-digits, so a decorated value carrying 12
 * real digits would otherwise pass. The message never echoes the input.
 */
export function sealPersonnummer(
  raw: unknown,
): { ok: true; identity: SealedIdentity } | { ok: false; message: string } {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      ok: false,
      message: 'Personnummer kan inte tömmas. Utelämna fältet för att lämna det oförändrat.',
    }
  }
  if (/x/i.test(raw)) {
    return {
      ok: false,
      message:
        'Maskerat personnummer kan inte sparas. Skicka hela personnummret (12 siffror) eller utelämna fältet.',
    }
  }
  const validation = validatePersonnummer(raw)
  if (!validation.valid) return { ok: false, message: validation.error ?? 'Ogiltigt personnummer' }
  return {
    ok: true,
    identity: { personnummer_encrypted: encryptPersonnummer(raw), personnummer_last4: extractLast4(raw) },
  }
}

/**
 * Columns an executor is allowed to write: the keys of the schema the staging
 * tool validated the input with, per verb. Anything else in params is ignored
 * (defense in depth against a tampered pending_operations row).
 *
 * Read off the schemas instead of kept as a second hand-written list. The
 * list used to stand here on its own, so a key the tool advertised and staged
 * (is_active) was dropped at this last step: sent with another field the
 * approval answered success with the flag unwritten, sent alone it failed
 * after the preview had shown the change (crm#1133). The create and update
 * sets differ exactly where the schemas do: is_active is update-only.
 * personnummer is in both schemas and never writable here (see the PII
 * contract above).
 */
function writableColumns(shape: Record<string, unknown>): ReadonlySet<string> {
  return new Set(Object.keys(shape).filter((key) => key !== 'personnummer'))
}

export const EMPLOYEE_CREATE_COLUMNS = writableColumns(CreateEmployeeSchema.shape)
export const EMPLOYEE_UPDATE_COLUMNS = writableColumns(UpdateEmployeeSchema.shape)

/** Undefined means absent (column unchanged); null is kept, it clears the
 * column (the update contract, #3008). */
function pickWritable(
  fields: Record<string, unknown>,
  writable: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (writable.has(key) && value !== undefined) {
      out[key] = value
    }
  }
  return out
}

/**
 * maskEmployeeForResponse's shape (no ciphertext, no last4, the display form
 * under `personnummer_masked`), but never throwing: a row whose ciphertext
 * cannot be decrypted (a wrong key on a restored database) answers redacted
 * rather than failing a write that already happened.
 */
function maskRow(row: Record<string, unknown>): Record<string, unknown> {
  const { personnummer, personnummer_last4: _last4, ...rest } = row
  let masked = REDACTED_PERSONNUMMER
  if (typeof personnummer === 'string' && personnummer !== '') {
    try {
      masked = maskPersonnummer(decryptPersonnummer(personnummer))
    } catch {
      // Undecryptable: stays redacted.
    }
  }
  return { ...rest, personnummer_masked: masked }
}

/** What every answer needs, whatever columns the caller asked for. */
const SUMMARY_COLUMNS = ['id', 'first_name', 'last_name', 'personnummer', 'is_active']

function columnList(columns: string): string[] {
  return columns.split(',').map((c) => c.trim()).filter(Boolean)
}

function selectColumns(columns: string | undefined): string {
  if (!columns || columns === '*') return '*'
  return [...new Set([...SUMMARY_COLUMNS, ...columnList(columns)])].join(', ')
}

/**
 * A masked row in the caller's columns: a row read with '*' (a dry run, a
 * no-op) gets the shape a write would have read back, a column the dry run of
 * a create leaves to the database reading null. personnummer stands for its
 * masked form.
 */
function project(masked: Record<string, unknown>, columns: string | undefined): Record<string, unknown> {
  if (!columns || columns === '*') return masked
  const out: Record<string, unknown> = {}
  for (const column of columnList(columns)) {
    if (column === 'personnummer') out.personnummer_masked = masked.personnummer_masked
    else out[column] = masked[column] ?? null
  }
  return out
}

function summaryOf(masked: Record<string, unknown>, employeeId: string | null): EmployeeSummaryResult {
  return {
    employee_id: employeeId,
    first_name: masked.first_name as string,
    last_name: masked.last_name as string,
    personnummer_masked: masked.personnummer_masked as string,
    is_active: masked.is_active as boolean,
  }
}

function issuesRefusal(issues: EmployeeUpdateIssue[]): EmployeeCommandResult<never> {
  return {
    ok: false,
    code: 'VALIDATION_ERROR',
    details: {
      field: issues[0].field,
      message: issues.map((i) => i.message).join('. '),
      issues: issues.map((i) => ({ field: i.field, message: i.message })),
    },
  }
}

async function employmentTypeRefusal(
  supabase: SupabaseClient,
  companyId: string,
  employmentType: unknown,
): Promise<EmployeeCommandResult<never> | null> {
  // EF owners cannot be on payroll (egna uttag, not lön). The DB trigger is
  // the all-paths backstop; checking here gives a clean error. #782
  const entityType = await getCompanyEntityType(supabase, companyId)
  if (isEmploymentTypeAllowedForEntity(entityType, employmentType as never)) return null
  return issuesRefusal([{ field: 'employment_type', message: EF_OWNER_EMPLOYMENT_ERROR }])
}

export async function createEmployee(
  supabase: SupabaseClient,
  args: {
    companyId: string
    userId: string
    /** Validated CreateEmployeeSchema fields, personnummer replaced by the
     * sealed pair (sealPersonnummer). */
    input: Record<string, unknown> & SealedIdentity
    /** Validate and answer the would-be row without inserting. */
    dryRun?: boolean
    /** employees columns for `row` ('*' by default). */
    columns?: string
  },
): Promise<EmployeeCommandResult<EmployeeCommandData>> {
  const { personnummer_encrypted, personnummer_last4, ...rest } = args.input
  if (!personnummer_encrypted || !personnummer_last4) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'personnummer_encrypted' } }
  }

  const fields = pickWritable(rest, EMPLOYEE_CREATE_COLUMNS)
  if (!fields.first_name || !fields.last_name || !fields.employment_start) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { message: 'first_name, last_name and employment_start are required' },
    }
  }

  const employmentType = (fields.employment_type as string | undefined) ?? 'employee'
  const typeRefusal = await employmentTypeRefusal(supabase, args.companyId, employmentType)
  if (typeRefusal) return typeRefusal

  const bankIssues = validateEmployeeBankAccount(
    fields.clearing_number as string | undefined,
    fields.bank_account_number as string | undefined,
  )
  if (bankIssues.length > 0) return issuesRefusal(bankIssues)

  // The doors already ran CreateEmployeeSchema, but this is the last gate
  // before the row exists: an incomplete beslut must never be stored, since
  // the engine silently ignores it (#2058).
  const jamkningIssues = validateJamkning(fields)
  if (jamkningIssues.length > 0) return issuesRefusal(jamkningIssues)
  const extraTaxIssues = validateExtraTax(fields)
  if (extraTaxIssues.length > 0) return issuesRefusal(extraTaxIssues)

  const insert = {
    company_id: args.companyId,
    user_id: args.userId,
    personnummer: personnummer_encrypted,
    personnummer_last4,
    employment_type: employmentType,
    ...fields,
  }

  if (args.dryRun) {
    const masked = maskRow({ id: null, is_active: true, created_at: null, ...insert })
    return { ok: true, data: { ...summaryOf(masked, null), row: project(masked, args.columns) } }
  }

  const { data, error } = await supabase
    .from('employees')
    .insert(insert)
    .select(selectColumns(args.columns))
    .single()

  if (error) {
    if (error.code === '23505') {
      // Matched by constraint name, so a future unique index (an email, say)
      // is not reported as a duplicate personnummer.
      const constraint = (error as { constraint?: string }).constraint
      if (!constraint || constraint.includes('personnummer')) {
        return { ok: false, code: 'EMPLOYEE_DUPLICATE_PERSONNUMMER', details: { field: 'personnummer' } }
      }
    }
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message }, cause: error }
  }

  const masked = maskRow(data as unknown as Record<string, unknown>)
  return {
    ok: true,
    data: { ...summaryOf(masked, masked.id as string), row: project(masked, args.columns) },
  }
}

export async function updateEmployee(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    /** Validated UpdateEmployeeSchema fields. A personnummer is never accepted
     * here: identity changes go through `identity`. */
    patch: Record<string, unknown>
    /** A corrected personnummer, sealed by the door (the dashboard edit form
     * is the only door that offers it; v1 and MCP keep identity immutable). */
    identity?: SealedIdentity
    /** Validate the merged row and answer it without writing. */
    dryRun?: boolean
    /** employees columns for `row` and `previous` ('*' by default). */
    columns?: string
  },
): Promise<EmployeeCommandResult<EmployeeUpdateData>> {
  if ('personnummer' in args.patch || 'personnummer_encrypted' in args.patch) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'personnummer', message: 'Identity is immutable post-create.' },
    }
  }

  const updates = pickWritable(args.patch, EMPLOYEE_UPDATE_COLUMNS)

  const { data: existing, error: fetchError } = await supabase
    .from('employees')
    .select('*')
    .eq('id', args.employeeId)
    .eq('company_id', args.companyId)
    .maybeSingle()

  if (fetchError) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: fetchError.message }, cause: fetchError }
  }
  if (!existing) {
    return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
  }
  const stored = existing as Record<string, unknown>
  const previous = project(maskRow(stored), args.columns)

  // Merged-state validation (#3008): `updates` keeps explicit nulls (clear)
  // and has no undefined (unchanged) keys.
  const issues = validateEmployeeUpdate(stored, updates)
  if (issues.length > 0) return issuesRefusal(issues)

  if ('employment_type' in updates) {
    // Only when the caller changes it, like the enforce_ef_no_owner_employee
    // trigger (UPDATE OF employment_type): an unrelated edit of a
    // grandfathered row is not blocked.
    const typeRefusal = await employmentTypeRefusal(supabase, args.companyId, updates.employment_type)
    if (typeRefusal) return typeRefusal
  }

  const writes: Record<string, unknown> = { ...updates }
  if (args.identity) {
    writes.personnummer = args.identity.personnummer_encrypted
    writes.personnummer_last4 = args.identity.personnummer_last4
  }
  const merged = { ...stored, ...writes }

  // Nothing to change, or a dry run: the row as it is or would be, unwritten.
  if (args.dryRun || Object.keys(writes).length === 0) {
    const masked = maskRow(merged)
    return {
      ok: true,
      data: { ...summaryOf(masked, args.employeeId), row: project(masked, args.columns), previous, changes: updates },
    }
  }

  const { data, error } = await supabase
    .from('employees')
    .update(writes)
    .eq('id', args.employeeId)
    .eq('company_id', args.companyId)
    .select(selectColumns(args.columns))
    .single()

  if (error) {
    if (error.code === '23505') {
      return { ok: false, code: 'EMPLOYEE_DUPLICATE_PERSONNUMMER', details: { field: 'personnummer' } }
    }
    // The CHECK constraint refused the row (#2256): either the merged-state
    // check above passed against a snapshot another request has since
    // changed, or this is a legacy incomplete row (stored before #2240) whose
    // next edit must complete or clear the beslut. Same VALIDATION_ERROR and
    // sentence as that check, derived from the merged row.
    const jamkningIssue = jamkningIssueFromDbError(error, merged as JamkningFields)
    if (jamkningIssue) return issuesRefusal([jamkningIssue])
    // employees_extra_tax_one_form_check: a concurrent edit stored the other
    // form after the merged-state check above read the row.
    const extraTaxIssue = extraTaxIssueFromDbError(error)
    if (extraTaxIssue) return issuesRefusal([extraTaxIssue])
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message }, cause: error }
  }

  const masked = maskRow(data as unknown as Record<string, unknown>)
  return {
    ok: true,
    data: {
      ...summaryOf(masked, args.employeeId),
      row: project(masked, args.columns),
      previous,
      changes: updates,
    },
  }
}
