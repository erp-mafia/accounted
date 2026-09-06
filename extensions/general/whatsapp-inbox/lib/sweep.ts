/**
 * Per-minute crash-recovery sweep for the WhatsApp channel.
 *
 * The webhook 200s fast and defers all real work to after() invocations that
 * can die with the serverless instance. Everything here is a re-derivation
 * from durable state, so a lost invocation is a latency regression, never a
 * lost message:
 *
 *  1. Re-claim whatsapp_messages stuck in 'received' (>60s) or 'processing'
 *     (>5 min, safely above the worst-case live worker); after MAX_ATTEMPTS
 *     they land in 'error' and the sender gets one M18.
 *  2. Claim stale pending_ack conversations (debounce crash) and send the
 *     combined ack; re-arm conversations whose winner died after claiming
 *     but before sending (done rows left unacked).
 *  3. Expire questions past the 48h TTL: conversation back to idle, the
 *     item's pending_question -> moved_to_app. NEVER sends anything: the 24h
 *     service window is long gone, and v1 sends no templates. Company
 *     questions keep their options and their parked receipts, so a late
 *     answer still files them (see the pass itself).
 *  4. Clear expired 8h company pins.
 *  5. Count outbound sends that failed in the last 24h, so the per-minute
 *     "whatsapp sweep complete" log line surfaces delivery problems nothing
 *     else reads (delivery_status is otherwise write-only).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { WhatsAppConversation, WhatsAppMessage } from '@/types'
import {
  COMPANY_CHOICE_EXPIRED,
  QUESTION_TTL_MS,
  STAGED_AWAITING_COMPANY,
  STAGED_MEDIA_MAX_AGE_MS,
  getContext,
  resolveRecipient,
  updateConversation,
  type ConversationContext,
} from './conversation'
import { finalizeBurst, processInboundMessage, sendErrorNoticeOnce } from './process-inbound'
import { drainParkedRows } from './company-question'
import { appendQuestionHistory, updateItemContext } from './item-context'

const log = createLogger('whatsapp-inbox/sweep')

const RECEIVED_STUCK_MS = 60 * 1000
/**
 * A 'processing' row is only stuck if no live worker can still be on it.
 * The enforced step budget of one media row is markRead (10s) + media lookup
 * (10s) + download (30s) + Bedrock extraction (the cron route budgets 10-60s,
 * with no short SDK timeout), under a maxDuration of 300s, and there is no
 * heartbeat between the claim and the terminal write. 90s therefore re-claimed
 * live workers on ordinary large PDFs and ran two of them on the same message.
 * A crashed row waiting five minutes is a latency regression; two concurrent
 * workers are a correctness problem.
 */
const PROCESSING_STUCK_MS = 5 * 60 * 1000
const ACK_STALE_MS = 60 * 1000
const UNACKED_REARM_MS = 120 * 1000
const MAX_ATTEMPTS = 3
const BATCH = 25
/** A parked row younger than this may simply be waiting for its question to
 *  be armed (park, then guarded transition): not an orphan yet. */
const ORPHAN_PARKED_MIN_AGE_MS = 2 * 60 * 1000

export interface SweepSummary {
  reclaimedReceived: number
  reclaimedProcessing: number
  erroredMaxAttempts: number
  finalizedAcks: number
  expiredQuestions: number
  clearedPins: number
  /** Outbound rows with delivery_status='failed' created in the last 24h
   *  (Graph send failure or a Meta 'failed' status callback). Observability
   *  only: the sweep log line is the consumer. */
  outboundFailed24h: number
  /** Parked rows with no open company question left to re-open them,
   *  re-opened and processed by pass 6. */
  reopenedOrphans: number
}

interface StuckRow {
  id: string
  attempts: number
  conversation_id: string | null
  direction: string
  message_type: string
  sender_phone_hash: string | null
  phone_link_id: string | null
  correlation_id: string | null
  raw_payload: Record<string, unknown> | null
}

/**
 * Park a row that ran out of attempts, and tell the sender once. Without the
 * notice a file whose FIRST attempt died with the instance ends terminally
 * with no ack and no error: the burst ack only lists ingested rows, so that
 * receipt simply vanishes from the conversation.
 */
