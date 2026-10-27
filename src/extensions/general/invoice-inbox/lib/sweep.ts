/**
 * Crash recovery for the staged upload, and the one automatic re-read.
 *
 * The web upload route inserts the inbox row as 'processing' and defers
 * Bedrock extraction to an after() worker that can die with the serverless
 * instance. A row stuck in 'processing' is durable state with no live owner:
 * this sweep flips it to 'received' with the empty extraction skeleton so it
 * becomes a normal manually-editable item. A crashed worker is never read
 * again here: the UI retry button covers that, and a cron that silently
 * re-spends Bedrock tokens on every crash would hide the crashes.
 *
 * The one exception is narrower than a crash: a reading the AI provider
 * itself could not take (stamped failed:provider_unavailable on the document:
 * a 5xx, a throttle, a dropped connection, the reading's deadline). Those say
 * nothing about our code or the document, and on 2026-10-26 a three-hour
 * Bedrock outage left dozens of items looking unreadable. They are read again
 * by retryProviderUnavailableReadings (./provider-retry.ts): at most three
 * readings in all, 15 minutes then two hours apart, three documents per pass,
 * behind the same entitlement and sandbox gates as the upload, and with a
 * compare-and-set on the item so a person's edit is never overwritten. Every
 * other failure, crashes included, is still never retried here and keeps its
 * own stamp; every retry leaves a history line and a log line.
 *
 * Overlap with a slow live worker is safe: every mutation is a guarded claim
 * on status='processing' (and extracted_data still NULL), so the sweep and
 * the worker never both win one row. Overlapping sweep runs are safe for the
 * re-read too: it claims the document's stamp before reading.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { requeueHiddenRoutedItems, routeStaleQueueItems } from './route-from-arkiv'
import { retryProviderUnavailableReadings, type ProviderRetrySummary } from './provider-retry'
import { createLogger } from '@/lib/logger'
import { emptyResult } from '@/lib/documents/inbox-extraction/extract-invoice-fields'

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
  /** Queue rows whose document Arkiv classified as something not booked from here, sent to Arkiv (phase 7 catch-up). */
  routed?: number
  /** Routed rows of companies that do not see the Dokument section, brought back to Underlag. */
  requeued?: number
  /** Readings the AI provider could not take, read again (./provider-retry.ts). */
  reread?: ProviderRetrySummary
}

/** Run one sweep pass. Never throws. */
export async function runInboxSweep(supabase: SupabaseClient): Promise<InboxSweepSummary> {
  const summary = await flipStaleProcessing(supabase)
  let requeued = 0
  try {
    requeued = await requeueHiddenRoutedItems(supabase)
    if (requeued > 0) log.info('brought routed rows back to underlag', { requeued })
  } catch (err) {
    log.error('routed row requeue failed', { error: err instanceof Error ? err.message : String(err) })
  }
  let routed = 0
  try {
    routed = await routeStaleQueueItems(supabase)
    if (routed > 0) log.info('routed stale queue rows to arkiv', { routed })
  } catch (err) {
    log.error('stale queue routing failed', { error: err instanceof Error ? err.message : String(err) })
  }
  // Last: its readings can take minutes, the steps above take milliseconds.
  const reread = await retryProviderUnavailableReadings(supabase)
  return { ...summary, routed, requeued, reread }
}

async function flipStaleProcessing(supabase: SupabaseClient): Promise<InboxSweepSummary> {
  const cutoff = new Date(Date.now() - PROCESSING_STUCK_MS).toISOString()

  const { data: stale, error: selectError } = await supabase.from('invoice_inbox_items').select('id').eq('status', 'processing').lt('created_at', cutoff).limit(BATCH)
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
