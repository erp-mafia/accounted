/**
 * Daily GDPR retention purge for the WhatsApp channel.
 *
 * The receipt itself is 7-year WORM räkenskapsinformation (BFL 7 kap) and is
 * untouched here; everything conversational around it is short-lived. Each
 * pass enforces the retention table documented in .compliance/ropa.yaml
 * (whatsapp.receipt_intake):
 *
 *  1. Chat transcripts (body_text + raw_payload on whatsapp_messages) are
 *     purged after 90 days. The row skeleton survives for audit: wamid,
 *     direction, timestamps, processing_status and inbox_item_id keep the
 *     "a message existed and produced this Underlag row" trail without the
 *     content.
 *  2. Rows with no phone_link_id (unknown senders, plus rows orphaned by a
 *     link deletion) are DELETED after 30 days: pre-binding traffic has no
 *     contractual basis to keep, only the abuse-throttle window.
 *  3. Link codes are deleted 24h after expiry, used or not. The 10-minute
 *     TTL plus single-use flag already made them dead; this removes the
 *     hashes entirely.
 *  4. Sender rate counters older than 2 days are deleted: window keys are
 *     minute/day, so anything older can never be read again.
 *  5. Revoked phone links are crypto-shredded 90 days after revocation:
 *     phone_enc is cleared to '' (the column is NOT NULL, so empty string is
 *     the cleared marker). phone_hash stays (uniqueness history: the same
 *     phone re-linking later must still be resolvable) and phone_masked
 *     stays (display in any audit surface).
 *
 * Every action is idempotent (predicates only match rows still carrying the
 * data) and isolated in its own try/catch: one failing table never blocks
 * the purge of another. Volume-unbounded actions loop in id batches under a
 * shared wall-clock budget, mirroring the sweep's stance that a partial pass
 * is a latency regression, never a correctness problem: tomorrow's run picks
 * up the remainder.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('whatsapp-inbox/retention')

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

export const TRANSCRIPT_RETENTION_DAYS = 90
export const UNKNOWN_SENDER_RETENTION_DAYS = 30
export const LINK_CODE_GRACE_HOURS = 24
export const RATE_COUNTER_RETENTION_DAYS = 2
export const REVOKED_LINK_SHRED_DAYS = 90

export const BATCH = 200
/** maxDuration on the cron route is 300s; leave headroom for the response. */
const TIME_BUDGET_MS = 4 * 60 * 1000

export interface RetentionSummary {
  purgedTranscripts: number
  deletedUnknownSenderMessages: number
  deletedLinkCodes: number
  deletedRateCounters: number
  shreddedRevokedLinks: number
}

/** Run one retention pass. Never throws. */
export async function runRetention(supabase: SupabaseClient): Promise<RetentionSummary> {
  const summary: RetentionSummary = {
    purgedTranscripts: 0,
    deletedUnknownSenderMessages: 0,
    deletedLinkCodes: 0,
    deletedRateCounters: 0,
    shreddedRevokedLinks: 0,
  }
  const startedAt = Date.now()
  const budgetLeft = () => Date.now() - startedAt < TIME_BUDGET_MS

  // ── 1. Unknown-sender rows past 30 days: DELETE ─────────────
  // Runs before the transcript purge so a row that is both link-less and
  // past 90 days is deleted outright instead of being content-purged first.
  // Also catches outbound greeting rows (persistOutbound stores them with
  // phone_link_id null) and rows orphaned by ON DELETE SET NULL.
  try {
    const cutoff = new Date(startedAt - UNKNOWN_SENDER_RETENTION_DAYS * DAY_MS).toISOString()
    const { count, error } = await supabase
      .from('whatsapp_messages')
      .delete({ count: 'exact' })
      .is('phone_link_id', null)
      .lt('created_at', cutoff)
    if (error) throw error
    summary.deletedUnknownSenderMessages = count ?? 0
  } catch (err) {
    log.error('retention: unknown-sender delete failed', err)
  }

  // ── 2. Transcripts past 90 days: purge content, keep skeleton ──
  // Batched: the first pass over a backlog can touch many rows, and an
  // unbounded UPDATE risks the statement timeout. Only rows still carrying
  // content match, so re-runs never churn already-purged rows.
  try {
    const cutoff = new Date(startedAt - TRANSCRIPT_RETENTION_DAYS * DAY_MS).toISOString()
    while (budgetLeft()) {
      const { data, error } = await supabase
        .from('whatsapp_messages')
        .select('id')
        .lt('created_at', cutoff)
        .or('body_text.not.is.null,raw_payload.not.is.null')
        .order('created_at', { ascending: true })
        .limit(BATCH)
      if (error) throw error
      const ids = ((data ?? []) as { id: string }[]).map((row) => row.id)
      if (ids.length === 0) break
      const { error: updateError } = await supabase
        .from('whatsapp_messages')
        .update({ body_text: null, raw_payload: null })
        .in('id', ids)
      if (updateError) throw updateError
      summary.purgedTranscripts += ids.length
      if (ids.length < BATCH) break
    }
  } catch (err) {
    log.error('retention: transcript purge failed', err)
  }

  // ── 3. Link codes expired more than 24h ago: DELETE ─────────
  try {
    const cutoff = new Date(startedAt - LINK_CODE_GRACE_HOURS * HOUR_MS).toISOString()
    const { count, error } = await supabase
      .from('whatsapp_link_codes')
      .delete({ count: 'exact' })
      .lt('expires_at', cutoff)
    if (error) throw error
    summary.deletedLinkCodes = count ?? 0
  } catch (err) {
    log.error('retention: link-code cleanup failed', err)
  }

  // ── 4. Rate counters idle for 2+ days: DELETE ───────────────
  // Window keys are minute/day; a counter not touched for 2 days can never
  // be incremented or read again. (inbox_rate_counters, the per-company
  // sibling, has no equivalent cleanup anywhere yet; ours starts clean.)
  try {
    const cutoff = new Date(startedAt - RATE_COUNTER_RETENTION_DAYS * DAY_MS).toISOString()
    const { count, error } = await supabase
      .from('whatsapp_sender_rate_counters')
      .delete({ count: 'exact' })
      .lt('updated_at', cutoff)
    if (error) throw error
    summary.deletedRateCounters = count ?? 0
  } catch (err) {
    log.error('retention: rate-counter cleanup failed', err)
  }

  // ── 5. Links revoked 90+ days ago: crypto-shred phone_enc ───
  // phone_enc is NOT NULL, so '' is the cleared marker; the neq guard makes
  // the shred one-shot. phone_hash and phone_masked survive on purpose (see
  // module docblock).
  try {
    const cutoff = new Date(startedAt - REVOKED_LINK_SHRED_DAYS * DAY_MS).toISOString()
    const { count, error } = await supabase
      .from('whatsapp_phone_links')
      .update({ phone_enc: '' }, { count: 'exact' })
      .lt('revoked_at', cutoff)
      .neq('phone_enc', '')
    if (error) throw error
    summary.shreddedRevokedLinks = count ?? 0
  } catch (err) {
    log.error('retention: revoked-link shred failed', err)
  }

  return summary
}
