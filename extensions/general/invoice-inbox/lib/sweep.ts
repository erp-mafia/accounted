/**
 * Crash recovery for the staged upload.
 *
 * The web upload route inserts the inbox row as 'processing' and defers
 * Bedrock extraction to an after() worker that can die with the serverless
 * instance. A row stuck in 'processing' is durable state with no live owner:
 * this sweep flips it to 'received' with the empty extraction skeleton so it
 * becomes a normal manually-editable item. Deliberately NO re-extraction
 * here: the UI retry button covers that, and a cron that silently re-spends
 * Bedrock tokens on every crash would hide the crashes.
 *
 * Overlap with a slow live worker is safe: every mutation is a guarded claim
 * on status='processing' (and extracted_data still NULL), so the sweep and
 * the worker never both win one row.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { emptyResult } from './extract-invoice-fields'

const log = createLogger('invoice-inbox/sweep')

/**
 * A deferred extraction is now up to TWO Bedrock calls on up to 8 native PDF
 * pages: the base call can spend its full output budget (~90-150s at 8192
 * tokens) before the truncation retry doubles the cap and runs again. A live
 * worker can therefore be legitimately silent for several minutes; a cutoff
 * shorter than its worst case makes the sweep steal the row and discard the
 * worker's real result via the status CAS. Ten minutes clears the two-call
 * worst case with margin while still flipping genuinely crashed rows well
 * before anyone files a support mail about a stuck item.
 */
export const PROCESSING_STUCK_MS = 10 * 60 * 1000
const BATCH = 50

export interface InboxSweepSummary {
  /** Stale 'processing' rows flipped to 'received' with the empty skeleton. */
  flipped: number
}

/** Run one sweep pass. Never throws. */
export async function runInboxSweep(supabase: SupabaseClient): Promise<InboxSweepSummary> {
  const cutoff = new Date(Date.now() - PROCESSING_STUCK_MS).toISOString()

  const { data: stale, error: selectError } = await supabase
    .from('invoice_inbox_items')
    .select('id')
    .eq('status', 'processing')
    .lt('created_at', cutoff)
    .limit(BATCH)
  if (selectError) {
    log.error('stale-processing select failed', { error: selectError.message })
    return { flipped: 0 }
  }
  const ids = ((stale ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (ids.length === 0) return { flipped: 0 }

  // CAS: the status guard keeps a just-finished worker's real result, and
  // the extracted_data-still-NULL guard keeps any fields a caller PUT onto
  // the row in the meantime; a row that fails either guard is someone
  // else's win, not ours.
  const { data: claimed, error: updateError } = await supabase
    .from('invoice_inbox_items')
    .update({
      status: 'received',
      extracted_data: emptyResult() as unknown as Record<string, unknown>,
      extraction_skipped: false,
    })
    .in('id', ids)
    .eq('status', 'processing')
    .is('extracted_data', null)
    .select('id')
  if (updateError) {
    log.error('stale-processing flip failed', { error: updateError.message })
    return { flipped: 0 }
  }

  const flipped = Array.isArray(claimed) ? claimed.length : 0
  if (flipped > 0) {
    log.info('flipped stale processing rows to received', { flipped })
  }
  return { flipped }
}
