/**
 * Withdraw a pending operation: the connection that staged a proposal takes
 * it back while it still waits for approval (crm#1725, crm#1817).
 *
 * An agent that staged a duplicate or a wrong amount had no way to remove it:
 * rejecting needs pending_operations:approve, which a staging connection
 * deliberately lacks, so the mistaken proposal stayed in the person's queue
 * next to the corrected one and the wrong one got approved.
 *
 * The rule is ownership, not a scope: the operation must carry the caller's
 * own credential as its stager (pending_operations.actor_id is the API key or
 * OAuth connection that staged it, user_id the person it acts for). A key
 * never withdraws another key's proposal, and never a person's. Holding the
 * operation as stager already proves the key had the write scope it staged
 * with; a key's scopes do not change after it is issued.
 *
 * The write is rejectPendingOperations (./reject.ts), so the guard is the
 * same compare-and-set on status 'pending' every rejection has: an operation
 * an approval has claimed ('committing') is its executor's and is left alone.
 * No new status: the row closes as 'rejected' with rejection_category
 * 'superseded' (the system's "nobody judged it" value, never counted as a
 * person's verdict), result_data.withdrawn, the withdrawing credential, and
 * one PendingOperationRejected audit row marked withdrawn.
 *
 * Idempotent: withdrawing an operation this caller already withdrew answers
 * already_withdrawn and writes nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { rejectPendingOperations, type RejectActor } from './reject'

/** The longest reason a door accepts; the stored text adds WITHDRAWN_LEAD. */
export const WITHDRAW_REASON_MAX_LENGTH = 300

/** What the queue's history shows as the reason, before the stager's own words. */
export const WITHDRAWN_LEAD = 'Återtaget av agenten som lade förslaget'

export interface WithdrawPendingOperationInput {
  companyId: string
  id: string
  /** The stager's own words, optional. Trimmed and cut to WITHDRAW_REASON_MAX_LENGTH. */
  reason?: string
  /**
   * The caller. `id` is the credential (API key or OAuth connection) and is
   * what ownership is decided on; a caller without one owns nothing.
   */
  actor: RejectActor
  channel: 'mcp' | 'api'
}

export type WithdrawOutcome =
  | { outcome: 'withdrawn' }
  | { outcome: 'already_withdrawn' }
  | { outcome: 'not_found' }
  /** Staged by another connection or by a person. */
  | { outcome: 'not_own' }
  | { outcome: 'not_pending'; status: string }
  /** Read as pending, claimed by an approval or a rejection before the write. */
  | { outcome: 'lost_race' }

export type WithdrawPendingOperationResult =
  | { ok: true; result: WithdrawOutcome }
  | { ok: false; stage: 'fetch' | 'update'; error: { message: string; code?: string } }

interface StagedRow {
  id: string
  status: string
  user_id: string | null
  actor_id: string | null
  result_data: Record<string, unknown> | null
}

export async function withdrawPendingOperation(
  supabase: SupabaseClient,
  input: WithdrawPendingOperationInput,
): Promise<WithdrawPendingOperationResult> {
  const { companyId, id, actor, channel } = input

  const { data, error } = await supabase
    .from('pending_operations')
    .select('id, status, user_id, actor_id, result_data')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return { ok: false, stage: 'fetch', error: { message: error.message, code: error.code } }
  const row = data as StagedRow | null
  if (!row) return { ok: true, result: { outcome: 'not_found' } }

  // Ownership first, whatever the status: another stager's operation is
  // never described further than "not yours".
  if (!actor.id || row.actor_id !== actor.id || row.user_id !== actor.userId) {
    return { ok: true, result: { outcome: 'not_own' } }
  }
  if (row.status === 'rejected' && row.result_data?.withdrawn === true) {
    return { ok: true, result: { outcome: 'already_withdrawn' } }
  }
  if (row.status !== 'pending') return { ok: true, result: { outcome: 'not_pending', status: row.status } }

  const words = input.reason?.trim().slice(0, WITHDRAW_REASON_MAX_LENGTH)
  const rejected = await rejectPendingOperations(supabase, {
    companyId,
    ids: [id],
    category: 'superseded',
    reason: words ? `${WITHDRAWN_LEAD}: ${words}` : `${WITHDRAWN_LEAD}.`,
    actor,
    channel,
    withdrawn: true,
  })
  if (!rejected.ok) return rejected

  const outcome = rejected.outcomes[0]
  if (outcome.outcome === 'rejected') return { ok: true, result: { outcome: 'withdrawn' } }
  if (outcome.outcome === 'not_found') return { ok: true, result: { outcome: 'not_found' } }
  if (outcome.outcome === 'not_pending') return { ok: true, result: { outcome: 'not_pending', status: outcome.status } }
  return { ok: true, result: { outcome: 'lost_race' } }
}
