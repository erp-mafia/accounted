/**
 * Shared employee master-data commands for the MCP staged-operation
 * executors (create_employee / update_employee).
 *
 * PII contract: these functions NEVER receive a plaintext personnummer. The
 * staging tool validates the caller's input with CreateEmployeeSchema,
 * encrypts the personnummer at staging time, and pending_operations.params
 * carries only { personnummer_encrypted, personnummer_last4 }. Masked forms
 * for previews/results are derived by decrypting in-process.
 *
 * The internal dashboard route (app/api/salary/employees) and the v1 routes
 * have their own request-shaped handlers today; this module is the executor-
 * facing command layer. (Future dedup opportunity noted in the gap-closure
 * plan: fold all three onto this service.)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptPersonnummer, maskPersonnummer } from '@/lib/salary/personnummer'
import { getCompanyEntityType } from '@/lib/company/context'
import { isEmploymentTypeAllowedForEntity, EF_OWNER_EMPLOYMENT_ERROR } from '@/lib/salary/employment-rules'
import { validateEmployeeBankAccount } from '@/lib/salary/payment/bank-account'
import { touchesJamkning, validateJamkning } from '@/lib/salary/jamkning-rules'

export type EmployeeCommandResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown> }

export interface EmployeeSummaryResult {
  employee_id: string
  first_name: string
  last_name: string
  personnummer_masked: string
  is_active: boolean
}

/** Columns an executor is allowed to write. Anything else in params is
 * ignored (defense in depth against a tampered pending_operations row). */
const WRITABLE_COLUMNS = new Set([
  'first_name',
  'last_name',
  'employment_type',
  'employment_start',
  'employment_end',
  'employment_degree',
  'hours_per_week',
  'workdays_per_week',
  'salary_type',
  'monthly_salary',
  'hourly_rate',
  'tax_table_number',
  'tax_column',
  'tax_municipality',
  'is_sidoinkomst',
  'f_skatt_status',
  'clearing_number',
  'bank_account_number',
  'vacation_rule',
  'vacation_days_per_year',
  'semestertillagg_rate',
  'email',
  'phone',
  'address_line1',
  'postal_code',
  'city',
  'vaxa_stod_eligible',
  'vaxa_stod_start',
  'vaxa_stod_end',
  'jamkning_percentage',
  'jamkning_valid_from',
  'jamkning_valid_to',
  'default_dimensions',
])

function pickWritable(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (WRITABLE_COLUMNS.has(key) && value !== undefined) {
      out[key] = value
    }
  }
  return out
}

export async function createEmployee(
  supabase: SupabaseClient,
  args: {
    companyId: string
    userId: string
    /** Validated CreateEmployeeSchema fields, personnummer replaced by the
     * encrypted pair at staging time. */
    input: Record<string, unknown> & {
      personnummer_encrypted: string
      personnummer_last4: string
    }
  },
): Promise<EmployeeCommandResult<EmployeeSummaryResult>> {
  const { personnummer_encrypted, personnummer_last4, ...rest } = args.input
  if (!personnummer_encrypted || !personnummer_last4) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'personnummer_encrypted' } }
  }

  const fields = pickWritable(rest)
  if (!fields.first_name || !fields.last_name || !fields.employment_start) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { message: 'first_name, last_name and employment_start are required' },
    }
  }

  // EF owners cannot be on payroll (egna uttag, not lön). The DB trigger is
  // the all-paths backstop; checking here gives a clean error. #782
  const entityType = await getCompanyEntityType(supabase, args.companyId)
  const employmentType = (fields.employment_type as string | undefined) ?? 'employee'
  if (!isEmploymentTypeAllowedForEntity(entityType, employmentType as never)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'employment_type', message: EF_OWNER_EMPLOYMENT_ERROR },
    }
  }

  const bankIssues = validateEmployeeBankAccount(
    fields.clearing_number as string | undefined,
    fields.bank_account_number as string | undefined,
  )
  if (bankIssues.length > 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { issues: bankIssues.map((i) => ({ field: i.field, message: i.message })) },
    }
  }

  // The staging tool already ran CreateEmployeeSchema, but the executor is the
  // last gate before the row exists: an incomplete beslut must never be
  // stored, since the engine silently ignores it (#2058).
  const jamkningIssues = validateJamkning(fields)
  if (jamkningIssues.length > 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: {
        field: jamkningIssues[0].field,
        message: jamkningIssues.map((i) => i.message).join('. '),
      },
    }
  }

  const { data, error } = await supabase
    .from('employees')
    .insert({
      company_id: args.companyId,
      user_id: args.userId,
      personnummer: personnummer_encrypted,
      personnummer_last4,
      employment_type: employmentType,
      ...fields,
    })
    .select('id, first_name, last_name, personnummer, is_active')
    .single()

  if (error) {
    if (error.code === '23505') {
      const constraint = (error as { constraint?: string }).constraint
      if (!constraint || constraint.includes('personnummer')) {
        return { ok: false, code: 'EMPLOYEE_DUPLICATE_PERSONNUMMER' }
      }
    }
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }

  const row = data as { id: string; first_name: string; last_name: string; personnummer: string; is_active: boolean }
  return {
    ok: true,
    data: {
      employee_id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      personnummer_masked: maskPersonnummer(decryptPersonnummer(row.personnummer)),
      is_active: row.is_active,
    },
  }
}

