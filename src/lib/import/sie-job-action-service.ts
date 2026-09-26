/**
 * Undo or resume a durable SIE import, as an operation outcome: the service
 * behind the v1 operations imports.sie.undo and imports.sie.resume
 * (lib/operations/imports.ts). The dashboard routes
 * (/api/import/sie/[id]/undo, /action, /replace) and the MCP tool
 * gnubok_undo_sie_import call requestSIEJobAction directly, which this
 * wraps, so every door runs the same RPCs.
 *
 * Undo NEVER deletes a posted verifikat: request_sie_import_undo (migration
 * 20260911150200) queues a BATCH STORNO that the SIE worker carries out: every
 * entry the import posted gets a reversing entry and the originals stay in
 * the ledger (BFL 5 kap 5 §). The RPC refuses while another SIE run is
 * active, while a reversal of an imported voucher is already in progress,
 * while an imported voucher has a live correction, and when the period is
 * closed or locked. Owner/admin only.
 *
 * Resume re-queues an interrupted (paused / failed-chunk) run from where it
 * stopped; allowed to the user who ran it and to owners/admins.
 *
 * Both are asynchronous: the answer is the job with its new state, and the
 * worker (kicked right after the request, and by the worker cron) does the
 * ledger work. A dry run reads and checks; it never calls the RPC.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { requireCompanyAdmin } from '@/lib/operations/access'
import { requestSIEJobAction } from './sie-jobs'
import type { SIEJob } from './sie-job-contract'

export type SIEJobActionKind = 'undo' | 'resume'

export interface SIEJobActionResult {
  import_id: string
  action: SIEJobActionKind
  state: string
  phase: string | null
  /** True when the RPC accepted the request (or the job was already finished). */
  accepted: true
}

const ADMIN_MESSAGE = 'Endast ägare eller administratörer kan ångra en SIE-import.'
const TERMINAL = new Set(['completed', 'undone', 'failed'])

interface JobRow {
  id: string
  job_state: string | null
  job_kind: string | null
  job_phase: string | null
  user_id: string
  execution_actor_id: string | null
  fiscal_period_id: string | null
}

export async function requestSIEImportAction(
  ctx: OperationContext,
  importId: string,
  action: SIEJobActionKind,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<SIEJobActionResult>> {
  const { supabase, companyId, userId, log } = ctx

  const { data: found, error: lookupError } = await supabase
    .from('sie_imports')
    .select('id, job_state, job_kind, job_phase, user_id, execution_actor_id, fiscal_period_id')
    .eq('company_id', companyId)
    .eq('id', importId)
    .maybeSingle()
  if (lookupError) return { ok: false, code: 'UNKNOWN_ERROR', error: lookupError }
  if (!found) return { ok: false, code: 'NOT_FOUND', details: { resource: 'sie_import' } }
  const job = found as JobRow

  // A legacy (pre-job) import has no durable job to act on: it needs the
  // outcome review first.
  if (!job.job_state) return { ok: false, code: 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED' }

  if (action === 'undo') {
    const denied = await requireCompanyAdmin(ctx, ADMIN_MESSAGE)
    if (denied) return denied
  } else if (userId !== (job.execution_actor_id ?? job.user_id)) {
    // Resume: the user who ran the import, or an owner/admin.
    const denied = await requireCompanyAdmin(ctx, 'Endast den som startade importen, en ägare eller en administratör kan återuppta den.')
    if (denied) return denied
  }

  if (options.dryRun) return previewAction(ctx, job, action)

  let result: SIEJob
  try {
    result = await requestSIEJobAction(supabase, companyId, userId, importId, action)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'NOT_FOUND') return { ok: false, code: 'NOT_FOUND', details: { resource: 'sie_import' } }
    if (code === 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED') return { ok: false, code }
    if (code === 'DB_PERMISSION_DENIED') {
      return { ok: false, code: 'FORBIDDEN', messageSv: ADMIN_MESSAGE, details: { required_roles: ['owner', 'admin'] } }
    }
    if (code === 'CONFLICT') {
      return { ok: false, code: 'SIE_IMPORT_ACTION_CONFLICT', details: { reason: (err as Error).message } }
    }
    log.error('SIE job action failed', err as Error, { importId, action })
    return { ok: false, code: 'UNKNOWN_ERROR', error: err }
  }

  log.info('SIE job action requested', { importId, action, state: result.job_state, actor: userId })
  return {
    ok: true,
    data: {
      import_id: result.id,
      action,
      state: result.job_state,
      phase: result.job_phase ?? null,
      accepted: true,
    },
  }
}

/** The RPC's refusals that reads can answer, then what would happen. */
async function previewAction(
  ctx: OperationContext,
  job: JobRow,
  action: SIEJobActionKind,
): Promise<OperationOutcome<SIEJobActionResult>> {
  const { supabase, companyId } = ctx
  const state = job.job_state!

  if (action === 'resume') {
    return {
      ok: true,
      dryRun: true,
      preview: {
        import_id: job.id,
        action,
        current_state: state,
        would_change: !TERMINAL.has(state),
        note: TERMINAL.has(state) ? 'The run is already finished; resume answers it unchanged.' : 'The run is re-queued from where it stopped.',
      },
    }
  }

  if (job.job_kind && job.job_kind !== 'import') {
    return { ok: false, code: 'SIE_IMPORT_ACTION_CONFLICT', details: { reason: 'A reviewed repair run is stopped through its own review action.' } }
  }
  if (state === 'undone' || state === 'failed') {
    return { ok: true, dryRun: true, preview: { import_id: job.id, action, current_state: state, would_change: false } }
  }

  const { data: others, error: othersError } = await supabase
    .from('sie_imports')
    .select('id, job_state, supersedes_import_id')
    .eq('company_id', companyId)
    .neq('id', job.id)
    .not('job_state', 'in', '(completed,undone,failed)')
  if (othersError) return { ok: false, code: 'UNKNOWN_ERROR', error: othersError }
  const blocking = ((others ?? []) as { id: string; job_state: string | null; supersedes_import_id: string | null }[]).filter(
    (o) => o.job_state && !(job.job_phase === 'undo' && o.supersedes_import_id === job.id),
  )
  if (blocking.length > 0) {
    return { ok: false, code: 'SIE_IMPORT_ACTION_CONFLICT', details: { reason: 'Another SIE execution must finish before undo.' } }
  }

  if (job.fiscal_period_id) {
    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('id, is_closed, locked_at, import_hold')
      .eq('company_id', companyId)
      .eq('id', job.fiscal_period_id)
      .maybeSingle()
    if (periodError) return { ok: false, code: 'UNKNOWN_ERROR', error: periodError }
    const p = period as { is_closed: boolean | null; locked_at: string | null; import_hold: string | null } | null
    if (p && (p.is_closed || p.locked_at || (p.import_hold && p.import_hold !== job.id))) {
      return { ok: false, code: 'SIE_IMPORT_ACTION_CONFLICT', details: { reason: 'The period is closed or locked, or has another execution.' } }
    }
  }

  const { count, error: countError } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('import_batch_id', job.id)
    .eq('status', 'posted')
  if (countError) return { ok: false, code: 'UNKNOWN_ERROR', error: countError }

  return {
    ok: true,
    dryRun: true,
    preview: {
      import_id: job.id,
      action,
      current_state: state,
      would_change: true,
      method: 'batch_storno',
      posted_entries_to_reverse: count ?? 0,
      posted_entries_deleted: 0,
      note: 'Every posted entry of the import gets a reversing entry; nothing is deleted. The RPC re-checks locks and live corrections at commit.',
    },
  }
}
