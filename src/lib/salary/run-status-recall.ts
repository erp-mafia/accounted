/**
 * Stepping a salary run back one status, for correction before anything
 * legally binding has happened:
 *
 *   revert    : review   -> draft   (unlock the calculated run for editing)
 *   unapprove : approved -> review  (recall the approval)
 *
 * One implementation behind the dashboard routes
 * (POST /api/salary/runs/[id]/revert and /unapprove), the v1 operations
 * salary-runs.revert and salary-runs.unapprove and their MCP tools
 * (lib/operations/salary-run-lifecycle.ts). No amount is recomputed here:
 * a reverted run is recalculated by the normal calculate step.
 *
 * Unapprove is refused once the AGI is in flight (pending_signature) or filed
 * (submitted/accepted, or the run stamped agi_submitted_at): the period must
 * then be redone via a correction AGI with the same specifikationsnummer.
 * A paid or booked run is never unapproved: it is corrected through the
 * correction flow. Nor is one with a bank payment approved, at the bank or
 * executed (SALARY_RUN_IN_BANK_PAYMENT, refused by the database,
 * 20261027100000); the run's bank payment drafts are cancelled with it. On success it clears the approver, the AGI generation
 * stamp and the payment-file tracking, and deletes a generated but unfiled
 * (generated/exported) AGI declaration, which now carries stale amounts
 * (a correction run's is kept: it is the period's row).
 *
 * A dry run reads and checks and answers what would change; it writes
 * nothing (it is also the MCP staging preview).
 */
import { isSalaryExtraRunsEnabled } from '@/lib/env/salary-extra-runs-switch'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { eventBus } from '@/lib/events'
import { isSalaryInBankPaymentError } from '@/lib/salary/payment/in-bank-payment'

/** AGI declaration states that mean Skatteverket has (or is about to have) it. */
const AGI_FILED_STATUSES = ['pending_signature', 'submitted', 'accepted']
/** AGI declaration states that are local only and go stale on unapprove. */
const AGI_STALE_STATUSES = ['generated', 'exported']

function isNoRowsError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'PGRST116'
}

// ---------------------------------------------------------------------------
// review -> draft
// ---------------------------------------------------------------------------

export interface RevertedSalaryRun {
  /** The updated salary_runs row (the dashboard merges it into its state). */
  run: Record<string, unknown>
}

export async function revertSalaryRunToDraft(
  ctx: OperationContext,
  salaryRunId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<RevertedSalaryRun>> {
  const { supabase, companyId } = ctx

  const { data: existing } = await supabase
    .from('salary_runs')
    .select('id, status')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!existing) return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  const status = (existing as { status: string }).status
  if (status !== 'review') {
    return { ok: false, code: 'SALARY_RUN_REVERT_NOT_REVIEW', details: { current_status: status } }
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        salary_run_id: salaryRunId,
        would_change_status_from: 'review',
        would_change_status_to: 'draft',
        note: 'The calculated amounts stay until the run is recalculated; nothing is booked or deleted.',
      },
    }
  }

  const { data: run, error } = await supabase
    .from('salary_runs')
    .update({ status: 'draft' })
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .eq('status', 'review')
    .select()
    .single()

  if (error || !run) {
    // Zero rows: the run moved on between the read and the update.
    if (!error || isNoRowsError(error)) {
      return { ok: false, code: 'SALARY_RUN_STATUS_CHANGED', details: { expected_status: 'review' } }
    }
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }

  return { ok: true, data: { run: run as Record<string, unknown> } }
}

// ---------------------------------------------------------------------------
// approved -> review
// ---------------------------------------------------------------------------

export interface UnapprovedSalaryRun {
  /** The updated salary_runs row (the dashboard merges it into its state). */
  run: Record<string, unknown>
  /** The generated-but-unfiled AGI declaration removed as stale, if any. */
  deletedAgiDeclarationId: string | null
}

