/**
 * The same proposal, staged again while the first is still open.
 *
 * An agent that loses track of what it staged (a long session, a retry after
 * a slow answer) stages the identical write a second time without an
 * idempotency_key. Both cards then wait in the queue; the person approves one
 * and the other stays pending until the 30-day expiry, approvable but dead: a
 * second reversal of a verifikat already reversed, an SIE file already
 * imported. Such twins are mostly reverse_entry and import_sie.
 *
 * Transaction claims (transaction-claims.ts) already settle this for the bank
 * rows a proposal books. This covers the types where two identical proposals
 * can only be one intention, by content, with the same outcome: once the new
 * proposal is staged, the stager's older open operations of the same type
 * with byte-identical params are rejected as superseded through the one
 * reject path. Nothing is lost, the new card holds exactly what the old one
 * did. Creation types stay out on purpose: two identical vouchers, trips or
 * transactions can be two real events.
 *
 * Never throws: the new operation is already staged, and an old twin left
 * pending is the harmless state this tidies.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { hashRequest } from '@/lib/api/idempotency'
import { createLogger } from '@/lib/logger'
import type { PendingOperation } from '@/types'
import { rejectPendingOperations } from './reject'
import type { Stager } from './transaction-claims'

const log = createLogger('pending-operations/identical-proposal')

/** Open operations read per check; a stager's own open twins are a handful. */
const CANDIDATE_LIMIT = 200

/**
 * The types whose identical twins are one intention: a verifikat reversed or
 * corrected the same way twice, the same SIE file imported twice. Every other
 * type is left alone without a read.
 */
const ONE_INTENTION_TYPES: ReadonlySet<string> = new Set([
  'reverse_entry',
  'correct_entry',
  'correct_entry_lines_inline',
  'import_sie',
])

/** The operation just staged, as its row reads. */
export interface StagedProposal {
  id: string
  operationType: string
  params: Record<string, unknown>
  /** Set inside gnubok_stage_across_companies: a batch is its own proposal. */
  batchId: string | null
}

/**
 * Reject the stager's older open operations that hold exactly `staged`'s
 * proposal: same company, type, stager and batch, identical params. Returns
 * the ids actually rejected (CAS on 'pending': one approved meanwhile stays).
 */
export async function supersedeIdenticalProposals(
  supabase: SupabaseClient,
  companyId: string,
  staged: StagedProposal,
  replacement: { stager: Stager; actorLabel?: string | null; channel: 'mcp' | 'api' },
): Promise<string[]> {
  if (!ONE_INTENTION_TYPES.has(staged.operationType)) return []
  const { stager } = replacement
  try {
    let query = supabase
      .from('pending_operations')
      .select('id, params')
      .eq('company_id', companyId)
      .eq('operation_type', staged.operationType)
      .eq('status', 'pending')
      .eq('user_id', stager.userId)
      .neq('id', staged.id)
    // A key is its id, whichever type its older proposals carry (transaction-claims.ts).
    query = stager.actorId
      ? query.eq('actor_id', stager.actorId)
      : query.eq('actor_type', stager.actorType).is('actor_id', null)
    query = staged.batchId ? query.eq('batch_id', staged.batchId) : query.is('batch_id', null)
    const { data, error } = await query.order('created_at', { ascending: true }).limit(CANDIDATE_LIMIT)
    if (error) throw new Error(error.message)
    if (!Array.isArray(data) || data.length === 0) return []

    // The stored params went through JSON; so does the comparison.
    const wanted = hashRequest(JSON.parse(JSON.stringify(staged.params)))
    const ids = (data as Array<Pick<PendingOperation, 'id' | 'params'>>)
      .filter((operation) => hashRequest(operation.params) === wanted)
      .map((operation) => operation.id)
    if (ids.length === 0) return []

    const result = await rejectPendingOperations(supabase, {
      companyId,
      ids,
      category: 'superseded',
      reason: `Ersatt av ett identiskt nyare förslag (${staged.id}).`,
      actor: {
        userId: stager.userId,
        type: stager.actorType,
        ...(stager.actorId ? { id: stager.actorId } : {}),
        ...(replacement.actorLabel ? { label: replacement.actorLabel } : {}),
      },
      channel: replacement.channel,
    })
    if (!result.ok) {
      log.warn('identical proposals not superseded', { companyId, ids, stage: result.stage, error: result.error.message })
      return []
    }
    return result.outcomes.filter((outcome) => outcome.outcome === 'rejected').map((outcome) => outcome.id)
  } catch (err) {
    log.warn('identical proposals not superseded', {
      companyId,
      operationType: staged.operationType,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}
