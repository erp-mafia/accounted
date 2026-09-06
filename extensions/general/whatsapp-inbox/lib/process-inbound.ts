/**
 * Deferred conversation worker: inbound WhatsApp rows -> Underlag items,
 * burst-debounced combined acks, clarifying questions and answer handling.
 *
 * The webhook persists rows and 200s fast; this worker runs via the after()
 * idiom (lib/webhooks/dispatch-kick.ts) or the per-minute sweep cron. The
 * whatsapp_messages row IS the durable job record: the atomic claim
 * (UPDATE ... WHERE processing_status='received' RETURNING) makes redelivered
 * webhooks and sweep re-claims safe to race.
 *
 * Reply model (PR4): individual media items ingest immediately, but the
 * RECEIPT ack is debounced per conversation. Every burst invocation sleeps to
 * its own debounce deadline and attempts the atomic pending_ack claim; the
 * single winner sends ONE message: M4 (single) or M5 (numbered list), with at
 * most ONE clarifying question merged in (M7/M9/M10, budgeted). Rejection
 * replies (M15/M17/M18/duplicate) stay immediate and per item.
 *
 * Failure policy: NOTHING here returns a retryable status to Meta. Rejected
 * and rate-limited content acks in chat and lands as 'skipped'; real failures
 * land as 'error' + error_message with a single M18 to the user.
 */

import { after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { checkInboxUploadRateLimit } from '@/lib/rate-limits/inbox'
import { checkAgentRateLimit } from '@/lib/rate-limits/agent'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { computeSHA256 } from '@/lib/core/documents/document-service'
import { createLogger } from '@/lib/logger'
import { uploadAndExtract } from '@/extensions/general/invoice-inbox/lib/upload-and-extract'
import type {
  InboxChannelContext,
  InvoiceExtractionResult,
  WhatsAppConversation,
  WhatsAppMessage,
  WhatsAppPhoneLink,
} from '@/types'
import { sendText, markReadWithTyping, downloadMedia, GraphApiError } from './graph-api'
import { botCopy, TEMPLATE, type TemplateId } from './messages'
import {
  COMPANY_PIN_TTL_MS,
  MAX_QUESTIONS_PER_BURST,
  MAX_QUESTIONS_PER_DAY,
  STAGED_AWAITING_COMPANY,
  appendRecentQuestion,
  bumpBudget,
  claimAck,
  extractRecipient,
  getContext,
  getOrCreateConversation,
  greetingThrottled,
  hasLivePin,
  loadConversation,
  markRecentQuestion,
  questionsAskedToday,
  resolveAnswerTarget,
  resolveRecipient,
  serviceWindowOpen,
  updateConversation,
  type ConversationContext,
  type QueuedQuestion,
  type QuestionType,
} from './conversation'
import {
  askCompanyQuestion,
  drainParkedRows,
  notifyExpiredParkedRows,
  type CompanyChoiceVia,
} from './company-question'
import { evaluateQuestion, QUESTION_PRIORITY } from './questions'
import { interpretChatAnswer } from './interpret-answer'
import { appendQuestionHistory, updateItemContext } from './item-context'

const log = createLogger('whatsapp-inbox/process-inbound')

export { CHAT_ALLOWED_MIME_TYPES } from './chat-mime'
import { CHAT_ALLOWED_MIME_TYPES, normalizeChatMime } from './chat-mime'

/** M17 is sent at most once per this window per sender, not once per file. */
const RATE_LIMIT_NOTICE_WINDOW_MS = 10 * 60 * 1000

/** Upper bound on how long a burst invocation waits for its own deadline. */
const MAX_DEBOUNCE_WAIT_MS = 15 * 1000

/** Rows one combined ack covers at most (defensive bound). */
const MAX_BURST_ROWS = 20

const EXTENSION_FOR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

const STATE_FOR_QUESTION: Record<QuestionType, WhatsAppConversation['state']> = {
  representation: 'awaiting_representation',
  context: 'awaiting_context',
  resend: 'awaiting_resend',
}

const sleepFn = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function fallbackFilename(mime: string): string {
  const ext = EXTENSION_FOR_MIME[mime] ?? 'bin'
  return `whatsapp-${new Date().toISOString().slice(0, 10)}.${ext}`
}

/**
 * Amount as the ack states it. The extraction pipeline preserves the document
 * currency ("Do NOT default to SEK"), so printing every total with 'kr' turned
 * a EUR 250 hotel receipt into "250 kr" on the one surface that tells the user
 * their receipt was filed correctly.
 */
function formatAmount(amount: number, currency: string | null | undefined): string {
  const formatted = new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount)
  const code = (currency ?? '').trim().toUpperCase()
  return code === '' || code === 'SEK' ? `${formatted} kr` : `${formatted} ${code}`
}

async function loadRow(
  supabase: SupabaseClient,
  messageId: string,
): Promise<WhatsAppMessage | null> {
  const { data } = await supabase
    .from('whatsapp_messages')
    .select('*')
    .eq('id', messageId)
    .maybeSingle()
  return (data as WhatsAppMessage | null) ?? null
}

async function loadLink(
  supabase: SupabaseClient,
  phoneLinkId: string,
): Promise<WhatsAppPhoneLink | null> {
  const { data } = await supabase
    .from('whatsapp_phone_links')
    .select('*')
    .eq('id', phoneLinkId)
    .maybeSingle()
  return (data as WhatsAppPhoneLink | null) ?? null
}

/** Live membership: a pin or default pointing at an ARCHIVED company must not
 *  receive receipts (same filter shape as lib/supabase/middleware.ts). */
async function isMember(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('company_members')
    .select('company_id, companies!inner(archived_at)')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .is('companies.archived_at', null)
    .limit(1)
    .maybeSingle()
  return data != null
}

/** True when an M17 notice already went to this sender inside the window. */
async function rateLimitNoticeAlreadySent(
  supabase: SupabaseClient,
  senderPhoneHash: string,
): Promise<boolean> {
  const since = new Date(Date.now() - RATE_LIMIT_NOTICE_WINDOW_MS).toISOString()
  const { data } = await supabase
    .from('whatsapp_messages')
    .select('id')
    .eq('direction', 'outbound')
    .eq('sender_phone_hash', senderPhoneHash)
    // Both m17 variants (minute + day scope) share the window.
    .like('raw_payload->>template', `${TEMPLATE.m17RateLimited}%`)
    .gte('created_at', since)
    .limit(1)
    .maybeSingle()
  return data != null
}

/**
 * Terminal status write. Guarded on processing_status='processing': the row is
 * only ours while we hold the claim, and an unguarded write let a late loser
 * (a sweep re-claim that raced a live worker) overwrite the winner's 'done'
 * and null its inbox_item_id, which silently loses the burst ack and breaks
 * quoted-reply resolution.
 */
async function markStatus(
  supabase: SupabaseClient,
  messageId: string,
  status: 'skipped' | 'error' | 'done',
  extra: { errorMessage?: string | null; inboxItemId?: string | null } = {},
): Promise<void> {
  // Literal payload (no spread) so the phantom-column scanner can verify it.
  await supabase
    .from('whatsapp_messages')
    .update({
      processing_status: status,
      error_message: extra.errorMessage ?? null,
      inbox_item_id: extra.inboxItemId ?? null,
    })
    .eq('id', messageId)
    .eq('processing_status', 'processing')
}

