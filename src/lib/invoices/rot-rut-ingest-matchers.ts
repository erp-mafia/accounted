/**
 * Ingest matchers: Skatteverket's ROT/RUT payout for an income row of a new
 * import, against the company's open begäran.
 *
 * rot-rut-payout: the one begäran whose expected payout equals the row,
 * always a suggestion (potential_rot_rut_payout_request_id), never a hard
 * link: the match route books the 19xx/1513 voucher when it confirms.
 *
 * rot-rut-payout-set: no single begäran equals the row, so Skatteverket may
 * have bundled the beslut it paid that day into one transfer: the exact
 * covering set (#2239). A set has no hint column (the inbox and the worklist
 * recompute it from the open pool), but the row still skips the mapping
 * engine and the begäran leave the pool exactly like a 1:1 hint.
 *
 * Both read the same open begäran, once per batch, and a begäran either one
 * claims is never offered again. New rows only: a re-read never gets them.
 */
import type { IngestBatch, IngestMatcher } from '@/lib/transactions/ingest-matcher'
import { loadOpenRotRutPayoutRequests } from './rot-rut-payout-candidates'
import { findRotRutPayoutMatch, type RotRutPayoutRequestCandidate } from './rot-rut-payout-matching'
import { findRotRutPayoutSetMatch } from './rot-rut-payout-set-matching'

interface RotRutIngestState {
  /** The open begäran as read for the batch; claims say which are taken. */
  requests: readonly RotRutPayoutRequestCandidate[]
}

/** One read per batch, shared by both matchers, whichever prepares first. */
const openRequestsByBatch = new WeakMap<IngestBatch, Promise<RotRutPayoutRequestCandidate[]>>()

async function prepareRotRut(batch: IngestBatch): Promise<RotRutIngestState> {
  let requests = openRequestsByBatch.get(batch)
  if (!requests) {
    // Never throws: a failed read is an empty pool.
    requests = loadOpenRotRutPayoutRequests(batch.supabase, batch.companyId)
    openRequestsByBatch.set(batch, requests)
  }
  return { requests: await requests }
}

const unclaimed = (batch: IngestBatch, state: RotRutIngestState): RotRutPayoutRequestCandidate[] =>
  state.requests.filter((request) => !batch.claims.has('rot_rut_request', request.id))

export const rotRutPayoutIngestMatcher: IngestMatcher<RotRutIngestState> = {
  id: 'rot-rut-payout',
  order: 330,
  module: 'invoicing',
  direction: 'income',
  onReread: false,
  prepare: prepareRotRut,
  async match(batch, state, { tx }) {
    const open = unclaimed(batch, state)
    if (open.length === 0) return 'none'
    const match = findRotRutPayoutMatch(tx, open)
    if (!match || batch.claims.has('rot_rut_request', match.request.id)) return 'none'
    // supabase-js resolves a failed update with { error }: a hint that never
    // persisted must not claim the begäran or count as a match.
    const { error: hintError } = await batch.supabase
      .from('transactions')
      .update({ potential_rot_rut_payout_request_id: match.request.id })
      .eq('id', tx.id)
    if (hintError) throw hintError

    await batch.logMatch(tx.id, 'auto_suggested', {
      matchConfidence: match.confidence,
      matchMethod: match.matchMethod,
      newState: { rot_rut_payout_request_id: match.request.id },
    })

    // One payout per begäran: a second row of the same amount can't claim
    // it, and the mapping engine is skipped (an auto-categorised 19xx/3xxx
    // voucher would collide with the 1513 clearing the match books).
    batch.claims.add('rot_rut_request', match.request.id)
    batch.result.auto_matched_invoices++
    return 'explained'
  },
}

export const rotRutPayoutSetIngestMatcher: IngestMatcher<RotRutIngestState> = {
  id: 'rot-rut-payout-set',
  order: 340,
  module: 'invoicing',
  direction: 'income',
  onReread: false,
  prepare: prepareRotRut,
  async match(batch, state, { tx }) {
    const open = unclaimed(batch, state)
    if (open.length === 0) return 'none'
    // A single begäran equal to the row is rot-rut-payout's to decide, even
    // when its hint was refused: it is never offered as a set.
    if (findRotRutPayoutMatch(tx, open)) return 'none'
    const set = findRotRutPayoutSetMatch(tx, open)
    if (!set || set.requests.length <= 1) return 'none'

    const requestIds = set.requests.map((request) => request.id)
    await batch.logMatch(tx.id, 'auto_suggested', {
      matchConfidence: set.confidence,
      matchMethod: set.matchMethod,
      newState: { rot_rut_payout_request_ids: requestIds },
    })
    for (const id of requestIds) batch.claims.add('rot_rut_request', id)
    batch.result.auto_matched_invoices++
    return 'explained'
  },
}
