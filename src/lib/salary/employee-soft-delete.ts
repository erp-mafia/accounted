/**
 * Soft delete of an employee: the one rule behind the v1
 * DELETE /api/v1/companies/{companyId}/employees/{id} and the MCP tool
 * gnubok_delete_employee (lib/operations/salary-employee-setup.ts).
 *
 * An employee row is never removed. Past salary runs reference it through
 * salary_run_employees, and those runs' verifikationer are
 * räkenskapsinformation under BFL 7 kap, so every employee, with or without
 * salary history, AGI or booked runs, is handled the same way: the row stays
 * and is_active turns false, which takes the employee out of active rosters
 * and new salary runs. Deactivating an inactive employee writes nothing
 * (idempotent). A dry run reads and checks and writes nothing.
 *
 * The dashboard route (app/api/salary/employees/[id]) performs the same soft
 * delete itself, with its own error copy.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** The employee as read before any write. */
export interface EmployeeActivityRow {
  id: string
  first_name: string
  last_name: string
  is_active: boolean
}

export type SoftDeleteEmployeeOutcome =
  /** Dry run: the employee exists; nothing was written. */
  | { committed: false; employee: EmployeeActivityRow }
  /** `changed` is false when the employee was already inactive and nothing was written. */
  | { committed: true; employee: EmployeeActivityRow; changed: boolean }

export type SoftDeleteEmployeeResult =
  | { ok: true; data: SoftDeleteEmployeeOutcome }
  | { ok: false; code: 'EMPLOYEE_NOT_FOUND' }
  /**
   * A failed read or write. `cause` is the raw database error, so each door
   * classifies it the way it classifies any other database failure.
   */
  | { ok: false; code: 'INTERNAL_ERROR'; cause: unknown }

export async function softDeleteEmployee(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    /** Check that the employee exists and return it without writing. */
    dryRun?: boolean
  },
): Promise<SoftDeleteEmployeeResult> {
  const { data, error: fetchError } = await supabase
    .from('employees')
    .select('id, first_name, last_name, is_active')
    .eq('company_id', args.companyId)
    .eq('id', args.employeeId)
    .maybeSingle()
  if (fetchError) return { ok: false, code: 'INTERNAL_ERROR', cause: fetchError }
  if (!data) return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
  const employee = data as unknown as EmployeeActivityRow

  if (args.dryRun) return { ok: true, data: { committed: false, employee } }

  // Already inactive: nothing to write.
  if (!employee.is_active) return { ok: true, data: { committed: true, employee, changed: false } }

  const { error } = await supabase
    .from('employees')
    .update({ is_active: false })
    .eq('company_id', args.companyId)
    .eq('id', args.employeeId)
  if (error) return { ok: false, code: 'INTERNAL_ERROR', cause: error }

  return { ok: true, data: { committed: true, employee, changed: true } }
}
