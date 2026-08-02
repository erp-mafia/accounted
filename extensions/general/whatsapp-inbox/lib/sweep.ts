/**
 * Per-minute crash-recovery sweep for the WhatsApp channel.
 *
 * The webhook 200s fast and defers all real work to after() invocations that
 * can die with the serverless instance. Everything here is a re-derivation
 * from durable state, so a lost invocation is a latency regression, never a
 * lost message:
 *
 *  1. Re-claim whatsapp_messages stuck in 'received' (>60s) or 'processing'
 *     (>90s); after MAX_ATTEMPTS they land in 'error'.
 *  2. Claim stale pending_ack conversations (debounce crash) and send the
 *     combined ack; re-arm conversations whose winner died after claiming
 *     but before sending (done rows left unacked).
 *  3. Expire questions past the 48h TTL: conversation back to idle, the
 *     item's pending_question -> moved_to_app. NEVER sends anything: the 24h
 *     service window is long gone, and v1 sends no templates.
 *  4. Clear expired 8h company pins.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { WhatsAppConversation } from '@/types'
import {
  COMPANY_CHOICE_EXPIRED,
  QUESTION_TTL_MS,
  STAGED_AWAITING_COMPANY,
  getContext,
  type ConversationContext,
} from './conversation'
import { finalizeBurst, processInboundMessage } from './process-inbound'
import { appendQuestionHistory, updateItemContext } from './item-context'

const log = createLogger('whatsapp-inbox/sweep')

const RECEIVED_STUCK_MS = 60 * 1000
const PROCESSING_STUCK_MS = 90 * 1000
const ACK_STALE_MS = 60 * 1000
const UNACKED_REARM_MS = 120 * 1000
const MAX_ATTEMPTS = 3
const BATCH = 25

export interface SweepSummary {
  reclaimedReceived: number
  reclaimedProcessing: number
  erroredMaxAttempts: number
  finalizedAcks: number
  expiredQuestions: number
  clearedPins: number
}

interface StuckRow {
  id: string
  attempts: number
  conversation_id: string | null
}

async function markMaxAttempts(
  supabase: SupabaseClient,
  row: StuckRow,
  fromStatus: 'received' | 'processing',
): Promise<void> {
  await supabase
    .from('whatsapp_messages')
    .update({ processing_status: 'error', error_message: 'Max attempts exceeded' })
    .eq('id', row.id)
    .eq('processing_status', fromStatus)
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
  }
  const finalizeConversations = new Set<string>()
  const now = Date.now()

  // ── 1a. Stuck 'received' rows ──────────────────────────────
  try {
    const cutoff = new Date(now - RECEIVED_STUCK_MS).toISOString()
    const { data } = await supabase
      .from('whatsapp_messages')
      .select('id, attempts, conversation_id')
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
      .select('id, attempts, conversation_id')
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
      // Re-arm only when no claim is pending (pending_ack=false): a pending
      // one is already covered by 2a or a live worker.
      await supabase
        .from('whatsapp_conversations')
        .update({ pending_ack: true, debounce_until: new Date().toISOString() })
        .eq('id', conversationId)
        .eq('pending_ack', false)
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
      if (conversation.state === 'awaiting_company') {
        await supabase
          .from('whatsapp_messages')
          .update({ error_message: COMPANY_CHOICE_EXPIRED })
          .eq('conversation_id', conversation.id)
          .eq('processing_status', 'skipped')
          .eq('error_message', STAGED_AWAITING_COMPANY)
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
      delete nextContext.company_options
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
      const nextContext: ConversationContext = { ...context }
      delete nextContext.pin_expires_at
      delete nextContext.pin_source
      await supabase
        .from('whatsapp_conversations')
        .update({ company_id: null, context: nextContext as Record<string, unknown> })
        .eq('id', conversation.id)
      summary.clearedPins++
    }
  } catch (err) {
    log.error('sweep: pin expiry pass failed', err)
  }

  return summary
}
