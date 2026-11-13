/**
 * Recovery sweep for pending_operations stuck in 'committing' (issue #843).
 *
 * The commit dispatcher (lib/pending-operations/commit.ts) claims an op by
 * flipping pending -> committing in an atomic CAS, runs the executor's
 * side-effects, then writes the terminal 'committed' status. If the process
 * dies between those steps, or the terminal write itself fails (the
 * "failed to finalize pending_operation to committed" log line from PR #841),
 * the row stays status='committing' forever: the expire cron only sweeps
 * status='pending', so stuck rows were invisible until this sweep.
 *
 * Semantics:
 *
 *  - Only rows whose updated_at is older than STUCK_COMMITTING_THRESHOLD_MINUTES
 *    are touched. The claim CAS is an UPDATE, and pending_operations has the
 *    standard update_updated_at_column() BEFORE UPDATE trigger, so updated_at
 *    IS the claim timestamp on a stuck row (nothing else updates a
 *    'committing' row without also changing its status). 15 minutes is well
 *    past the Vercel function ceiling (300s), so no in-flight executor can
 *    still be running when a row qualifies.
 *
 *  - Rows with positive evidence that the side-effects posted are finalized
 *    to 'committed' with result_data.recovered=true. Evidence is per
 *    operation_type and only exists where the op's params identify a target
 *    row whose posted state is observable (see findPostedEvidence).
 *
 *  - Rows with no detectable evidence go to terminal 'unknown'. NEVER back to
 *    'pending': re-executing could duplicate side-effects that posted without
 *    leaving a detectable trace (sent emails, journal entries not referenced
 *    by the params). The person verifies the entities before staging anew.
 *
 *  - Every terminal write is CAS-guarded on status='committing' so a
 *    concurrent finalize (or a second sweep run) can never clobber a row that
 *    just resolved. The DB immutability trigger
 *    (enforce_pending_operations_immutability) additionally blocks UPDATEs on
 *    terminal rows; the CAS means we never even hit it.
 *
 * Observability: one structured line per recovered row with the constant
 * message 'pending_op_recovery' (metric-style; count by `outcome`).
 * Runbook: grep Vercel logs for pending_op_recovery. outcome='committed'
 * needs no action (side-effects verified present): a warning.
 * outcome='unknown' means side-effects could not be verified: check the
 * entities named in params and do not re-stage until that check is complete.
 * That one needs a person, so it is an error (once: the row is terminal).
 *
 * Callers: the attest mail cron every 5 minutes, so a stuck row (which is in
 * none of the Godkänn / Avvisa tabs) is resolved within about 20 minutes
 * instead of at the next night's run, and the daily expire cron as before.
 * Two runs at once are safe: every write is the CAS above. A row whose probe
 * or write keeps failing is skipped by every run until it works: the
 * 5-minute caller logs that at warn (failureLevel), the nightly one at error,
 * so it reaches the error tracker once a day, not 288 times.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger, type Logger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Minutes a row may sit in 'committing' before the sweep considers it stuck.
 * Must stay comfortably above the max request duration (Vercel: 300s) so the
 * sweep can never race an in-flight executor.
 */
export const STUCK_COMMITTING_THRESHOLD_MINUTES = 15

export interface StuckCommittingRow {
  id: string
  company_id: string
  operation_type: string
  params: Record<string, unknown>
  updated_at: string
}

/**
 * Evidence signals, in the "what did we actually observe" sense. Serialized
 * into result_data.recovery.evidence so an auditor can see the basis for a
 * recovered 'committed'.
 */
export type PostedEvidence =
  | 'transaction_booked'
  | 'transaction_linked_to_target_entry'
  | 'invoice_payment_recorded'

export interface RecoverySummary {
  scanned: number
  committed: number
  unknown: number
  /** Probe errors + lost CAS races: rows left for the next run. */
  skipped: number
}

