/**
 * Shared draft salary-run delete: the one guarded write behind the v1 DELETE
 * (app/api/v1/companies/[companyId]/salary-runs/[id]) and the dashboard
 * DELETE (app/api/salary/runs/[id]).
 *
 * Only a draft can be deleted. A draft has produced no journal entries and no
 * AGI; past draft the run carries compliance weight and storno is the only
 * correction path (BFL 5 kap). The status check before the write is advisory:
 * the write itself is locked to status='draft' with every journal-entry
 * foreign key null, so a run that advanced (or got a verifikat attached)
 * between the read and the delete is refused instead of hard-deleted.
 *
 * salary_run_employees and salary_line_items go via ON DELETE CASCADE. A
 * payment file or AGI row still pointing at the run blocks the delete through
 * its FK; that error is returned raw so each surface keeps its own mapping.
 *
 * Result-object convention mirrors lib/salary/update-run.ts.
 */

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'

export type DeleteSalaryRunResult =
  | { ok: true; data: { id: string; deleted: true } }
  | { ok: false; code: 'SALARY_RUN_NOT_FOUND' }
  | { ok: false; code: 'SALARY_RUN_DELETE_NOT_DRAFT'; details: { current_status: string } }
  | {
      ok: false
      code: 'SALARY_RUN_DELETE_HAS_JOURNAL_ENTRY'
      details: { reason: 'fk_non_null_or_status_race' }
    }
  | { ok: false; code: 'DB_ERROR'; error: PostgrestError }

export async function deleteDraftSalaryRun(
  supabase: SupabaseClient,
  args: {
    companyId: string
    salaryRunId: string
    /** Run the pre-flight only; never write. */
    dryRun?: boolean
  },
): Promise<DeleteSalaryRunResult> {
  const { data: run, error: fetchError } = await supabase
    .from('salary_runs')
    .select('id, status')
    .eq('company_id', args.companyId)
    .eq('id', args.salaryRunId)
    .maybeSingle()

  if (fetchError) return { ok: false, code: 'DB_ERROR', error: fetchError }
  if (!run) return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }

  const status = (run as { status: string }).status
  if (status !== 'draft') {
    return { ok: false, code: 'SALARY_RUN_DELETE_NOT_DRAFT', details: { current_status: status } }
  }

  if (args.dryRun) return { ok: true, data: { id: args.salaryRunId, deleted: true } }

  // Optimistic lock on status='draft' plus null journal-entry FKs. status is
  // the primary gate (the lifecycle never sets the entry ids before leaving
  // draft); the null guards turn a hypothetical partial failure that left a
  // posted verifikat on a draft row into a refusal instead of orphaned
  // räkenskapsinformation.
  const { error, count } = await supabase
    .from('salary_runs')
    .delete({ count: 'exact' })
    .eq('company_id', args.companyId)
    .eq('id', args.salaryRunId)
    .eq('status', 'draft')
    .is('salary_entry_id', null)
    .is('avgifter_entry_id', null)
    .is('vacation_entry_id', null)

  if (error) return { ok: false, code: 'DB_ERROR', error }
  if (count === 0) {
    // Either the run left draft after the pre-flight or the FK-null guards
    // tripped. Both mean nothing was deleted; the distinct code lets an
    // operator look for a misrouted verifikation rather than assume a race.
    return {
      ok: false,
      code: 'SALARY_RUN_DELETE_HAS_JOURNAL_ENTRY',
      details: { reason: 'fk_non_null_or_status_race' },
    }
  }

  return { ok: true, data: { id: args.salaryRunId, deleted: true } }
}