async function markMaxAttempts(
  supabase: SupabaseClient,
  row: StuckRow,
  fromStatus: 'received' | 'processing',
): Promise<void> {
  const { data: parked } = await supabase
    .from('whatsapp_messages')
    .update({ processing_status: 'error', error_message: 'Max attempts exceeded' })
    .eq('id', row.id)
    .eq('processing_status', fromStatus)
    .select('id')
  if (Array.isArray(parked) && parked.length === 0) return
  if (row.message_type === 'text') return // M18 is about files

  const link = row.phone_link_id
    ? await loadPhoneLink(supabase, row.phone_link_id)
    : null
  const to = resolveRecipient(row as unknown as WhatsAppMessage, link)
  if (!to) return
  await sendErrorNoticeOnce(supabase, {
    to,
    senderPhoneHash: row.sender_phone_hash,
    phoneLinkId: row.phone_link_id,
    conversationId: row.conversation_id,
    correlationId: row.correlation_id,
  })
}

async function loadPhoneLink(
  supabase: SupabaseClient,
  phoneLinkId: string,
): Promise<{ phone_enc: string | null } | null> {
  const { data } = await supabase
    .from('whatsapp_phone_links')
    .select('phone_enc')
    .eq('id', phoneLinkId)
    .maybeSingle()
  return (data as { phone_enc: string | null } | null) ?? null
}