/**
 * Probe for positive evidence that a stuck op's side-effects posted.
 *
 * Returns an evidence label when the target state is observably present,
 * null when nothing detectable posted (or the type has no reliable probe).
 * Throws on probe/database errors: the caller must then SKIP the row (leave
 * it 'committing' for the next run) rather than reject on a transient error.
 *
 * Probes exist only where params identify the target and the posted state is
 * unambiguous:
 *
 *  - categorize_transaction: the staged transaction is anchored to a
 *    verifikat per the canonical is_transaction_booked(uuid) predicate
 *    (transactions.journal_entry_id, payment rows, or voucher links).
 *    Skipped when params.allow_duplicate=true: those ops intentionally post
 *    on an already-booked transaction, so "booked" proves nothing.
 *  - link_transaction_journal_entry: the exact (transaction, journal entry)
 *    pair from params is linked, via transactions.journal_entry_id or a
 *    transaction_voucher_links row.
 *  - match_transaction_invoice: an invoice_payments row exists for the exact
 *    (transaction, invoice) pair from params (unique index guarantees the
 *    pair is only ever written by a match).
 *
 * Everything else returns null by design: create_* ops don't know the id of
 * the row they would have created, and state-flag types (period locks,
 * invoice statuses) can't be distinguished from a user doing the same thing
 * manually while the row sat stuck. Be conservative: no evidence, no
 * 'committed'.
 */
export async function findPostedEvidence(
  supabase: SupabaseClient,
  row: StuckCommittingRow,
): Promise<PostedEvidence | null> {
  const params = row.params ?? {}

  switch (row.operation_type) {
    case 'categorize_transaction': {
      const transactionId = params.transaction_id
      if (typeof transactionId !== 'string' || transactionId.length === 0) return null
      // allow_duplicate ops post a second entry on an already-booked tx:
      // "booked" would be true before the executor ever ran.
      if (params.allow_duplicate === true) return null
      const { data, error } = await supabase.rpc('is_transaction_booked', {
        p_transaction_id: transactionId,
      })
      if (error) throw new Error(`is_transaction_booked probe failed: ${error.message}`)
      return data === true ? 'transaction_booked' : null
    }

    case 'link_transaction_journal_entry': {
      const transactionId = params.transaction_id
      const journalEntryId = params.journal_entry_id
      if (typeof transactionId !== 'string' || typeof journalEntryId !== 'string') return null

      const { data: tx, error: txError } = await supabase
        .from('transactions')
        .select('id')
        .eq('id', transactionId)
        .eq('company_id', row.company_id)
        .eq('journal_entry_id', journalEntryId)
        .maybeSingle()
      if (txError) throw new Error(`transactions probe failed: ${txError.message}`)
      if (tx) return 'transaction_linked_to_target_entry'

      const { data: link, error: linkError } = await supabase
        .from('transaction_voucher_links')
        .select('id')
        .eq('company_id', row.company_id)
        .eq('transaction_id', transactionId)
        .eq('journal_entry_id', journalEntryId)
        .maybeSingle()
      if (linkError) throw new Error(`transaction_voucher_links probe failed: ${linkError.message}`)
      return link ? 'transaction_linked_to_target_entry' : null
    }

    case 'match_transaction_invoice': {
      const transactionId = params.transaction_id
      const invoiceId = params.invoice_id
      if (typeof transactionId !== 'string' || typeof invoiceId !== 'string') return null
      const { data, error } = await supabase
        .from('invoice_payments')
        .select('id')
        .eq('company_id', row.company_id)
        .eq('transaction_id', transactionId)
        .eq('invoice_id', invoiceId)
        .maybeSingle()
      if (error) throw new Error(`invoice_payments probe failed: ${error.message}`)
      return data ? 'invoice_payment_recorded' : null
    }

    default:
      return null
  }
}

