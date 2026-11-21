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
 *  6. Re-open parked receipts whose company question is closed but whose
 *     drain never landed (a failed UPDATE), and process them.
 *  7. Resend an M18 that Meta never accepted (the send itself failed), at
 *     most MAX_ERROR_NOTICE_SENDS times per message, the way pass 2b retries
 *     a combined ack whose send failed. A notice Meta accepted and later
 *     reported failed (131047: the 24h window closed) is not resent.
 *  8. Expire list questions (questions from a company's question list,
 *     list-question.ts) past the same 48h TTL. NEVER sends anything; the
 *     question stays open on the list.
 *
 * A run has a deadline: a re-claimed message can be a file the model reads
 * (up to 250 s), a pass holds up to 25 of them, and nothing stopped a run
 * from starting the next one at any point (seen at 102 s of its 300 in the 30
 * days to 2026-11-12). No message, ack or drain is started at or after
 * `deadlineAt`; what is left is counted, and the next run, a minute later,
 * derives it again from the same rows.
 *
 * A pass that cannot read its work says so: supabase-js answers a failed
 * query with `error`, it does not throw, and every pass read only `data`. A
 * failed scan therefore looked exactly like "nothing stuck", and a channel
 * whose recovery was not running reported a clean sweep every minute.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
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
import { TEMPLATE } from './messages'
import { expireListQuestions } from './list-question'

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
/** An M18 is sent at most this many times per message, the first send included. */
const MAX_ERROR_NOTICE_SENDS = 3
/** Pass 7 waits this long after the last failed M18 send before the next. */
const ERROR_NOTICE_RESEND_DELAY_MS = 60 * 1000
/** Pass 7 looks back this far: well inside Meta's 24h service window. */
const ERROR_NOTICE_RESEND_WINDOW_MS = 60 * 60 * 1000

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
  /** M18 notices resent by pass 7 after Meta refused the send. */
  resentErrorNotices: number
  /** Messages, acks and drains not started because the run's time was up:
   *  the next run finds them again. */
  deferred: number
  /** Passes that could not read their work or failed part-way (each also
   *  logged as an error). Non-empty means the run did not do its job. */
  failedPasses: string[]
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

/** An M18 send Meta refused, as pass 7 reads it. */
interface FailedNotice {
  id: string
  correlation_id: string
  phone_link_id: string
  conversation_id: string | null
  sender_phone_hash: string | null
  created_at: string
}

async function loadPhoneLink(
  supabase: SupabaseClient,
  phoneLinkId: string,
): Promise<{ phone_enc: string | null; revoked_at: string | null } | null> {
  const { data } = await supabase
    .from('whatsapp_phone_links')
    .select('phone_enc, revoked_at')
    .eq('id', phoneLinkId)
    .maybeSingle()
  return (data as { phone_enc: string | null; revoked_at: string | null } | null) ?? null
}

/** A pass's read failed: thrown inside the pass so its catch reports it like any other failure of that pass. */
function readFailed(what: string, error: { message: string }): Error {
  return new Error(`${what} could not be read: ${error.message}`)
}

/**
 * Run one sweep pass. Never throws: a pass that fails is logged and named in
 * `failedPasses`, and the passes after it still run. `deadlineAt` (epoch ms)
 * is when the run stops starting work.
 */