/** Run one sweep pass. Never throws. */
export async function runSweep(supabase: SupabaseClient): Promise<SweepSummary> {
  const summary: SweepSummary = {
    reclaimedReceived: 0,
    reclaimedProcessing: 0,
    erroredMaxAttempts: 0,
    finalizedAcks: 0,
    expiredQuestions: 0,
    clearedPins: 0,
    outboundFailed24h: 0,
    reopenedOrphans: 0,
  }
  const finalizeConversations = new Set<string>()
  const now = Date.now()

  // ── 1a. Stuck 'received' rows ──────────────────────────────
  try {
    const cutoff = new Date(now - RECEIVED_STUCK_MS).toISOString()
    const { data } = await supabase
      .from('whatsapp_messages')
      .select(
        'id, attempts, conversation_id, direction, message_type, sender_phone_hash, phone_link_id, correlation_id, raw_payload',
      )
      .eq('processing_status', 'received')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(BATCH)
    for (const row of ((data ?? []) as StuckRow[])) {
      if (row.attempts >= MAX_ATTEMPTS) {
        await markMaxAttempts(supabase, row, 'received')
        summary.erroredMaxAttempts++
        continue
      }
      const outcome = await processInboundMessage(supabase, row.id)
      summary.reclaimedReceived++
      if (outcome.kind === 'media_processed' && outcome.conversationId) {
        finalizeConversations.add(outcome.conversationId)
      }
    }
  } catch (err) {
    log.error('sweep: received re-claim failed', err)
  }

  // ── 1b. Stuck 'processing' rows (claimed, then the worker died) ──
  try {
    const cutoff = new Date(now - PROCESSING_STUCK_MS).toISOString()
    const { data } = await supabase
      .from('whatsapp_messages')
      .select(
        'id, attempts, conversation_id, direction, message_type, sender_phone_hash, phone_link_id, correlation_id, raw_payload',
      )
      .eq('processing_status', 'processing')
      .lt('updated_at', cutoff)
      .order('updated_at', { ascending: true })
      .limit(BATCH)
    for (const row of ((data ?? []) as StuckRow[])) {
      if (row.attempts >= MAX_ATTEMPTS) {
        await markMaxAttempts(supabase, row, 'processing')
        summary.erroredMaxAttempts++
        continue
      }
      // Guarded reset back to 'received'; processInboundMessage re-claims.
      const { data: reset } = await supabase
        .from('whatsapp_messages')
        .update({ processing_status: 'received' })
        .eq('id', row.id)
        .eq('processing_status', 'processing')
        .select('id')
        .maybeSingle()
      if (!reset) continue
      const outcome = await processInboundMessage(supabase, row.id)
      summary.reclaimedProcessing++
      if (outcome.kind === 'media_processed' && outcome.conversationId) {
        finalizeConversations.add(outcome.conversationId)
      }
    }
  } catch (err) {
    log.error('sweep: processing re-claim failed', err)
  }

  // ── 2a. Stale pending_ack (the debounce worker died pre-claim) ──
  try {
    const cutoff = new Date(now - ACK_STALE_MS).toISOString()
    const { data } = await supabase
      .from('whatsapp_conversations')
      .select('id')
      .eq('pending_ack', true)
      .lt('debounce_until', cutoff)
      .limit(BATCH)
    for (const row of ((data ?? []) as { id: string }[])) {
      finalizeConversations.add(row.id)
    }
  } catch (err) {
    log.error('sweep: stale pending_ack scan failed', err)
  }

  // ── 2b. Unacked ingested rows whose winner died post-claim ──
  try {
    const cutoff = new Date(now - UNACKED_REARM_MS).toISOString()
    const { data } = await supabase
      .from('whatsapp_messages')
      .select('conversation_id')
      .eq('direction', 'inbound')
      .eq('processing_status', 'done')
      .is('acked_at', null)
      .not('inbox_item_id', 'is', null)
      .not('conversation_id', 'is', null)
      .lt('updated_at', cutoff)
      .limit(BATCH * 2)
    const conversationIds = [
      ...new Set(((data ?? []) as { conversation_id: string }[]).map((r) => r.conversation_id)),
    ]
    for (const conversationId of conversationIds) {
      // pending_ack=false plus unacked rows is ALSO the state of a live
      // claimant between claimAck and its acked_at stamp, and the 120s cutoff
      // above measures the ROWS' done-stamp, not when the ack was claimed. So
      // the conversation's own updated_at (which claimAck bumps) is the second
      // condition: without it the sweep re-armed under a working finalize and
      // a second combined ack went out.
      await supabase
        .from('whatsapp_conversations')
        .update({ pending_ack: true, debounce_until: new Date().toISOString() })
        .eq('id', conversationId)
        .eq('pending_ack', false)
        .lt('updated_at', cutoff)
      finalizeConversations.add(conversationId)
    }
  } catch (err) {
    log.error('sweep: unacked re-arm failed', err)
  }

  for (const conversationId of finalizeConversations) {
    await finalizeBurst(supabase, conversationId)
    summary.finalizedAcks++
  }

  // ── 3. Question TTL (48h) ──────────────────────────────────
  try {
    const { data } = await supabase
      .from('whatsapp_conversations')
      .select('*')
      .neq('state', 'idle')
      .limit(BATCH * 2)
    for (const conversation of ((data ?? []) as WhatsAppConversation[])) {
      const context = getContext(conversation)
      const askedAt = context.pending_question?.asked_at
      const expired =
        askedAt == null || now - new Date(askedAt).getTime() > QUESTION_TTL_MS
      if (!expired) continue

      // Current question -> moved_to_app on the item (company questions have
      // no item; their parked rows get the expired marker instead).
      const pending = context.pending_question
      if (pending?.inbox_item_id) {
        await updateItemContext(supabase, pending.inbox_item_id, (itemContext) => ({
          ...itemContext,
          pending_question:
            itemContext.pending_question && itemContext.pending_question.status === 'open'
              ? { ...itemContext.pending_question, status: 'moved_to_app' }
              : itemContext.pending_question,
        }))
        await appendQuestionHistory(supabase, {
          inboxItemId: pending.inbox_item_id,
          eventType: 'ChannelQuestionExpired',
          questionType: pending.type,
        })
      }
      // Company questions are the one kind whose expiry used to DESTROY work:
      // the parked receipts were stamped company_choice_expired, a marker no
      // code reads, so they never became Underlag rows and nothing ever told
      // the user. The 24h service window is long gone at 48h and v1 sends no
      // templates, so the honest recovery is to keep accepting a LATE answer:
      // the rows stay staged and company_options stay in the context, which
      // classify() treats as an open choice even in idle. Only when Meta has
      // stopped serving the media (~30 days) does the marker become true.
      let keepCompanyOptions = false
      if (conversation.state === 'awaiting_company') {
        const staleCutoff = new Date(now - STAGED_MEDIA_MAX_AGE_MS).toISOString()
        await supabase
          .from('whatsapp_messages')
          .update({ error_message: COMPANY_CHOICE_EXPIRED })
          .eq('conversation_id', conversation.id)
          .eq('processing_status', 'skipped')
          .eq('error_message', STAGED_AWAITING_COMPANY)
          .lt('created_at', staleCutoff)
        const { count: stillStaged } = await supabase
          .from('whatsapp_messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', conversation.id)
          .eq('processing_status', 'skipped')
          .eq('error_message', STAGED_AWAITING_COMPANY)
        keepCompanyOptions = (stillStaged ?? 0) > 0
      }
      // Queued questions expire with the episode.
      for (const queued of context.question_queue ?? []) {
        await updateItemContext(supabase, queued.inbox_item_id, (itemContext) => ({
          ...itemContext,
          pending_question: itemContext.pending_question ?? {
            type: queued.type,
            asked_at: new Date().toISOString(),
            status: 'moved_to_app',
          },
        }))
      }

      const nextContext: ConversationContext = {
        ...context,
        recent_questions: (context.recent_questions ?? []).map((q) =>
          q.status === 'open' && q.inbox_item_id === pending?.inbox_item_id
            ? { ...q, status: 'moved_to_app' }
            : q,
        ),
      }
      delete nextContext.pending_question
      if (!keepCompanyOptions) delete nextContext.company_options
      delete nextContext.question_queue
      await supabase
        .from('whatsapp_conversations')
        .update({ state: 'idle', context: nextContext as Record<string, unknown> })
        .eq('id', conversation.id)
        .eq('state', conversation.state)
      summary.expiredQuestions++
    }
  } catch (err) {
    log.error('sweep: question TTL pass failed', err)
  }

  // ── 4. Expired company pins (8h sliding) ───────────────────
  try {
    const { data } = await supabase
      .from('whatsapp_conversations')
      .select('*')
      .not('company_id', 'is', null)
      .limit(BATCH * 2)
    for (const conversation of ((data ?? []) as WhatsAppConversation[])) {
      const context = getContext(conversation)
      const expiresAt = context.pin_expires_at
      if (expiresAt != null && new Date(expiresAt).getTime() > now) continue
      // Guarded, and re-checked against fresh state: this loop awaits a
      // network round trip per row, so a company choice applied in between
      // used to be reverted (company_id nulled, the pre-choice context
      // restored) and the question re-asked seconds after the user answered.
      const cleared = await updateConversation(supabase, conversation, (_current, currentContext) => {
        const stillExpired =
          currentContext.pin_expires_at == null ||
          new Date(currentContext.pin_expires_at).getTime() <= Date.now()
        if (!stillExpired) return null
        const nextContext: ConversationContext = { ...currentContext }
        delete nextContext.pin_expires_at
        delete nextContext.pin_source
        return { company_id: null, context: nextContext }
      })
      if (cleared) summary.clearedPins++
    }
  } catch (err) {
    log.error('sweep: pin expiry pass failed', err)
  }

  // ── 5. Outbound delivery failures, last 24h (one head count) ──
  try {
    const since = new Date(now - 24 * 60 * 60 * 1000).toISOString()
    const { count } = await supabase
      .from('whatsapp_messages')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'outbound')
      .eq('delivery_status', 'failed')
      .gte('created_at', since)
    summary.outboundFailed24h = count ?? 0
  } catch (err) {
    log.error('sweep: outbound failure count failed', err)
  }

  // ── 6. Orphaned parked rows ────────────────────────────────
  // A row parked behind the company question whose conversation no longer
  // holds an open question (company_options gone) has nobody left to
  // re-open it: the drain that should have done so errored (#2062), or the
  // answer landed and its re-open UPDATE failed. Run the same drain the
  // answer path uses and process what comes back; the re-run resolves each
  // row against the fresh pin, the default, or the sole live company, or
  // re-asks the question properly. The age guard keeps a row that was parked
  // milliseconds before its question was armed out of this pass.
  try {
    const parkedBefore = new Date(now - ORPHAN_PARKED_MIN_AGE_MS).toISOString()
    const { data } = await supabase
      .from('whatsapp_messages')
      .select('conversation_id, conversation:whatsapp_conversations!inner(context)')
      .eq('processing_status', 'skipped')
      .eq('error_message', STAGED_AWAITING_COMPANY)
      .lt('created_at', parkedBefore)
      .limit(BATCH * 4)
    const orphaned = new Set<string>()
    for (const row of ((data ?? []) as Array<{
      conversation_id: string | null
      conversation: { context: Record<string, unknown> | null } | null
    }>)) {
      if (!row.conversation_id) continue
      const options = (row.conversation?.context as ConversationContext | null)?.company_options
      if (options && options.length > 0) continue // question still open: not an orphan
      orphaned.add(row.conversation_id)
    }
    for (const conversationId of orphaned) {
      const drained = await drainParkedRows(supabase, conversationId)
      if (drained.reopenedIds.length === 0) continue
      log.info('sweep: re-opened orphaned parked receipts', {
        conversationId,
        count: drained.reopenedIds.length,
      })
      for (const id of drained.reopenedIds) {
        await processInboundMessage(supabase, id)
        summary.reopenedOrphans++
      }
    }
  } catch (err) {
    log.error('sweep: orphaned parked rows pass failed', err)
  }

  return summary
}