export async function unapproveSalaryRun(
  ctx: OperationContext,
  salaryRunId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<UnapprovedSalaryRun>> {
  const { supabase, companyId, userId, log } = ctx

  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('id, status, is_correction, agi_submitted_at, agi_generated_at, payment_file_format, payment_file_generated_at')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .single()

  if (runError || !run) return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  const runRow = run as {
    status: string
    is_correction?: boolean | null
    agi_submitted_at: string | null
    agi_generated_at: string | null
    payment_file_format: string | null
    payment_file_generated_at: string | null
  }

  if (runRow.status !== 'approved') {
    return { ok: false, code: 'SALARY_RUN_UNAPPROVE_NOT_APPROVED', details: { current_status: runRow.status } }
  }

  // Every declaration of the run, not .single(): nothing makes salary_run_id
  // unique there, and .single() answers both "none" and "more than one" with
  // the same error, so a run with two rows read as having none. A failed read
  // refuses: whether the AGI is filed is unknown, and recalling a filed run
  // is what this check exists to stop (accounted#58).
  // A month summed over several runs (SALARY_EXTRA_RUNS_COMPANY_IDS) is the
  // declaration of every run it lists, whichever run holds the row.
  const agiQuery = supabase.from('agi_declarations').select('id, status').eq('company_id', companyId)
  const { data: agiRows, error: agiError } = await (isSalaryExtraRunsEnabled(companyId)
    ? agiQuery.or(`salary_run_id.eq.${salaryRunId},salary_run_ids.cs.{${salaryRunId}}`)
    : agiQuery.eq('salary_run_id', salaryRunId))
  if (agiError) {
    log.error('salary run unapprove: AGI declaration read failed', agiError as Error)
    return { ok: false, code: 'SALARY_RUN_UNAPPROVE_FAILED' }
  }
  const declarations = (agiRows ?? []) as Array<{ id: string; status: string }>
  const filedAgi = declarations.find((row) => AGI_FILED_STATUSES.includes(row.status))
  // Only a run's one declaration is replaced as stale; with several, none is
  // deleted, as before.
  const agi = filedAgi ?? (declarations.length === 1 ? declarations[0] : null)

  if (runRow.agi_submitted_at || filedAgi) {
    return {
      ok: false,
      code: 'SALARY_RUN_UNAPPROVE_AGI_FILED',
      details: { agi_status: (agi ?? declarations[0])?.status ?? null, agi_submitted_at: runRow.agi_submitted_at },
    }
  }

  // A correction run's declaration is the period's one row, taken over from
  // the run it corrects (generate-declaration.ts): it carries the period's
  // tax payment tracking and stays. Its XML goes stale like any other, but the
  // cleared agi_generated_at makes the panel and the submit regenerate it.
  const staleAgi = agi && AGI_STALE_STATUSES.includes(agi.status) && !runRow.is_correction ? agi : null

  if (options.dryRun) {
    // Payslips already emailed are not recalled by this; the approver should
    // know they exist. A read only, and only here: the commit path below
    // keeps the dashboard's query sequence.
    const { count: payslipsSent } = await supabase
      .from('salary_payslip_deliveries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('salary_run_id', salaryRunId)
      .eq('status', 'sent')
    return {
      ok: true,
      dryRun: true,
      preview: {
        salary_run_id: salaryRunId,
        would_change_status_from: 'approved',
        would_change_status_to: 'review',
        would_clear: ['approved_by', 'approved_at', 'agi_generated_at', 'payment_file_format', 'payment_file_generated_at'],
        would_delete_agi_declaration_id: staleAgi?.id ?? null,
        payment_file_generated_at: runRow.payment_file_generated_at,
        payslips_already_sent: payslipsSent ?? 0,
        warnings: [
          ...(runRow.payment_file_generated_at
            ? ['A payment file was generated for this run. Confirm it was not sent to the bank before recalling the approval.']
            : []),
          ...((payslipsSent ?? 0) > 0
            ? ['Payslips were already emailed; employees keep the links until payslips are sent again.']
            : []),
        ],
      },
    }
  }

  // Clear payment-file tracking too: a previously generated file would show
  // as current after re-approval even though the amounts may change. Whether
  // the file already reached the bank is outside the app's knowledge: the UI
  // makes the user confirm that before calling this.
  const { data: updatedRun, error } = await supabase
    .from('salary_runs')
    .update({
      status: 'review',
      approved_by: null,
      approved_at: null,
      agi_generated_at: null,
      payment_file_format: null,
      payment_file_generated_at: null,
    })
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .eq('status', 'approved')
    // TOCTOU guard: AGI submission is allowed from `approved` (also out of
    // band via MCP / the public API), so a filing may have landed since the
    // read above. Re-assert it hasn't inside the update filter.
    .is('agi_submitted_at', null)
    .select()
    .single()

  if (error || !updatedRun) {
    // Zero rows matched (PGRST116): the run moved on concurrently (marked
    // paid, or the AGI was filed) between the read and this update. Not a
    // server fault; the caller should reload and retry.
    if (isNoRowsError(error)) {
      return { ok: false, code: 'SALARY_RUN_STATUS_CHANGED', details: { expected_status: 'approved' } }
    }
    // A bank payment of the run is approved, at the bank or executed
    // (salary_run_recall_guard_bank_payments, 20261027100000): it was made
    // from the amounts the recall would recompute.
    if (isSalaryInBankPaymentError(error)) {
      return { ok: false, code: 'SALARY_RUN_IN_BANK_PAYMENT' }
    }
    log.error('salary run unapprove update failed', error as Error)
    return { ok: false, code: 'SALARY_RUN_UNAPPROVE_FAILED' }
  }

  // A generated-but-unfiled AGI now carries stale amounts: delete it so the
  // stale XML can't be exported. Deliberately after the status flip: the
  // reverse order could destroy the declaration and then fail the
  // transition, leaving an approved run with its AGI gone. If this delete
  // misses instead, agi_generated_at is already null and regeneration on the
  // forward path upserts over the orphaned row. The status filter makes the
  // delete a no-op if the declaration advanced (e.g. to pending_signature)
  // since the read. A rejected declaration is kept: it documents the
  // rejection.
  let deletedAgiDeclarationId: string | null = null
  if (staleAgi) {
    const { data: deletedRows, error: deleteError } = await supabase
      .from('agi_declarations')
      .delete()
      .eq('id', staleAgi.id)
      .in('status', AGI_STALE_STATUSES)
      .select('id')
    deletedAgiDeclarationId = deletedRows?.length ? staleAgi.id : null
    if (deleteError) {
      log.warn('stale AGI declaration delete failed', {
        agiDeclarationId: staleAgi.id,
        error: deleteError.message,
      })
    }
  }

  await eventBus.emit({
    type: 'salary_run.approval_reverted',
    payload: {
      salaryRunId,
      revertedBy: userId,
      deletedAgiDeclarationId,
      userId,
      companyId,
    },
  })

  return { ok: true, data: { run: updatedRun as Record<string, unknown>, deletedAgiDeclarationId } }
}