export async function runSweep(
  supabase: SupabaseClient,
  opts: { deadlineAt?: number } = {},
): Promise<SweepSummary> {
  const outOfTime = () => opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt
  const summary: SweepSummary = {
    reclaimedReceived: 0,
    reclaimedProcessing: 0,
    erroredMaxAttempts: 0,
    finalizedAcks: 0,
    expiredQuestions: 0,
    clearedPins: 0,
    outboundFailed24h: 0,
    reopenedOrphans: 0,
    resentErrorNotices: 0,
    deferred: 0,
    failedPasses: [],
  }
  const finalizeConversations = new Set<string>()
  const now = Date.now()

  // ── 1a. Stuck 'received' rows ──────────────────────────────
  try {
    const cutoff = new Date(now - RECEIVED_STUCK_MS).toISOString()
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select(
        'id, attempts, conversation_id, direction, message_type, sender_phone_hash, phone_link_id, correlation_id, raw_payload',
      )
      .eq('processing_status', 'received')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(BATCH)
    if (error) throw readFailed('stuck received rows', error)
    const rows = (data ?? []) as StuckRow[]
    for (const [index, row] of rows.entries()) {
      if (outOfTime()) {
        summary.deferred += rows.length - index
        break
      }
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
    summary.failedPasses.push('received')
  }

  // ── 1b. Stuck 'processing' rows (claimed, then the worker died) ──
  try {
    const cutoff = new Date(now - PROCESSING_STUCK_MS).toISOString()
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select(
        'id, attempts, conversation_id, direction, message_type, sender_phone_hash, phone_link_id, correlation_id, raw_payload',
      )
      .eq('processing_status', 'processing')
      .lt('updated_at', cutoff)
      .order('updated_at', { ascending: true })
      .limit(BATCH)
    if (error) throw readFailed('stuck processing rows', error)
    const rows = (data ?? []) as StuckRow[]
    for (const [index, row] of rows.entries()) {
      if (outOfTime()) {
        summary.deferred += rows.length - index
        break
      }
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
    summary.failedPasses.push('processing')
  }

  // ── 2a. Stale pending_ack (the debounce worker died pre-claim) ──
  try {
    const cutoff = new Date(now - ACK_STALE_MS).toISOString()
    const { data, error } = await supabase
      .from('whatsapp_conversations')
      .select('id')
      .eq('pending_ack', true)
      .lt('debounce_until', cutoff)
      .limit(BATCH)
    if (error) throw readFailed('stale pending acks', error)
    for (const row of ((data ?? []) as { id: string }[])) {
      finalizeConversations.add(row.id)
    }
  } catch (err) {
    log.error('sweep: stale pending_ack scan failed', err)
    summary.failedPasses.push('pending_ack')
  }

  // ── 2b. Unacked ingested rows whose winner died post-claim ──
  try {
    const cutoff = new Date(now - UNACKED_REARM_MS).toISOString()
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('conversation_id')
      .eq('direction', 'inbound')
      .eq('processing_status', 'done')
      .is('acked_at', null)
      .not('inbox_item_id', 'is', null)
      .not('conversation_id', 'is', null)
      .lt('updated_at', cutoff)
      .limit(BATCH * 2)
    if (error) throw readFailed('unacked rows', error)
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
    summary.failedPasses.push('unacked')
  }

  // A conversation not reached keeps its pending_ack (or its unacked rows), so the next run finds it again.
  for (const [index, conversationId] of [...finalizeConversations].entries()) {
    if (outOfTime()) {
      summary.deferred += finalizeConversations.size - index
      break
    }
    await finalizeBurst(supabase, conversationId)
    summary.finalizedAcks++
  }

  // ── 3. Question TTL (48h) ──────────────────────────────────
  try {
    const { data, error } = await supabase
      .from('whatsapp_conversations')
      .select('*')
      .neq('state', 'idle')
      .limit(BATCH * 2)
    if (error) throw readFailed('open questions', error)
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
      // classify() treats as an open choice even in idle. This pass stamps
      // only rows past the OUTER BOUND, where the answer is no longer in
      // doubt; whether a younger file is still fetchable is asked of Meta at
      // release time, in the drain, not guessed from an age here (#2363).
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
        const { count: stillStaged, error: stagedError } = await supabase
          .from('whatsapp_messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', conversation.id)
          .eq('processing_status', 'skipped')
          .eq('error_message', STAGED_AWAITING_COMPANY)
        // Unknown is not zero: taking a failed count as "nothing staged" would drop the company options the
        // parked receipts still wait on. The question stays as it is and expires on a later run.
        if (stagedError) throw readFailed('staged receipts of an expired company question', stagedError)
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
    summary.failedPasses.push('question_ttl')
  }

  // ── 4. Expired company pins (8h sliding) ───────────────────
  try {
    const { data, error } = await supabase
      .from('whatsapp_conversations')
      .select('*')
      .not('company_id', 'is', null)
      .limit(BATCH * 2)
    if (error) throw readFailed('pinned conversations', error)
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
    summary.failedPasses.push('pin_expiry')
  }

  // ── 5. Outbound delivery failures, last 24h (one head count) ──
  try {
    const since = new Date(now - 24 * 60 * 60 * 1000).toISOString()
    const { count, error } = await supabase
      .from('whatsapp_messages')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'outbound')
      .eq('delivery_status', 'failed')
      .gte('created_at', since)
    if (error) throw readFailed('outbound failures', error)
    summary.outboundFailed24h = count ?? 0
  } catch (err) {
    log.error('sweep: outbound failure count failed', err)
    summary.failedPasses.push('outbound_failures')
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
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('conversation_id, conversation:whatsapp_conversations!inner(context)')
      .eq('processing_status', 'skipped')
      .eq('error_message', STAGED_AWAITING_COMPANY)
      .lt('created_at', parkedBefore)
      .limit(BATCH * 4)
    if (error) throw readFailed('parked receipts', error)
    const orphaned = new Set<string>()
    for (const row of ((data ?? []) as unknown as Array<{
      conversation_id: string | null
      conversation: { context: Record<string, unknown> | null } | null
    }>)) {
      if (!row.conversation_id) continue
      const options = (row.conversation?.context as ConversationContext | null)?.company_options
      if (options && options.length > 0) continue // question still open: not an orphan
      orphaned.add(row.conversation_id)
    }
    for (const [index, conversationId] of [...orphaned].entries()) {
      if (outOfTime()) {
        summary.deferred += orphaned.size - index
        break
      }
      const drained = await drainParkedRows(supabase, conversationId)
      if (drained.reopenedIds.length === 0) continue
      log.info('sweep: re-opened orphaned parked receipts', {
        conversationId,
        count: drained.reopenedIds.length,
      })
      for (const [at, id] of drained.reopenedIds.entries()) {
        // A re-opened row not reached is a plain 'received' row now: pass 1a takes it on the next run.
        if (outOfTime()) {
          summary.deferred += drained.reopenedIds.length - at
          break
        }
        await processInboundMessage(supabase, id)
        summary.reopenedOrphans++
      }
    }
  } catch (err) {
    log.error('sweep: orphaned parked rows pass failed', err)
    summary.failedPasses.push('orphaned_parked')
  }

  // ── 7. M18 notices Meta never accepted ─────────────────────
  // sendText never throws: a refused M18 is persisted 'failed' with no wamid,
  // and its inbound row is already terminal 'error', so no other pass sends
  // it again. Without this the sender never heard about that receipt.
  try {
    // Every row of the window, not the newest N: the rows of exhausted and
    // finished messages stay in it, and a fixed limit let them crowd an older
    // notice out until its last attempt left the window.
    const rows = await fetchAllRows<FailedNotice>(
      ({ from, to }) =>
        supabase
          .from('whatsapp_messages')
          .select('id, correlation_id, phone_link_id, conversation_id, sender_phone_hash, created_at')
          .eq('direction', 'outbound')
          .eq('raw_payload->>template', TEMPLATE.m18Error)
          .eq('delivery_status', 'failed')
          .is('wamid', null)
          .not('correlation_id', 'is', null)
          .not('phone_link_id', 'is', null)
          .gte('created_at', new Date(now - ERROR_NOTICE_RESEND_WINDOW_MS).toISOString())
          .order('created_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      { dedupeBy: (row) => row.id },
    )
    const byMessage = new Map<string, { notice: FailedNotice; sends: number }>()
    for (const notice of rows) {
      const seen = byMessage.get(notice.correlation_id)
      // Newest first, so the first row seen is the last attempt.
      if (seen) seen.sends++
      else byMessage.set(notice.correlation_id, { notice, sends: 1 })
    }
    // The window's count is only a lower bound (an attempt older than the
    // hour is not in it), so it can skip a message but never clear one.
    const due = [...byMessage.values()].filter(
      ({ notice, sends }) =>
        sends < MAX_ERROR_NOTICE_SENDS &&
        new Date(notice.created_at).getTime() <= now - ERROR_NOTICE_RESEND_DELAY_MS,
    )
    for (const [index, { notice }] of due.entries()) {
      if (outOfTime()) {
        summary.deferred += due.length - index
        break
      }
      // The cap counts every M18 this message ever got. Counting only the
      // window let attempts age out of it, so a message Meta kept refusing
      // got three sends an hour without end.
      const { count, error: countError } = await supabase
        .from('whatsapp_messages')
        .select('id', { count: 'exact', head: true })
        .eq('direction', 'outbound')
        .eq('correlation_id', notice.correlation_id)
        .eq('raw_payload->>template', TEMPLATE.m18Error)
      if (countError) throw readFailed('error notice attempts', countError)
      if (count == null || count >= MAX_ERROR_NOTICE_SENDS) continue
      const link = await loadPhoneLink(supabase, notice.phone_link_id)
      if (!link || link.revoked_at) continue
      const to = resolveRecipient(notice as unknown as WhatsAppMessage, link)
      if (!to) continue
      // Re-checks for an accepted notice first, so one that went out resends nothing.
      const resent = await sendErrorNoticeOnce(supabase, {
        to,
        senderPhoneHash: notice.sender_phone_hash,
        phoneLinkId: notice.phone_link_id,
        conversationId: notice.conversation_id,
        correlationId: notice.correlation_id,
      })
      if (resent) summary.resentErrorNotices++
    }
  } catch (err) {
    log.error('sweep: error notice resend pass failed', err)
    summary.failedPasses.push('error_notice_resend')
  }

  // ── 8. List question TTL (48h) ─────────────────────────────
  // List questions ride on idle conversations, which pass 3 does not read.
  try {
    summary.expiredQuestions += await expireListQuestions(supabase, now)
  } catch (err) {
    log.error('sweep: list question TTL pass failed', err)
    summary.failedPasses.push('list_question_ttl')
  }

  return summary
}