/** The Underlag item this chat message already produced, if any. The partial
 *  unique index invoice_inbox_items_whatsapp_msg makes this the item-level
 *  idempotency key for a re-processed row. */
async function existingInboxItemId(
  supabase: SupabaseClient,
  whatsappMessageId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('invoice_inbox_items')
    .select('id')
    .eq('whatsapp_message_id', whatsappMessageId)
    .limit(1)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

/** True when an M18 failure notice already went out for this message. */
async function errorNoticeAlreadySent(
  supabase: SupabaseClient,
  correlationId: string | null,
): Promise<boolean> {
  if (!correlationId) return false
  const { data } = await supabase
    .from('whatsapp_messages')
    .select('id')
    .eq('direction', 'outbound')
    .eq('correlation_id', correlationId)
    .eq('raw_payload->>template', TEMPLATE.m18Error)
    .limit(1)
    .maybeSingle()
  return data != null
}

/**
 * Tell the sender their file failed, at most once per message. Gating this on
 * `attempt <= 1` made it unreachable for exactly the failure the sweep exists
 * for: a first attempt that dies with the instance already counted its
 * attempt, so every re-claim suppressed the notice and the row ended in
 * 'error' with the sender never hearing about that receipt at all.
 */
export async function sendErrorNoticeOnce(
  supabase: SupabaseClient,
  args: {
    to: string
    senderPhoneHash: string | null
    phoneLinkId: string | null
    conversationId: string | null
    correlationId: string | null
  },
): Promise<void> {
  if (await errorNoticeAlreadySent(supabase, args.correlationId)) return
  await sendText(supabase, {
    to: args.to,
    body: botCopy('sv').m18Error(),
    template: TEMPLATE.m18Error,
    senderPhoneHash: args.senderPhoneHash,
    phoneLinkId: args.phoneLinkId,
    conversationId: args.conversationId,
    correlationId: args.correlationId,
  })
}

// ── Company resolution (PR4 ladder) ──────────────────────────

interface ResolvedCompany {
  companyId: string
  via: NonNullable<InboxChannelContext['company_selected_via']>
}

/**
 * True when a company question is still open on the conversation, in any of
 * the shapes it survives in: the awaiting_company state, the options behind a
 * digit answer (kept past the 48h TTL for a late reply), or the company
 * pending_question. Once the sender resolves as 'single' none of them can be
 * answered any more.
 */
function hasDeadCompanyQuestion(conversation: WhatsAppConversation): boolean {
  const context = getContext(conversation)
  return (
    conversation.state === 'awaiting_company' ||
    (context.company_options?.length ?? 0) > 0 ||
    context.pending_question?.type === 'company'
  )
}

/**
 * Conversation pin (live + still a member, sliding 8h) -> default company
 * (still a member) -> sole membership -> null (ask).
 *
 * Every membership here means a NON-ARCHIVED company: an archived one is not
 * a place receipts can go, and counting it made a sender with one live
 * company look multi-company (#1589), so they were asked a question Meta
 * refused to deliver.
 *
 * Returns 'transient_error' when the membership query FAILED: a DB blip must
 * not read as "no memberships", which used to park the rows behind an
 * unanswerable company question forever. The caller releases the row so the
 * sweep retries it.
 */
async function resolveCompanyTarget(
  supabase: SupabaseClient,
  link: WhatsAppPhoneLink,
  conversation: WhatsAppConversation | null,
  selectedViaOverride: CompanyChoiceVia | undefined,
): Promise<ResolvedCompany | null | 'transient_error'> {
  const now = new Date()

  if (conversation && hasLivePin(conversation, now) && conversation.company_id) {
    if (await isMember(supabase, link.user_id, conversation.company_id)) {
      // Sliding TTL, refreshed at most once a minute. The write is guarded
      // (updateConversation): a blind whole-context replacement here would
      // wipe a pending_question the ack winner wrote in between, and the
      // sweep would then reset the state a minute later.
      const context = getContext(conversation)
      const expiresAt = context.pin_expires_at ? new Date(context.pin_expires_at).getTime() : 0
      if (expiresAt - now.getTime() < COMPANY_PIN_TTL_MS - 60 * 1000) {
        await updateConversation(supabase, conversation, (_current, currentContext) => ({
          context: {
            ...currentContext,
            pin_expires_at: new Date(now.getTime() + COMPANY_PIN_TTL_MS).toISOString(),
          },
        }))
      }
      return { companyId: conversation.company_id, via: selectedViaOverride ?? 'pin' }
    }
  }

  if (link.default_company_id && (await isMember(supabase, link.user_id, link.default_company_id))) {
    return { companyId: link.default_company_id, via: 'default' }
  }

  const { data: memberships, error: membershipsError } = await supabase
    .from('company_members')
    .select('company_id, companies!inner(archived_at)')
    .eq('user_id', link.user_id)
    .is('companies.archived_at', null)
  if (membershipsError) {
    log.warn('membership query failed during company resolution; will retry', {
      error: membershipsError.message,
    })
    return 'transient_error'
  }
  const companyIds = [...new Set((memberships ?? []).map((m) => m.company_id as string))]
  if (companyIds.length === 1) return { companyId: companyIds[0], via: 'single' }
  return null
}

// ── Outcomes ─────────────────────────────────────────────────

export type ProcessOutcome =
  | { kind: 'media_processed'; conversationId: string | null }
  | { kind: 'media_staged'; conversationId: string | null }
  | { kind: 'answer'; conversationId: string | null }
  | { kind: 'none' }

export interface KickOptions {
  /** Set when re-opening rows parked behind a just-answered company question:
   *  their items record the choice mechanism instead of a generic 'pin'. */
  companySelectedVia?: CompanyChoiceVia
}

/**
 * Process one inbound message end to end (media intake OR text answer).
 * Never throws.
 */
export async function processInboundMessage(
  supabase: SupabaseClient,
  messageId: string,
  opts: KickOptions = {},
): Promise<ProcessOutcome> {
  const row = await loadRow(supabase, messageId)
  if (!row) return { kind: 'none' }

  // Atomic claim: only a row still in 'received' can be taken, so a webhook
  // redelivery racing this worker (or the sweep) claims exactly once.
  const { data: claimed } = await supabase
    .from('whatsapp_messages')
    .update({ processing_status: 'processing', attempts: row.attempts + 1 })
    .eq('id', messageId)
    .eq('processing_status', 'received')
    .select('id')
    .maybeSingle()
  if (!claimed) return { kind: 'none' }

  const attempt = row.attempts + 1
  if (row.message_type === 'text') {
    return processAnswerMessage(supabase, row)
  }
  return processMediaMessage(supabase, row, attempt, opts)
}

// ── Media intake ─────────────────────────────────────────────

async function processMediaMessage(
  supabase: SupabaseClient,
  row: WhatsAppMessage,
  attempt: number,
  opts: KickOptions,
): Promise<ProcessOutcome> {
  const copy = botCopy('sv')

  const replyBase = {
    senderPhoneHash: row.sender_phone_hash,
    phoneLinkId: row.phone_link_id,
    conversationId: row.conversation_id,
    correlationId: row.correlation_id,
  }
  let to: string | null = null

  try {
    if (!row.phone_link_id || !row.media_id) {
      await markStatus(supabase, row.id, 'error', {
        errorMessage: 'Message row is missing link or media reference',
      })
      // Not policy silence (#1552): a linked sender whose row lost its media
      // reference gets the failure owned out loud, when a reply address can
      // still be resolved through the link.
      if (row.phone_link_id) {
        const link = await loadLink(supabase, row.phone_link_id)
        const fallbackTo = link && !link.revoked_at ? resolveRecipient(row, link) : null
        if (fallbackTo) {
          await sendErrorNoticeOnce(supabase, { to: fallbackTo, ...replyBase })
        }
      }
      return { kind: 'none' }
    }

    if (row.wamid) await markReadWithTyping(row.wamid)

    const link = await loadLink(supabase, row.phone_link_id)
    if (!link || link.revoked_at) {
      await markStatus(supabase, row.id, 'skipped', {
        errorMessage: 'Phone link revoked before processing',
      })
      // Revoked between arrival and processing is a failure to own, not
      // policy silence (#1552). The number is unlinked NOW, so the accurate
      // reply is the M1 "not linked" copy, throttled exactly like the
      // unknown-sender greeting so a revoked-mid-burst sender gets one.
      const fallbackTo = link ? resolveRecipient(row, link) : extractRecipient(row)
      if (
        fallbackTo &&
        row.sender_phone_hash &&
        !(await greetingThrottled(supabase, row.sender_phone_hash))
      ) {
        await sendText(supabase, {
          to: fallbackTo,
          body: copy.m1Unlinked(),
          template: TEMPLATE.m1Unlinked,
          ...replyBase,
        })
      }
      return { kind: 'none' }
    }
    to = resolveRecipient(row, link)
    if (!to) {
      await markStatus(supabase, row.id, 'error', {
        errorMessage: 'No reply address for message row',
      })
      return { kind: 'none' }
    }

    const conversation = row.conversation_id
      ? await loadConversation(supabase, row.conversation_id)
      : await getOrCreateConversation(supabase, link.id)

    // ── MIME allowlist (before staging: never park junk) ───
    const mime = normalizeChatMime(row.media_mime)
    if (!CHAT_ALLOWED_MIME_TYPES.has(mime)) {
      await sendText(supabase, { to, body: copy.m15Unsupported(), template: TEMPLATE.m15Unsupported, ...replyBase })
      await markStatus(supabase, row.id, 'skipped', {
        errorMessage: `Unsupported media type: ${mime || 'unknown'}`,
      })
      return { kind: 'media_processed', conversationId: conversation?.id ?? null }
    }

    // ── Company resolution ─────────────────────────────────
    const resolved = await resolveCompanyTarget(supabase, link, conversation, opts.companySelectedVia)
    if (resolved === 'transient_error') {
      // Release the claim untouched: the sweep re-runs this row within a
      // minute and gives up through the normal MAX_ATTEMPTS -> M18 path if
      // the failure persists. Parking it as skipped would be permanent.
      await supabase
        .from('whatsapp_messages')
        .update({ processing_status: 'received' })
        .eq('id', row.id)
        .eq('processing_status', 'processing')
      return { kind: 'none' }
    }
    if (!resolved) {
      if (!conversation) {
        await markStatus(supabase, row.id, 'error', {
          errorMessage: 'No conversation available for company question',
        })
        return { kind: 'none' }
      }
      // Park the row (the row itself is the staged media ref: media stays
      // re-downloadable from Meta for days) and ask the company question
      // exactly once per episode.
      await markStatus(supabase, row.id, 'skipped', { errorMessage: STAGED_AWAITING_COMPANY })
      const { count } = await supabase
        .from('whatsapp_messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conversation.id)
        .eq('processing_status', 'skipped')
        .eq('error_message', STAGED_AWAITING_COMPANY)
      const askOutcome = await askCompanyQuestion(supabase, {
        conversation,
        link,
        to,
        replyBase,
        stagedCount: count ?? 1,
      })
      if (askOutcome === 'transient_error') {
        // The options could not even be loaded: un-park this row so the
        // sweep retries it, instead of leaving it staged behind a question
        // that was never asked (and might never be).
        await supabase
          .from('whatsapp_messages')
          .update({ processing_status: 'received', error_message: null })
          .eq('id', row.id)
          .eq('processing_status', 'skipped')
          .eq('error_message', STAGED_AWAITING_COMPANY)
        return { kind: 'none' }
      }
      return { kind: 'media_staged', conversationId: conversation.id }
    }
    const companyId = resolved.companyId

    if (resolved.via === 'single' && conversation) {
      // Receipts parked behind an earlier company question can never be
      // answered now: the sender's other memberships are archived (or gone),
      // so that question will not be asked again, and the sole live company
      // is unambiguous by construction. Re-open them so they file here
      // instead of expiring at Meta. Same drain as applyCompanyChoice (one
      // definition, including the media-age cutoff); the re-run resolves
      // them as 'single' on its own. default/pin resolution deliberately
      // does not drain: those choices the user can still change, so the
      // open question there is not dead.
      const drained = await drainParkedRows(supabase, conversation.id)
      if (drained.reopenedIds.length > 0) {
        log.info('re-opened receipts parked behind an unaskable company question', {
          conversationId: conversation.id,
          count: drained.reopenedIds.length,
        })
        kickInboundProcessing(drained.reopenedIds)
      }
      if (drained.failed) {
        // Not a reason to keep the dead question: clearing it below is what
        // turns the still-parked rows into orphans the sweep re-opens, and
        // this path drains again on the sender's next receipt anyway.
        log.error('single-company drain failed; rows stay parked for the sweep', null, {
          conversationId: conversation.id,
        })
      }
      await notifyExpiredParkedRows(supabase, { to, replyBase, expiredCount: drained.expiredCount })
      // The question itself is as dead as the rows behind it. Left in place,
      // state 'awaiting_company' turns every typed word into a company_retry
      // that re-offers the archived company, swallows 'byt', and keeps
      // finalizeBurst from asking anything about the drained receipts until
      // the 48h TTL sweep. Guarded and re-checked against fresh state, so a
      // concurrent worker that already cleared it is a no-op, and only the
      // company question is touched: a representation/context question that
      // opened in between stays.
      if (hasDeadCompanyQuestion(conversation)) {
        await updateConversation(supabase, conversation, (current, currentContext) => {
          if (!hasDeadCompanyQuestion(current)) return null
          const nextContext: ConversationContext = { ...currentContext }
          delete nextContext.company_options
          if (nextContext.pending_question?.type === 'company') delete nextContext.pending_question
          return {
            state: current.state === 'awaiting_company' ? 'idle' : current.state,
            context: nextContext,
          }
        })
        log.info('cleared the dead company question on a single-company conversation', {
          conversationId: conversation.id,
        })
      }
    }

    // ── Per-company intake quota (ack-and-drop, never retryable) ──
    const limit = await checkInboxUploadRateLimit(supabase, companyId)
    if (!limit.ok) {
      try {
        await appendProcessingHistory({
          companyId,
          correlationId: row.correlation_id ?? row.id,
          aggregateType: 'System',
          aggregateId: row.id,
          eventType: 'RateLimitedDropped',
          payload: {
            channel: 'whatsapp',
            scope: limit.scope,
            retry_after_sec: limit.retryAfterSec,
            whatsapp_message_id: row.id,
          },
          actor: { type: 'system', id: 'whatsapp-inbound' },
          occurredAt: new Date(),
        })
      } catch (err) {
        log.error('RateLimitedDropped append failed', err)
      }
      if (row.sender_phone_hash && !(await rateLimitNoticeAlreadySent(supabase, row.sender_phone_hash))) {
        // The daily company quota resets at Stockholm midnight, so the
        // template's 10-minute default is simply false there.
        const dayScope = limit.scope === 'day'
        await sendText(supabase, {
          to,
          body: dayScope
            ? copy.m17RateLimitedDay()
            : copy.m17RateLimited({ minutes: Math.max(1, Math.ceil((limit.retryAfterSec ?? 600) / 60)) }),
          template: dayScope ? TEMPLATE.m17RateLimitedDay : TEMPLATE.m17RateLimited,
          ...replyBase,
        })
      }
      await markStatus(supabase, row.id, 'skipped', { errorMessage: 'Rate limited' })
      return { kind: 'media_processed', conversationId: conversation?.id ?? null }
    }

    // ── Already ingested? (idempotency at the item level) ──
    // A sweep re-claim that raced a live worker must adopt the item the
    // winner created, not create a second one: the WORM document is written
    // before the item insert and can never be deleted (7-year retention),
    // and the unique index would make the second insert throw.
    const alreadyIngested = await existingInboxItemId(supabase, row.id)
    if (alreadyIngested) {
      await markStatus(supabase, row.id, 'done', { inboxItemId: alreadyIngested })
      return { kind: 'media_processed', conversationId: conversation?.id ?? null }
    }

    // ── Download (fresh URL per media id; 10 MB stream-checked cap) ──
    const media = await downloadMedia(row.media_id)

    // ── Exact duplicate check within the company ───────────
    const sha256 = await computeSHA256(media.buffer)
    const { data: duplicate } = await supabase
      .from('document_attachments')
      .select('id')
      .eq('company_id', companyId)
      .eq('sha256_hash', sha256)
      .limit(1)
      .maybeSingle()
    if (duplicate) {
      await sendText(supabase, { to, body: copy.m4Duplicate(), template: TEMPLATE.m4Duplicate, ...replyBase })
      await markStatus(supabase, row.id, 'skipped', { errorMessage: 'Duplicate document (sha256)' })
      return { kind: 'media_processed', conversationId: conversation?.id ?? null }
    }

    // ── Upload + extract (the shared invoice-inbox funnel) ──
    let inboxItemId: string
    try {
      const result = await uploadAndExtract(
        supabase,
        link.user_id,
        companyId,
        { name: row.media_filename || fallbackFilename(mime), buffer: media.buffer, type: mime },
        'whatsapp',
        undefined,
        undefined,
        {
          channelMeta: { whatsappMessageId: row.id, caption: row.body_text ?? null },
          actorId: 'whatsapp-inbound',
        },
      )
      inboxItemId = result.inbox_item_id
    } catch (uploadErr) {
      // invoice_inbox_items_whatsapp_msg is a unique index: a concurrent
      // worker that got there first is a success, not a failure.
      const adopted = await existingInboxItemId(supabase, row.id)
      if (!adopted) throw uploadErr
      await markStatus(supabase, row.id, 'done', { inboxItemId: adopted })
      return { kind: 'media_processed', conversationId: conversation?.id ?? null }
    }

    // Record how the company was chosen (audit + FieldsRail in PR5).
    await updateItemContext(supabase, inboxItemId, (context) => ({
      ...context,
      company_selected_via: resolved.via,
    }))

    // A new file while a re-send question is open resolves that question:
    // the fresh item supersedes the unreadable one (WORM + anchored-doc
    // invariant forbid swapping the old item's document).
    if (
      conversation?.state === 'awaiting_resend' &&
      getContext(conversation).pending_question?.type === 'resend'
    ) {
      await resolveResendQuestion(supabase, conversation)
    }

    await markStatus(supabase, row.id, 'done', { inboxItemId })
    // No ack here: the burst winner sends ONE combined M4/M5 (+ question).
    return { kind: 'media_processed', conversationId: conversation?.id ?? null }
  } catch (err) {
    const message =
      err instanceof GraphApiError || err instanceof Error ? err.message : String(err)
    log.error('WhatsApp intake processing failed', err, { messageId: row.id, attempt })
    try {
      await markStatus(supabase, row.id, 'error', { errorMessage: message.slice(0, 500) })
      // M18 at most once per message, tracked by the outbound row rather than
      // the attempt counter (a first attempt that died still burned its).
      if (to) {
        await sendErrorNoticeOnce(supabase, { to, ...replyBase })
      }
    } catch (innerErr) {
      log.error('Failed to record WhatsApp processing error', innerErr, { messageId: row.id })
    }
    return { kind: 'media_processed', conversationId: row.conversation_id }
  }
}

/** Mark the awaiting_resend question answered: old item superseded. */
async function resolveResendQuestion(
  supabase: SupabaseClient,
  conversation: WhatsAppConversation,
): Promise<void> {
  const context = getContext(conversation)
  const pending = context.pending_question
  if (!pending || pending.type !== 'resend' || !pending.inbox_item_id) return
  const oldItemId = pending.inbox_item_id

  await updateItemContext(supabase, oldItemId, (itemContext) => ({
    ...itemContext,
    quality: {
      resend_requested_at: itemContext.quality?.resend_requested_at ?? pending.asked_at,
      resent: true,
      superseded: true,
    },
    pending_question: itemContext.pending_question
      ? { ...itemContext.pending_question, status: 'answered' }
      : { type: 'resend', asked_at: pending.asked_at, status: 'answered' },
  }))

  await updateConversation(supabase, conversation, (_current, currentContext) => {
    const nextContext: ConversationContext = {
      ...currentContext,
      recent_questions: markRecentQuestion(currentContext, oldItemId, 'answered'),
    }
    delete nextContext.pending_question
    return { state: 'idle', context: nextContext }
  })
  await appendQuestionHistory(supabase, {
    inboxItemId: oldItemId,
    eventType: 'ChannelQuestionAnswered',
    questionType: 'resend',
  })
}

// ── Burst finalize: ONE combined ack + at most one question ──

interface BurstEntry {
  row: WhatsAppMessage
  itemId: string
  companyId: string | null
  extracted: InvoiceExtractionResult | null
  channelContext: InboxChannelContext | null
  fileSizeBytes: number | null
  ordinal: number
}

function ackLine(entry: BurstEntry): string {
  const merchant =
    entry.extracted?.supplier?.name ?? entry.row.media_filename ?? 'Kvitto'
  const total = entry.extracted?.totals?.total ?? null
  const currency = entry.extracted?.invoice?.currency ?? null
  return `${merchant}, ${total != null ? formatAmount(total, currency) : 'belopp saknas'}`
}

/**
 * Claim and send the combined ack for everything processed in the burst.
 * Safe to call speculatively: losers of the pending_ack claim (or claims
 * that find nothing to ack) do nothing.
 */
export async function finalizeBurst(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<void> {
  try {
    if (!(await claimAck(supabase, conversationId))) return
    const conversation = await loadConversation(supabase, conversationId)
    if (!conversation) return

    const { data: rowsData } = await supabase
      .from('whatsapp_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .eq('direction', 'inbound')
      .eq('processing_status', 'done')
      .is('acked_at', null)
      .not('inbox_item_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(MAX_BURST_ROWS)
    const rows = (rowsData ?? []) as WhatsAppMessage[]
    if (rows.length === 0) return

    const now = new Date()
    const nowIso = now.toISOString()
    const rowIds = rows.map((r) => r.id)

    // Legacy rows still carry the sender number; redacted ones do not, and
    // then the reply address comes from the link's encrypted copy.
    let to = rows.map(extractRecipient).find((value) => value != null) ?? null
    if (!to) {
      const link = await loadLink(supabase, conversation.phone_link_id)
      to = rows.map((r) => resolveRecipient(r, link)).find((value) => value != null) ?? null
    }
    // Never initiate outside the 24h service window (no templates in v1):
    // if the window closed, hand off silently and mark the rows covered.
    if (!to || !serviceWindowOpen(conversation, now)) {
      await supabase.from('whatsapp_messages').update({ acked_at: nowIso }).in('id', rowIds)
      return
    }

    // ── Load items + document sizes ────────────────────────
    const itemIds = rows.map((r) => r.inbox_item_id as string)
    const { data: itemsData } = await supabase
      .from('invoice_inbox_items')
      .select('id, company_id, extracted_data, channel_context, document_id')
      .in('id', itemIds)
    const itemsById = new Map(
      ((itemsData ?? []) as Array<{
        id: string
        company_id: string
        extracted_data: Record<string, unknown> | null
        channel_context: InboxChannelContext | null
        document_id: string | null
      }>).map((item) => [item.id, item]),
    )
    const documentIds = [...itemsById.values()]
      .map((item) => item.document_id)
      .filter((id): id is string => id != null)
    const sizesByDocId = new Map<string, number>()
    if (documentIds.length > 0) {
      const { data: docsData } = await supabase
        .from('document_attachments')
        .select('id, file_size_bytes')
        .in('id', documentIds)
      for (const doc of (docsData ?? []) as Array<{ id: string; file_size_bytes: number | null }>) {
        if (doc.file_size_bytes != null) sizesByDocId.set(doc.id, doc.file_size_bytes)
      }
    }

    const entries: BurstEntry[] = rows.map((row, index) => {
      const item = itemsById.get(row.inbox_item_id as string)
      return {
        row,
        itemId: row.inbox_item_id as string,
        companyId: item?.company_id ?? null,
        extracted: (item?.extracted_data as InvoiceExtractionResult | null) ?? null,
        channelContext: item?.channel_context ?? null,
        fileSizeBytes: item?.document_id ? (sizesByDocId.get(item.document_id) ?? null) : null,
        ordinal: index + 1,
      }
    })

    // ── Question selection (budgeted, one in flight) ───────
    const context = getContext(conversation)
    const stateIdle = conversation.state === 'idle'
    const askedToday = questionsAskedToday(context, now)
    const queue: QueuedQuestion[] = [...(context.question_queue ?? [])]

    const candidates = entries
      .map((entry) => ({
        entry,
        candidate: evaluateQuestion({
          extracted: entry.extracted,
          caption: entry.channelContext?.caption ?? entry.row.body_text,
          mime: entry.row.media_mime,
          filename: entry.row.media_filename,
          fileSizeBytes: entry.fileSizeBytes,
        }),
      }))
      // A question is asked exactly once: an item that already carries one
      // (from a crashed earlier finalize) is never re-considered.
      .filter((c) => c.candidate != null && c.entry.channelContext?.pending_question == null)
      .sort(
        (a, b) =>
          QUESTION_PRIORITY[a.candidate!.type] - QUESTION_PRIORITY[b.candidate!.type] ||
          a.entry.ordinal - b.entry.ordinal,
      )

    let toAsk: { type: QuestionType; entry: BurstEntry } | null = null
    const movedToApp: { type: QuestionType; entry: BurstEntry }[] = []
    let burstAdmitted = 0
    for (const { entry, candidate } of candidates) {
      const type = candidate!.type
      if (askedToday >= MAX_QUESTIONS_PER_DAY) {
        movedToApp.push({ type, entry })
        continue
      }
      if (!toAsk && stateIdle && burstAdmitted < MAX_QUESTIONS_PER_BURST) {
        toAsk = { type, entry }
        burstAdmitted++
        continue
      }
      if (burstAdmitted < MAX_QUESTIONS_PER_BURST && queue.length < MAX_QUESTIONS_PER_BURST) {
        queue.push({ type, inbox_item_id: entry.itemId })
        burstAdmitted++
        continue
      }
      movedToApp.push({ type, entry })
    }

    // ── Compose the ONE outbound message ───────────────────
    const copy = botCopy('sv')
    let body: string
    let template: TemplateId
    let ackItemId: string | null = null

    if (entries.length === 1) {
      const entry = entries[0]
      ackItemId = entry.itemId
      const total = entry.extracted?.totals?.total ?? null
      if (toAsk?.type === 'resend') {
        body = copy.m9Resend({})
        template = TEMPLATE.m9Resend
      } else if (toAsk?.type === 'context') {
        body = copy.m10Context({})
        template = TEMPLATE.m10Context
      } else {
        body =
          total != null
            ? copy.m4Ack({
                merchant: entry.extracted?.supplier?.name ?? null,
                amount: formatAmount(total, entry.extracted?.invoice?.currency ?? null),
                date: entry.extracted?.invoice?.invoiceDate ?? null,
              })
            : copy.m4AckEmpty()
        template = total != null ? TEMPLATE.m4Ack : TEMPLATE.m4AckEmpty
        if (toAsk?.type === 'representation') {
          body += `\n\n${copy.m7Representation({})}`
          template = TEMPLATE.m7Representation
        }
      }
    } else {
      body = copy.m5BurstAck({ lines: entries.map(ackLine) })
      template = TEMPLATE.m5BurstAck
      if (toAsk) {
        const ordinal = toAsk.entry.ordinal
        if (toAsk.type === 'representation') {
          body += `\n\n${copy.m7Representation({ ref: `Kvitto ${ordinal} ser ut som representation.` })}`
          template = TEMPLATE.m7Representation
        } else if (toAsk.type === 'resend') {
          body += `\n\n${copy.m9Resend({ ordinal })}`
          template = TEMPLATE.m9Resend
        } else {
          body += `\n\n${copy.m10Context({ ordinal })}`
          template = TEMPLATE.m10Context
        }
        ackItemId = toAsk.entry.itemId
      }
    }

    // ── Persist state BEFORE sending (a fast answer must find it) ──
    // Guarded write: this runs seconds after the reads above, and the answer
    // worker (a different claim entirely) may have settled a question in
    // between. Replacing the whole jsonb blindly resurrected answered
    // questions and dropped queue entries.
    const previousState = conversation.state
    const askedItemId = toAsk?.entry.itemId ?? null
    const committed = await updateConversation(
      supabase,
      conversation,
      (current, currentContext) => {
        const nextContext: ConversationContext = { ...currentContext, question_queue: queue }
        let nextState = current.state
        if (toAsk) {
          nextContext.pending_question = {
            type: toAsk.type,
            inbox_item_id: toAsk.entry.itemId,
            asked_at: nowIso,
          }
          nextContext.recent_questions = appendRecentQuestion(
            currentContext,
            { type: toAsk.type, inbox_item_id: toAsk.entry.itemId, asked_at: nowIso, status: 'open' },
            now,
          )
          nextContext.budget = bumpBudget(currentContext, 1, now)
          nextState = STATE_FOR_QUESTION[toAsk.type]
        }
        return { state: nextState, context: nextContext, last_outbound_at: nowIso }
      },
    )

    if (toAsk) {
      await updateItemContext(supabase, toAsk.entry.itemId, (itemContext) => ({
        ...itemContext,
        pending_question: { type: toAsk!.type, asked_at: nowIso, status: 'open' },
        ...(toAsk!.type === 'resend'
          ? { quality: { ...itemContext.quality, resend_requested_at: nowIso } }
          : {}),
      }))
      await appendQuestionHistory(supabase, {
        inboxItemId: toAsk.entry.itemId,
        eventType: 'ChannelQuestionAsked',
        questionType: toAsk.type,
      })
    }
    for (const moved of movedToApp) {
      await updateItemContext(supabase, moved.entry.itemId, (itemContext) => ({
        ...itemContext,
        pending_question: { type: moved.type, asked_at: nowIso, status: 'moved_to_app' },
      }))
    }

    const last = rows[rows.length - 1]
    const sent = await sendText(supabase, {
      to,
      body,
      template,
      senderPhoneHash: last.sender_phone_hash,
      phoneLinkId: conversation.phone_link_id,
      conversationId,
      correlationId: last.correlation_id,
      inboxItemId: ackItemId,
    })

    if (!sent.ok) {
      // Sends never throw, so an ignored result meant a Graph failure left the
      // user with no ack ever (acked_at blocks the sweep's re-arm) AND the
      // conversation parked on a question they never received, which the next
      // unrelated text would then be interpreted as answering. Undo the
      // question and leave the rows unacked so sweep pass 2b retries.
      if (toAsk && committed && askedItemId) {
        await updateConversation(supabase, committed, (current, currentContext) => {
          if (currentContext.pending_question?.asked_at !== nowIso) return null
          const rolledBack: ConversationContext = { ...currentContext }
          delete rolledBack.pending_question
          rolledBack.recent_questions = (currentContext.recent_questions ?? []).filter(
            (q) => !(q.inbox_item_id === askedItemId && q.asked_at === nowIso),
          )
          rolledBack.budget = bumpBudget(currentContext, -1, now)
          return { state: current.state === STATE_FOR_QUESTION[toAsk.type] ? previousState : current.state, context: rolledBack }
        })
        await updateItemContext(supabase, askedItemId, (itemContext) => {
          if (itemContext.pending_question?.asked_at !== nowIso) return itemContext
          const reverted = { ...itemContext }
          delete reverted.pending_question
          return reverted
        })
      }
      log.warn('combined ack send failed; rows left unacked for the sweep', { conversationId })
      return
    }

    await supabase.from('whatsapp_messages').update({ acked_at: nowIso }).in('id', rowIds)
  } catch (err) {
    log.error('burst finalize failed', err, { conversationId })
  }
}

// ── Answer handling (the only path that may reach the LLM) ───

function renderParticipants(
  participants: { name: string; company: string | null }[],
): string {
  return participants
    .map((p) => (p.company ? `${p.name} (${p.company})` : p.name))
    .join(', ')
}

/** Append a chat line to the item's note, keeping whatever is already there. */
async function appendUserNote(
  supabase: SupabaseClient,
  inboxItemId: string,
  text: string,
): Promise<void> {
  await updateItemContext(supabase, inboxItemId, (itemContext) => ({
    ...itemContext,
    user_note: itemContext.user_note ? `${itemContext.user_note}\n${text}` : text,
  }))
}

async function processAnswerMessage(
  supabase: SupabaseClient,
  row: WhatsAppMessage,
): Promise<ProcessOutcome> {
  const copy = botCopy('sv')
  const replyBase = {
    senderPhoneHash: row.sender_phone_hash,
    phoneLinkId: row.phone_link_id,
    conversationId: row.conversation_id,
    correlationId: row.correlation_id,
  }

  try {
    if (!row.phone_link_id) {
      await markStatus(supabase, row.id, 'error', { errorMessage: 'Answer row is missing link' })
      return { kind: 'none' }
    }
    const link = await loadLink(supabase, row.phone_link_id)
    if (!link || link.revoked_at) {
      await markStatus(supabase, row.id, 'skipped', { errorMessage: 'Phone link revoked' })
      return { kind: 'none' }
    }
    const to = resolveRecipient(row, link)
    if (!to) {
      await markStatus(supabase, row.id, 'error', { errorMessage: 'No reply address for answer row' })
      return { kind: 'none' }
    }
    const conversation = row.conversation_id
      ? await loadConversation(supabase, row.conversation_id)
      : null
    const text = (row.body_text ?? '').trim()
    if (!conversation || !text) {
      await markStatus(supabase, row.id, 'skipped', { errorMessage: 'Nothing to answer' })
      return { kind: 'none' }
    }

    const raw = row.raw_payload as { context?: { id?: unknown } } | null
    const quotedWamid = typeof raw?.context?.id === 'string' ? raw.context.id : null

    // Words cannot answer the re-send question (it needs a sharper file), but
    // they ARE about that receipt. Keep them there and leave the question
    // open, instead of letting the late-answer probe bind them to some other
    // receipt's question and confirm it as that receipt's note.
    const resendPending = getContext(conversation).pending_question
    if (
      conversation.state === 'awaiting_resend' &&
      resendPending?.type === 'resend' &&
      resendPending.inbox_item_id
    ) {
      await appendUserNote(supabase, resendPending.inbox_item_id, text)
      await sendText(supabase, {
        to,
        body: copy.m9NoteSaved(),
        template: TEMPLATE.m9NoteSaved,
        ...replyBase,
        inboxItemId: resendPending.inbox_item_id,
      })
      await markStatus(supabase, row.id, 'done', { inboxItemId: resendPending.inbox_item_id })
      return { kind: 'answer', conversationId: conversation.id }
    }

    const target = await resolveAnswerTarget(supabase, conversation, quotedWamid)
    if (!target) {
      // The question disappeared between webhook routing and processing
      // (TTL sweep or a concurrent answer): plain fallback. NOT on a
      // re-claim though: a worker that died after applying the answer and
      // sending its confirm leaves the row 'processing', and the retry would
      // then follow that confirm with "I did not understand".
      if (row.attempts === 0) {
        await sendText(supabase, { to, body: copy.m16Fallback(), template: TEMPLATE.m16Fallback, ...replyBase })
      }
      await markStatus(supabase, row.id, 'done')
      return { kind: 'answer', conversationId: conversation.id }
    }

    if (target.followUp) {
      // The user quoted a receipt whose question is already settled: this is
      // an addition ('glömde: Bo Ek var också med'), so it is appended to
      // that receipt instead of overwriting its confirmed answer.
      await appendUserNote(supabase, target.inboxItemId, text)
      await sendText(supabase, {
        to,
        body: copy.m10ContextConfirm(),
        template: TEMPLATE.m10ContextConfirm,
        ...replyBase,
        inboxItemId: target.inboxItemId,
      })
      await markStatus(supabase, row.id, 'done', { inboxItemId: target.inboxItemId })
      return { kind: 'answer', conversationId: conversation.id }
    }

    const nowIso = new Date().toISOString()
    let confirmBody: string
    let confirmTemplate: TemplateId
    /** Set when the answer named participants but no purpose: the question
     *  stays open for exactly one targeted follow-up. */
    let keepOpenForPurpose = false

    if (target.type === 'representation' && text.toLowerCase() === 'nej') {
      // Exact 'nej' short-circuits WITHOUT an LLM call.
      await updateItemContext(supabase, target.inboxItemId, (itemContext) => ({
        ...itemContext,
        representation: {
          participants: [],
          purpose: null,
          event_date: null,
          raw_answer: text,
          answered_at: nowIso,
          denied: true,
        },
        pending_question: itemContext.pending_question
          ? { ...itemContext.pending_question, status: 'answered' }
          : undefined,
      }))
      confirmBody = copy.m8RepDenied()
      confirmTemplate = TEMPLATE.m8RepDenied
    } else {
      // Rate-limit gate, then the ONE LLM call. Any failure (gate, API,
      // parse, validation) degrades to storing the raw text: never a retry
      // loop, never a user-visible error.
      let interpretation: Awaited<ReturnType<typeof interpretChatAnswer>> = { ok: false }
      const rate = await checkAgentRateLimit(supabase, link.user_id)
      if (rate.ok) {
        interpretation = await interpretChatAnswer({ text, questionType: target.type })
      }

      if (target.type === 'representation') {
        if (interpretation.ok && interpretation.data.is_denial) {
          await updateItemContext(supabase, target.inboxItemId, (itemContext) => ({
            ...itemContext,
            representation: {
              participants: [],
              purpose: null,
              event_date: null,
              raw_answer: text,
              answered_at: nowIso,
              denied: true,
            },
            pending_question: itemContext.pending_question
              ? { ...itemContext.pending_question, status: 'answered' }
              : undefined,
          }))
          confirmBody = copy.m8RepDenied()
          confirmTemplate = TEMPLATE.m8RepDenied
        } else if (
          interpretation.ok &&
          ((interpretation.data.participants?.length ?? 0) > 0 || interpretation.data.purpose)
        ) {
          const data = interpretation.data
          await updateItemContext(supabase, target.inboxItemId, (itemContext) => {
            // Skatteverket wants participants AND purpose; an answer with
            // only the names used to be accepted silently, leaving the
            // deduction undocumented. Ask once more for the missing half,
            // and only once: if a previous answer already wrote a
            // representation block, take whatever we have and stop.
            const isFirstAnswer = itemContext.representation == null
            keepOpenForPurpose =
              isFirstAnswer && (data.participants?.length ?? 0) > 0 && !data.purpose
            return {
              ...itemContext,
              representation: {
                participants: data.participants ?? [],
                // A follow-up must not erase a purpose captured earlier.
                purpose: data.purpose ?? itemContext.representation?.purpose ?? null,
                event_date: data.event_date ?? itemContext.representation?.event_date ?? null,
                raw_answer: itemContext.representation
                  ? `${itemContext.representation.raw_answer}\n${text}`
                  : text,
                answered_at: nowIso,
              },
              ...(data.note ? { user_note: data.note } : {}),
              pending_question: itemContext.pending_question
                ? {
                    ...itemContext.pending_question,
                    status: keepOpenForPurpose ? 'open' : 'answered',
                  }
                : undefined,
            }
          })
          if (keepOpenForPurpose) {
            confirmBody = copy.m8RepNeedPurpose({
              participants: renderParticipants(data.participants ?? []),
            })
            confirmTemplate = TEMPLATE.m8RepNeedPurpose
          } else {
            confirmBody = copy.m8RepConfirmed({
              participants: renderParticipants(data.participants ?? []),
              purpose: data.purpose ?? null,
            })
            confirmTemplate = TEMPLATE.m8RepConfirmed
          }
        } else {
          await updateItemContext(supabase, target.inboxItemId, (itemContext) => ({
            ...itemContext,
            user_note: text,
            representation: {
              participants: [],
              purpose: null,
              event_date: null,
              raw_answer: text,
              answered_at: nowIso,
            },
            pending_question: itemContext.pending_question
              ? { ...itemContext.pending_question, status: 'answered' }
              : undefined,
          }))
          confirmBody = copy.m8RepPartial()
          confirmTemplate = TEMPLATE.m8RepPartial
        }
      } else {
        const note =
          interpretation.ok && interpretation.data.note ? interpretation.data.note : text
        await updateItemContext(supabase, target.inboxItemId, (itemContext) => ({
          ...itemContext,
          user_note: note,
          // The note is an LLM paraphrase; keep what the human actually
          // wrote (and when) next to it, the way the representation branch
          // does. Without this the only copy of the raw wording is
          // whatsapp_messages.body_text, which the retention cron purges.
          context_answer: { raw_answer: text, answered_at: nowIso },
          pending_question: itemContext.pending_question
            ? { ...itemContext.pending_question, status: 'answered' }
            : undefined,
        }))
        confirmBody = copy.m10ContextConfirm()
        confirmTemplate = TEMPLATE.m10ContextConfirm
      }
    }

    // Conversation bookkeeping: settle the question, then surface the next
    // queued one (if any and the budget allows). Guarded: the LLM call above
    // takes seconds, and a burst finalize or a second answer fragment may
    // have written the row in between (a blind write resurrected the
    // question or dropped the queue).
    let nextState = conversation.state
    await updateConversation(supabase, conversation, (current, currentContext) => {
      const patchContext: ConversationContext = {
        ...currentContext,
        recent_questions: markRecentQuestion(currentContext, target.inboxItemId, 'answered'),
      }
      nextState = current.state
      if (
        !target.late &&
        !keepOpenForPurpose &&
        currentContext.pending_question?.inbox_item_id === target.inboxItemId
      ) {
        delete patchContext.pending_question
        nextState = 'idle'
      }
      // keepOpenForPurpose: leave the pending question and the awaiting
      // state in place so the next free-text reply routes back to this same
      // receipt instead of drawing the M16 fallback.
      return { state: nextState, context: patchContext }
    })

    await appendQuestionHistory(supabase, {
      inboxItemId: target.inboxItemId,
      eventType: 'ChannelQuestionAnswered',
      questionType: target.type,
      correlationId: row.correlation_id,
    })

    await sendText(supabase, {
      to,
      body: confirmBody,
      template: confirmTemplate,
      ...replyBase,
      inboxItemId: target.inboxItemId,
    })

    if (nextState === 'idle') {
      await askNextQueuedQuestion(supabase, conversation.id, to, replyBase)
    }

    await markStatus(supabase, row.id, 'done', { inboxItemId: target.inboxItemId })
    return { kind: 'answer', conversationId: conversation.id }
  } catch (err) {
    // No M18 here: that copy is about files. This catch is a programming
    // -error net, not a retry hook: every dependency on the answer path
    // degrades instead of throwing (interpretChatAnswer returns {ok:false},
    // sends never throw, supabase-js returns errors), and 'error' is
    // terminal for the sweep, which claims only 'received'/'processing'.
    log.error('WhatsApp answer processing failed', err, { messageId: row.id })
    try {
      await markStatus(supabase, row.id, 'error', {
        errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      })
    } catch (innerErr) {
      log.error('Failed to record WhatsApp answer error', innerErr, { messageId: row.id })
    }
    return { kind: 'none' }
  }
}

/** Ask the next queued question, if any survives the daily budget. */
async function askNextQueuedQuestion(
  supabase: SupabaseClient,
  conversationId: string,
  to: string,
  replyBase: {
    senderPhoneHash: string | null
    phoneLinkId: string | null
    conversationId: string | null
    correlationId: string | null
  },
): Promise<void> {
  const conversation = await loadConversation(supabase, conversationId)
  if (!conversation || conversation.state !== 'idle') return
  const context = getContext(conversation)
  const originalQueue: QueuedQuestion[] = context.question_queue ?? []
  const queue: QueuedQuestion[] = [...originalQueue]
  if (queue.length === 0) return

  const now = new Date()
  const nowIso = now.toISOString()
  const askedToday = questionsAskedToday(context, now)
  const windowOpen = serviceWindowOpen(conversation, now)

  let next: QueuedQuestion | null = null
  const moved: QueuedQuestion[] = []
  while (queue.length > 0) {
    const candidate = queue.shift()!
    if (!windowOpen || askedToday >= MAX_QUESTIONS_PER_DAY) {
      moved.push(candidate)
      continue
    }
    next = candidate
    break
  }
  for (const item of moved) {
    await updateItemContext(supabase, item.inbox_item_id, (itemContext) => ({
      ...itemContext,
      pending_question: { type: item.type, asked_at: nowIso, status: 'moved_to_app' },
    }))
  }
  if (!next) {
    await updateConversation(supabase, conversation, (_current, currentContext) => ({
      context: { ...currentContext, question_queue: [] },
    }))
    return
  }

  // Claim the pop BEFORE composing and sending. The idle check plus shift
  // above is a plain read-modify-write, so two answer workers landing
  // together both popped the same question and asked it twice. This guarded
  // write elects one of them and settles the whole question state in one go.
  const claimed = await updateConversation(supabase, conversation, (current, currentContext) => {
    if (current.state !== 'idle') return null
    if (
      JSON.stringify(currentContext.question_queue ?? []) !== JSON.stringify(originalQueue)
    ) {
      return null
    }
    return {
      state: STATE_FOR_QUESTION[next!.type],
      context: {
        ...currentContext,
        question_queue: queue,
        pending_question: {
          type: next!.type,
          inbox_item_id: next!.inbox_item_id,
          asked_at: nowIso,
        },
        recent_questions: appendRecentQuestion(
          currentContext,
          { type: next!.type, inbox_item_id: next!.inbox_item_id, asked_at: nowIso, status: 'open' },
          now,
        ),
        budget: bumpBudget(currentContext, 1, now),
      },
      last_outbound_at: nowIso,
    }
  })
  if (!claimed) return

  const { data: itemData } = await supabase
    .from('invoice_inbox_items')
    .select('id, extracted_data')
    .eq('id', next.inbox_item_id)
    .maybeSingle()
  const extracted =
    ((itemData as { extracted_data?: Record<string, unknown> | null } | null)?.extracted_data as
      | InvoiceExtractionResult
      | null
      | undefined) ?? null
  const merchant = extracted?.supplier?.name ?? null

  const copy = botCopy('sv')
  let body: string
  let template: TemplateId
  if (next.type === 'representation') {
    body = copy.m7Representation({
      ref: merchant ? `Kvittot från *${merchant}* ser ut som representation.` : null,
    })
    template = TEMPLATE.m7Representation
  } else if (next.type === 'resend') {
    body = copy.m9Resend({})
    template = TEMPLATE.m9Resend
  } else {
    body = copy.m10Context({})
    template = TEMPLATE.m10Context
  }

  await updateItemContext(supabase, next.inbox_item_id, (itemContext) => ({
    ...itemContext,
    pending_question: { type: next!.type, asked_at: nowIso, status: 'open' },
    ...(next!.type === 'resend'
      ? { quality: { ...itemContext.quality, resend_requested_at: nowIso } }
      : {}),
  }))
  await appendQuestionHistory(supabase, {
    inboxItemId: next.inbox_item_id,
    eventType: 'ChannelQuestionAsked',
    questionType: next.type,
  })

  await sendText(supabase, {
    to,
    body,
    template,
    ...replyBase,
    inboxItemId: next.inbox_item_id,
  })
}

// ── Kick: the after() entry point ────────────────────────────

/**
 * Schedule processing of freshly persisted message rows after the webhook
 * response is sent, then finalize the burst ack for every touched
 * conversation. Exact dispatch-kick idiom: never awaited by the caller,
 * never throws, falls back to a microtask outside a request scope (tests).
 */
export function kickInboundProcessing(messageIds: string[], opts: KickOptions = {}): void {
  if (messageIds.length === 0) return

  const run = async (): Promise<void> => {
    try {
      const supabase = createServiceClientNoCookies()
      const conversationIds = new Set<string>()
      for (const id of messageIds) {
        const outcome = await processInboundMessage(supabase, id, opts)
        if (outcome.kind === 'media_processed' && outcome.conversationId) {
          conversationIds.add(outcome.conversationId)
        }
      }
      for (const conversationId of conversationIds) {
        const conversation = await loadConversation(supabase, conversationId)
        if (!conversation?.pending_ack) continue
        const waitMs = conversation.debounce_until
          ? Math.max(0, new Date(conversation.debounce_until).getTime() - Date.now())
          : 0
        // Sleep to this invocation's own deadline, then attempt the claim.
        // If a newer message pushed debounce_until forward meanwhile, the
        // claim fails here and the newer invocation's later claim wins.
        await sleepFn(Math.min(waitMs, MAX_DEBOUNCE_WAIT_MS))
        await finalizeBurst(supabase, conversationId)
      }
    } catch (err) {
      // The sweep cron re-claims 'received' rows: a failed kick is a
      // latency regression, never a lost message.
      log.warn('deferred WhatsApp processing failed; sweep will retry', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  try {
    after(() => run())
  } catch {
    queueMicrotask(() => void run())
  }
}
