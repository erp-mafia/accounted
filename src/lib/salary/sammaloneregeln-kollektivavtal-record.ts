/**
 * The record of a kollektivavtal confirmation that keeps sammalöneregeln after
 * a changed employment degree (lib/salary/employee-update-rules.ts).
 *
 * Semesterlagen 16 § andra stycket 3-4 moves such an employee to procentregeln;
 * a central kollektivavtal may deviate (2 a § andra stycket). The update stays
 * on sammalöneregeln only on the caller's word that such an agreement applies,
 * so who gave that word, when, and for which change is kept in audit_log, the
 * immutable company-scoped log, as a GUARD_BYPASSED row (migration
 * 20260914150102: the guard and what it would have refused live in
 * new_state). The employees table has no change log of its own (#30).
 *
 * The row is written with the service role: audit_log has no INSERT policy,
 * so a session client cannot write it. Ids and the two degrees only: never
 * the personnummer, the name or the salary.
 *
 * The employee is already saved when this runs, so nothing here may undo or
 * fail it: every failure is logged at error level and swallowed.
 *
 * The second confirmation recorded here: a payslip row that pays semesterlön
 * for rörliga lönedelar with the salary (salary_line_items
 * settles_variable_vacation_pay, lib/salary/variable-vacation-pay.ts).
 * Semesterlagen 16 a § tredje stycket and 26 § andra stycket pay it after
 * the semesterår; a central kollektivavtal may deviate (2 a § andra stycket).
 * The row is marked only on the caller's word that such an agreement
 * applies, kept the same way: ids only, never the amount. The mark rests on
 * that record, so this one reports whether it was written and the caller
 * removes the row when it was not.
 */

import { getActor } from '@/lib/bookkeeping/actor-context'
import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'

const log = createLogger('salary/sammaloneregeln-kollektivavtal-record')

/** `new_state.guard` discriminator: a stable contract, not a message. */
export const SAMMALONEREGELN_DEGREE_CHANGE_GUARD = 'employee_sammaloneregeln_degree_change' as const

export interface SammaloneregelnKollektivavtalRecord {
  companyId: string
  employeeId: string
  /** The person the change is attributed to (for a key, its owner or sponsor). */
  userId: string | null
  employmentDegreeFrom: number
  employmentDegreeTo: number
}

export async function recordSammaloneregelnKollektivavtal(input: SammaloneregelnKollektivavtalRecord): Promise<void> {
  // Every employee door runs inside a commit-actor scope (withRouteContext,
  // withApiV1, the pending-operation commit), so the credential is known here.
  const actor = getActor()
  try {
    const { error } = await createServiceClient()
      .from('audit_log')
      .insert({
        user_id: input.userId,
        company_id: input.companyId,
        action: 'GUARD_BYPASSED',
        table_name: 'employees',
        record_id: input.employeeId,
        actor_type: actor?.type ?? 'user',
        actor_label: actor?.label ?? null,
        old_state: { employment_degree: input.employmentDegreeFrom, vacation_rule: 'sammaloneregeln' },
        new_state: {
          guard: SAMMALONEREGELN_DEGREE_CHANGE_GUARD,
          reason: 'kollektivavtal',
          employee_id: input.employeeId,
          employment_degree_from: input.employmentDegreeFrom,
          employment_degree_to: input.employmentDegreeTo,
          vacation_rule: 'sammaloneregeln',
        },
        description:
          `Sammalöneregeln kept after the employment degree changed from ${input.employmentDegreeFrom} % to ` +
          `${input.employmentDegreeTo} %: a central kollektivavtal was confirmed (semesterlagen 2 a §, 16 § andra stycket 3-4)`,
      })
    if (error) {
      // error, not warn: a dropped row leaves the confirmation without a trace.
      log.error(
        'audit_log insert failed for the sammalöneregeln kollektivavtal confirmation',
        new Error(error.message ?? 'audit_log insert failed'),
        { companyId: input.companyId, employeeId: input.employeeId, code: error.code },
      )
    }
  } catch (err) {
    log.error('audit_log insert threw for the sammalöneregeln kollektivavtal confirmation', err as Error, {
      companyId: input.companyId,
      employeeId: input.employeeId,
    })
  }
}

/** `new_state.guard` discriminator for a row paid with the salary: a stable contract, not a message. */
export const VARIABLE_VACATION_PAY_WITH_SALARY_GUARD = 'salary_line_variable_vacation_pay_with_salary' as const

export interface VariableVacationPayKollektivavtalRecord {
  companyId: string
  employeeId: string
  salaryRunId: string
  salaryLineItemId: string
}

/**
 * Records the confirmation behind a row marked settles_variable_vacation_pay.
 * True when the audit row was written. A failure is logged and reported as
 * false, never thrown: the caller (payslip-lines.ts) then removes the marked
 * row, so no row is marked without its confirmation.
 */
export async function recordVariableVacationPayKollektivavtal(input: VariableVacationPayKollektivavtalRecord): Promise<boolean> {
  // Every line door runs inside a commit-actor scope (withRouteContext,
  // withApiV1, the pending-operation commit), so the person is known here.
  const actor = getActor()
  try {
    const { error } = await createServiceClient()
      .from('audit_log')
      .insert({
        user_id: actor?.userId ?? null,
        company_id: input.companyId,
        action: 'GUARD_BYPASSED',
        table_name: 'salary_line_items',
        record_id: input.salaryLineItemId,
        actor_type: actor?.type ?? 'user',
        actor_label: actor?.label ?? null,
        old_state: null,
        new_state: {
          guard: VARIABLE_VACATION_PAY_WITH_SALARY_GUARD,
          reason: 'kollektivavtal',
          employee_id: input.employeeId,
          salary_run_id: input.salaryRunId,
          salary_line_item_id: input.salaryLineItemId,
          vacation_rule: 'sammaloneregeln',
        },
        description:
          'Semesterlön for rörliga lönedelar paid with the salary: a central kollektivavtal was confirmed ' +
          '(semesterlagen 2 a § andra stycket, 16 a § tredje stycket, 26 § andra stycket)',
      })
    if (error) {
      log.error(
        'audit_log insert failed for the variable vacation pay kollektivavtal confirmation',
        new Error(error.message ?? 'audit_log insert failed'),
        { companyId: input.companyId, salaryLineItemId: input.salaryLineItemId, code: error.code },
      )
      return false
    }
    return true
  } catch (err) {
    log.error('audit_log insert threw for the variable vacation pay kollektivavtal confirmation', err as Error, {
      companyId: input.companyId,
      salaryLineItemId: input.salaryLineItemId,
    })
    return false
  }
}