export async function updateEmployee(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    /** Validated UpdateEmployeeSchema fields. Personnummer is rejected at the
     * tool boundary (identity immutable); it is never accepted here either. */
    patch: Record<string, unknown>
  },
): Promise<EmployeeCommandResult<EmployeeSummaryResult>> {
  if ('personnummer' in args.patch || 'personnummer_encrypted' in args.patch) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'personnummer', message: 'Identity is immutable post-create.' },
    }
  }

  const updates = pickWritable(args.patch)
  if (Object.keys(updates).length === 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { message: 'At least one updatable field is required.' },
    }
  }

  const { data: existing, error: fetchError } = await supabase
    .from('employees')
    .select('*')
    .eq('id', args.employeeId)
    .eq('company_id', args.companyId)
    .maybeSingle()

  if (fetchError) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: fetchError.message } }
  }
  if (!existing) {
    return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
  }

  // Merged-state validation (same rules as the internal PATCH route).
  const merged = { ...(existing as Record<string, unknown>), ...updates }
  const issues: string[] = []
  if (merged.salary_type === 'monthly' && (!merged.monthly_salary || (merged.monthly_salary as number) <= 0)) {
    issues.push('Månadslön krävs och måste vara större än 0 för månadslöneform')
  }
  if (merged.salary_type === 'hourly' && (!merged.hourly_rate || (merged.hourly_rate as number) <= 0)) {
    issues.push('Timlön krävs och måste vara större än 0 för timlöneform')
  }
  if (merged.f_skatt_status === 'a_skatt' && !merged.is_sidoinkomst && !merged.tax_table_number) {
    issues.push('Skattetabell krävs för A-skatt anställda')
  }
  if (merged.vaxa_stod_eligible && !merged.vaxa_stod_start) {
    issues.push('Startdatum för Växa-stöd måste anges när Växa-stöd är aktiverat')
  }
  // Jämkning is validated on the merged row through the shared validator,
  // and only when the patch touches a jämkning key: a legacy row stored with
  // an incomplete beslut must stay editable in unrelated ways. #2058
  if (touchesJamkning(updates)) {
    for (const issue of validateJamkning(merged)) issues.push(issue.message)
  }
  if (issues.length > 0) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { message: issues.join('. ') } }
  }

  const clearingChanged =
    'clearing_number' in updates && updates.clearing_number !== (existing as Record<string, unknown>).clearing_number
  const accountChanged =
    'bank_account_number' in updates &&
    updates.bank_account_number !== (existing as Record<string, unknown>).bank_account_number
  if (clearingChanged || accountChanged) {
    const bankIssues = validateEmployeeBankAccount(
      merged.clearing_number as string | undefined,
      merged.bank_account_number as string | undefined,
    )
    if (bankIssues.length > 0) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { issues: bankIssues.map((i) => ({ field: i.field, message: i.message })) },
      }
    }
  }

  if ('employment_type' in updates) {
    const entityType = await getCompanyEntityType(supabase, args.companyId)
    if (!isEmploymentTypeAllowedForEntity(entityType, updates.employment_type as never)) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { field: 'employment_type', message: EF_OWNER_EMPLOYMENT_ERROR },
      }
    }
  }

  const { data, error } = await supabase
    .from('employees')
    .update(updates)
    .eq('id', args.employeeId)
    .eq('company_id', args.companyId)
    .select('id, first_name, last_name, personnummer, is_active')
    .single()

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }

  const row = data as { id: string; first_name: string; last_name: string; personnummer: string; is_active: boolean }
  return {
    ok: true,
    data: {
      employee_id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      personnummer_masked: maskPersonnummer(decryptPersonnummer(row.personnummer)),
      is_active: row.is_active,
    },
  }
}