/** Pure builder for the terminal update payload, pinned by unit and pg tests. */
export function buildRecoveryUpdate(
  row: StuckCommittingRow,
  evidence: PostedEvidence | null,
  sweptAtIso: string,
): {
  status: 'committed' | 'unknown'
  resolved_at: string
  result_data: Record<string, unknown>
} {
  const recovery = {
    reason: 'stuck_committing',
    evidence,
    stuck_since: row.updated_at,
    swept_at: sweptAtIso,
  }
  if (evidence) {
    return {
      status: 'committed',
      resolved_at: sweptAtIso,
      result_data: { recovered: true, recovery },
    }
  }
  return {
    status: 'unknown',
    resolved_at: sweptAtIso,
    result_data: {
      outcome_unknown: true,
      reason: 'stuck_committing',
      recovery: {
        ...recovery,
        note:
          'Operation was interrupted and no trace of posted side effects was found. ' +
          'Closed without re-execution; verify the target entities manually before re-staging.',
      },
    },
  }
}

/**
 * Sweep rows stuck in 'committing' beyond the threshold and drive each to a
 * terminal status. Runs with the service-role client from the attest mail
 * cron (every 5 minutes) and the expire cron (daily); one failing row never
 * aborts the rest.
 */
export async function recoverStuckCommittingOperations(
  supabase: SupabaseClient,
  opts: {
    log?: Logger
    now?: Date
    /** The level of a row skipped because its probe or write failed (it is retried by the next run): 'error' by default, 'warn' for a caller that runs every few minutes. */
    failureLevel?: 'warn' | 'error'
  } = {},
): Promise<RecoverySummary> {
  const log = opts.log ?? createLogger('pending-operations/recover-stuck-committing')
  const now = opts.now ?? new Date()
  const logSkipped = (err: unknown, ctx: Record<string, unknown>): void => {
    if (opts.failureLevel === 'warn') log.warn('pending_op_recovery', { ...ctx, error: err instanceof Error ? err.message : (err as { message?: string })?.message })
    else log.error('pending_op_recovery', err as Error, ctx)
  }
  const cutoff = new Date(now.getTime() - STUCK_COMMITTING_THRESHOLD_MINUTES * 60_000)

  const stuck = await fetchAllRows<StuckCommittingRow>(({ from, to }) =>
    supabase
      .from('pending_operations')
      .select('id, company_id, operation_type, params, updated_at')
      .eq('status', 'committing')
      .lt('updated_at', cutoff.toISOString())
      .order('id', { ascending: true })
      .range(from, to),
  )

  const summary: RecoverySummary = {
    scanned: stuck.length,
    committed: 0,
    unknown: 0,
    skipped: 0,
  }

  for (const row of stuck) {
    const baseCtx = {
      pendingOperationId: row.id,
      companyId: row.company_id,
      operationType: row.operation_type,
      stuckSince: row.updated_at,
      ageMinutes: Math.round((now.getTime() - new Date(row.updated_at).getTime()) / 60_000),
    }

    let evidence: PostedEvidence | null
    try {
      evidence = await findPostedEvidence(supabase, row)
    } catch (err) {
      // Transient probe failure: leave the row 'committing' for the next
      // run rather than rejecting on incomplete information.
      summary.skipped++
      logSkipped(err, { ...baseCtx, outcome: 'skipped_probe_error' })
      continue
    }

    const update = buildRecoveryUpdate(row, evidence, new Date().toISOString())

    // CAS on status='committing': if a concurrent finalize resolved the row
    // between the listing and this write, zero rows match and we skip. The
    // immutability trigger never fires because OLD.status is not terminal on
    // any row we actually update.
    const { data: updated, error: updateError } = await supabase
      .from('pending_operations')
      .update(update)
      .eq('id', row.id)
      .eq('status', 'committing')
      .select('id')
      .maybeSingle()

    if (updateError) {
      summary.skipped++
      logSkipped(updateError, { ...baseCtx, outcome: 'skipped_write_error' })
      continue
    }
    if (!updated) {
      summary.skipped++
      log.warn('pending_op_recovery', { ...baseCtx, outcome: 'lost_cas' })
      continue
    }

    if (update.status === 'committed') summary.committed++
    else summary.unknown++

    const line = { ...baseCtx, outcome: update.status, evidence }
    if (update.status === 'unknown') log.error('pending_op_recovery', line)
    else log.warn('pending_op_recovery', line)
  }

  return summary
}
