/**
 * WhatsApp intake extension (PR3 of the WhatsApp track).
 *
 * Receives receipts sent to the shared Accounted WhatsApp number and lands
 * them in the document inbox (Underlag) through the same uploadAndExtract
 * funnel as email intake. Phone numbers bind to Accounted users via one-time
 * codes; unknown senders get one canned, throttled greeting and are never
 * processed further (no LLM, no media download, no content persistence).
 *
 * Webhook lifecycle: persist-first. POST verifies the Meta signature over the
 * RAW body, Zod-parses, persists inbound rows (wamid partial-unique index =
 * the dedupe key against Meta's up-to-7-day redelivery), 200s fast, and
 * defers media processing via the after() idiom (lib/process-inbound.ts).
 * Rejected/rate-limited content always acks 200: a retryable status would
 * only buy a redelivery of something we already decided to drop.
 *
 * Conversation layer (PR4): media replies are burst-debounced into ONE
 * combined ack (M4/M5) sent by the single winner of the pending_ack claim;
 * multi-company senders get the company question (buttons/list/numbered) with
 * an 8h sliding pin; clarifying questions (M7/M9/M10) ride on the ack and
 * free-text answers route to the deferred interpret-answer worker. The
 * per-minute sweep cron (app/api/extensions/whatsapp-inbox/sweep/cron)
 * re-claims stuck rows and expires stale questions/pins.
 *
 * Deferred to PR5: retention cron, FieldsRail surfacing, booking-notes
 * threading.
 */

import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'
import type { WhatsAppConversation, WhatsAppPhoneLink } from '@/types'
import { verifyMetaSignature, verifyChallengeToken } from './lib/webhook-verify'
import { parseWebhookEnvelope, type ParsedInboundMessage } from './lib/webhook-parse'
import { hashPhone } from './lib/phone-crypto'
import {
  consumeLinkCode,
  createPhoneLink,
  LinkCodeRateLimitError,
  looksLikeLinkCode,
  lookupActiveLink,
  mintLinkCode,
} from './lib/linking'
import { sendText, sendReaction, getDisplayPhoneNumber, MAX_REPLY_BUTTONS } from './lib/graph-api'
import { botCopy, TEMPLATE } from './lib/messages'
import { kickInboundProcessing } from './lib/process-inbound'
import { CHAT_ALLOWED_MIME_TYPES, normalizeChatMime } from './lib/chat-mime'
import {
  DEBOUNCE_WINDOW_MS,
  getContext,
  getOrCreateConversation,
  greetingThrottled,
  redactRawPayload,
  resolveAnswerTarget,
  updateConversation,
  type ConversationContext,
} from './lib/conversation'
import { summarizeInboundEvent } from './lib/last-event'
import { applyCompanyChoice, type CompanyChoiceVia } from './lib/company-question'

const log = createLogger('whatsapp-inbox')

// ── Unknown-sender budgets ───────────────────────────────────
// Pre-binding limiter (check_and_increment_whatsapp_sender_quota): caps how
// much handling an unbound phone can consume at all. Beyond it: silence.
const UNKNOWN_SENDER_MINUTE_MAX = 15
const UNKNOWN_SENDER_DAY_MAX = 200
// Declined-message trace rows (issue #1552) are capped per hash and day so an
// over-quota flood cannot turn the observability trail into a write amplifier.
const DECLINE_TRACE_DAY_MAX = 20

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000

// Exact whole-message keyword sets (normalized lowercase + trim). Text
// messages only, never captions, per the conversation spec.
const STOP_KEYWORDS = new Set(['stopp', 'stop', 'avsluta'])
const HELP_KEYWORDS = new Set(['hjälp', 'hjalp', 'help', 'support', 'människa', 'manniska'])
const START_KEYWORD = 'start'
// Clears the 8h company pin. m6CompanyConfirm literally teaches this word, so
// it is recognized in every state EXCEPT awaiting_company (where the expected
// reply is a company, and 'byt' gets the re-prompt instead of being swallowed
// as answer text on someone's receipt).
const BYT_KEYWORD = 'byt'

const DefaultCompanySchema = z.object({
  companyId: z.string().uuid().nullable(),
})

function buildServiceClient(): SupabaseClient {
  return createServiceRoleClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

// ── Unknown senders ──────────────────────────────────────────

/**
 * Metadata-only trace row for an inbound message from an unknown sender
 * (issue #1552): direction, wamid, phone hash, type, disposition. NO body,
 * NO media reference, NO raw payload, NO profile name: the trace must never
 * become content persistence for someone who has not linked. phone_link_id
 * stays null, so the 30-day unknown-sender retention pass deletes these
 * wholesale.
 *
 * Returns 'recorded', 'duplicate' (wamid already persisted: a Meta
 * redelivery of a message we already handled), or 'skipped' (trace cap or
 * insert failure: observability must never break the webhook).
 */
async function recordUnknownSenderMessage(
  supabase: SupabaseClient,
  msg: ParsedInboundMessage,
  phoneHash: string,
  status: 'skipped' | 'done',
  disposition: string,
): Promise<'recorded' | 'duplicate' | 'skipped'> {
  try {
    // The day cap guards the one unbounded path: 'skipped' declines from an
    // over-quota flood. 'done' traces (a reply went out) skip it: they are
    // already bounded upstream (M1 by the greeting throttle, M2 by the
    // pre-binding quota), and capping them would let a redelivered wamid
    // past the dedupe below into a second reply. Best-effort under
    // concurrency: racing webhooks can overshoot by a few rows, which is
    // fine for a metadata trail.
    if (status === 'skipped') {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count } = await supabase
        .from('whatsapp_messages')
        .select('id', { count: 'exact', head: true })
        .eq('direction', 'inbound')
        .eq('sender_phone_hash', phoneHash)
        .is('phone_link_id', null)
        .gte('created_at', since)
      if ((count ?? 0) >= DECLINE_TRACE_DAY_MAX) return 'skipped'
    }

    const { error } = await supabase.from('whatsapp_messages').insert({
      direction: 'inbound',
      wamid: msg.wamid,
      sender_phone_hash: phoneHash,
      phone_link_id: null,
      conversation_id: null,
      message_type: msg.type,
      processing_status: status,
      error_message: disposition,
    })
    if (!error) return 'recorded'
    if (error.code === '23505') return 'duplicate'
    log.warn('Failed to record unknown-sender trace row', { error: error.message, disposition })
    return 'skipped'
  } catch (err) {
    log.warn('Unknown-sender trace write errored', {
      error: err instanceof Error ? err.message : String(err),
    })
    return 'skipped'
  }
}

/**
 * Unknown/unlinked sender. Hard rules: never download media, never persist
 * message content or raw payloads, never touch any LLM. The only DB writes
 * are the quota counters, a consumed link code, and outbound reply rows.
 */
async function handleUnknownSender(
  supabase: SupabaseClient,
  msg: ParsedInboundMessage,
  phoneHash: string,
): Promise<void> {
  const { data: quota, error: quotaError } = await supabase.rpc(
    'check_and_increment_whatsapp_sender_quota',
    {
      p_phone_hash: phoneHash,
      p_minute_max: UNKNOWN_SENDER_MINUTE_MAX,
      p_day_max: UNKNOWN_SENDER_DAY_MAX,
    },
  )
  if (quotaError) {
    // Fail closed for unknown senders: without the limiter we send nothing.
    // The decline itself is still recorded (#1552): support must be able to
    // answer "what happened to my message" even for this path.
    log.warn('sender quota RPC failed; staying silent', { error: quotaError.message })
    await recordUnknownSenderMessage(
      supabase, msg, phoneHash, 'skipped', 'Unknown sender: quota check failed, declined fail-closed',
    )
    return
  }
  if ((quota as { ok?: boolean } | null)?.ok === false) {
    await recordUnknownSenderMessage(
      supabase, msg, phoneHash, 'skipped', 'Unknown sender: over pre-binding quota, declined',
    )
    return
  }

  const copy = botCopy('sv')

  if (msg.type === 'text' && looksLikeLinkCode(msg.text)) {
    const consumed = await consumeLinkCode(supabase, msg.text ?? '')
    if (!consumed) {
      // Trace row first: a Meta redelivery of a message already answered
      // (including a redelivered CONSUMED code, whose row the success path
      // wrote) dedupes on the wamid instead of earning a second reply.
      const traced = await recordUnknownSenderMessage(
        supabase, msg, phoneHash, 'done', 'Unknown sender: invalid link code, M2 sent',
      )
      if (traced === 'duplicate') return
      await sendText(supabase, {
        to: msg.from,
        body: copy.m2BadCode(),
        template: TEMPLATE.m2BadCode,
        senderPhoneHash: phoneHash,
      })
      return
    }

    const { link, conversationId } = await createPhoneLink(supabase, {
      userId: consumed.userId,
      phone: msg.from,
      profileName: msg.profileName,
    })

    // Persist a content-free row for the code message so a Meta redelivery
    // of the same wamid dedupes instead of falling into the keyword path.
    await supabase.from('whatsapp_messages').insert({
      direction: 'inbound',
      wamid: msg.wamid,
      sender_phone_hash: phoneHash,
      phone_link_id: link.id,
      conversation_id: conversationId,
      message_type: 'text',
      processing_status: 'done',
    })

    const { data: memberships } = await supabase
      .from('company_members')
      .select('company_id')
      .eq('user_id', consumed.userId)
    const companyIds = [...new Set((memberships ?? []).map((m) => m.company_id as string))]

    let companyName: string | null = null
    if (companyIds.length === 1) {
      const { data: company } = await supabase
        .from('companies')
        .select('name')
        .eq('id', companyIds[0])
        .maybeSingle()
      companyName = (company as { name?: string } | null)?.name ?? null
    }

    await sendText(supabase, {
      to: msg.from,
      body: copy.m3Linked({ companyName, companyCount: Math.max(companyIds.length, 1) }),
      template: TEMPLATE.m3Linked,
      senderPhoneHash: phoneHash,
      phoneLinkId: link.id,
      conversationId,
    })
    return
  }

  // Anything else from an unknown number: the AI-disclosure greeting, hard
  // throttled per phone hash (EU AI Act Art 50 disclosure lives in M1).
  // Media bypasses the hour rule (10-minute burst window instead, daily cap
  // kept): a photo is a receipt someone expects to be handled, and pure
  // silence taught senders their receipts were being filed when nothing was.
  const carriesMedia = msg.type === 'image' || msg.type === 'document'
  if (await greetingThrottled(supabase, phoneHash, { media: carriesMedia })) {
    await recordUnknownSenderMessage(
      supabase, msg, phoneHash, 'skipped', 'Unknown sender: greeting throttled, declined',
    )
    return
  }
  const traced = await recordUnknownSenderMessage(
    supabase, msg, phoneHash, 'done', 'Unknown sender: greeted, M1 sent',
  )
  if (traced === 'duplicate') return
  await sendText(supabase, {
    to: msg.from,
    body: copy.m1Unlinked(),
    template: TEMPLATE.m1Unlinked,
    senderPhoneHash: phoneHash,
  })
}

// ── Linked senders ───────────────────────────────────────────

/** Why a message earns deliberate silence. Persisted on the skipped row
 *  (issue #1552) so support can answer "what happened" per message. */
type SilenceReason = 'muted' | 'stale_interactive' | 'ignorable_type'

const SILENCE_REASON_TEXT: Record<SilenceReason, string> = {
  muted: 'Muted by stopp: message not read',
  stale_interactive: 'Stale interactive tap after the question closed',
  ignorable_type: 'Ignorable message type, no reply expected',
}

type Disposition =
  | { kind: 'media' }
  | { kind: 'stop' }
  | { kind: 'start' }
  | { kind: 'help' }
  | { kind: 'byt' }
  | { kind: 'company_digit'; digit: number }
  | { kind: 'company_interactive'; companyId: string }
  | { kind: 'company_retry' }
  | { kind: 'answer' }
  | { kind: 'text_open' }
  | { kind: 'voice' }
  | { kind: 'unsupported' }
  | { kind: 'fallback' }
  | { kind: 'silence'; reason: SilenceReason }

/** Dispositions with a durable side effect (mute, pin, company routing).
 *  Their effect runs BEFORE the terminal row is written: see
 *  handleLinkedSender. Reply-only dispositions keep the persist-first shape. */
const DURABLE_DISPOSITIONS: ReadonlySet<Disposition['kind']> = new Set([
  'stop',
  'start',
  'byt',
  'company_digit',
  'company_interactive',
])

function classify(
  msg: ParsedInboundMessage,
  muted: boolean,
  conversation: WhatsAppConversation | null,
): Disposition {
  const state = conversation?.state ?? 'idle'
  // company_options outlive the awaiting_company state: the 48h TTL resets the
  // state but keeps the options so a LATE company answer still lands (media
  // stays fetchable from Meta for ~30 days, well past the question TTL).
  const companyChoiceOpen =
    (conversation ? (getContext(conversation).company_options?.length ?? 0) : 0) > 0
  if (msg.type === 'text') {
    const normalized = (msg.text ?? '').trim().toLowerCase()
    if (muted) {
      // While muted only `start` is recognized; everything else is silence.
      return normalized === START_KEYWORD
        ? { kind: 'start' }
        : { kind: 'silence', reason: 'muted' }
    }
    if (STOP_KEYWORDS.has(normalized)) return { kind: 'stop' }
    if (HELP_KEYWORDS.has(normalized)) return { kind: 'help' }
    if (normalized === START_KEYWORD) return { kind: 'start' }
    if (normalized === BYT_KEYWORD && state !== 'awaiting_company') return { kind: 'byt' }
    if (state === 'awaiting_company' || companyChoiceOpen) {
      // The answer is a tapped button/row (interactive) or a typed digit.
      if (/^\d{1,2}$/.test(normalized)) return { kind: 'company_digit', digit: Number(normalized) }
      // Anything else while the question is on screen: repeat the options.
      // The M16 fallback ("I cannot answer questions") right after the bot
      // asked one is the wrong answer to a typed company name.
      if (state === 'awaiting_company') return { kind: 'company_retry' }
    }
    if (
      state === 'awaiting_representation' ||
      state === 'awaiting_context' ||
      // Words cannot answer the re-send question, but they are still about
      // that receipt: the worker keeps them as a note (M9 note) instead of
      // binding them to some other receipt's open question.
      state === 'awaiting_resend'
    ) {
      return { kind: 'answer' }
    }
    // Idle free text: maybe a late answer to an earlier question (quoted
    // reply or the most recent open one); resolved below.
    return { kind: 'text_open' }
  }
  if (muted) return { kind: 'silence', reason: 'muted' }
  if (msg.type === 'interactive') {
    if ((conversation?.state === 'awaiting_company' || companyChoiceOpen) && msg.interactiveReplyId) {
      return { kind: 'company_interactive', companyId: msg.interactiveReplyId }
    }
    // Stale button tap after the question closed: silence beats lecturing.
    return { kind: 'silence', reason: 'stale_interactive' }
  }
  if (msg.type === 'image' || msg.type === 'document') {
    return msg.media ? { kind: 'media' } : { kind: 'unsupported' }
  }
  if (msg.type === 'audio') return { kind: 'voice' }
  if (msg.type === 'video' || msg.type === 'sticker' || msg.type === 'location' || msg.type === 'contacts') {
    return { kind: 'unsupported' }
  }
  // Truly unknown types (reactions, ephemeral, future additions): stay
  // silent rather than lecture someone for sending a thumbs-up.
  return { kind: 'silence', reason: 'ignorable_type' }
}

/** True when this inbound wamid was already persisted (Meta redelivery). */
async function inboundAlreadyPersisted(
  supabase: SupabaseClient,
  wamid: string | null,
): Promise<boolean> {
  if (!wamid) return false
  const { data } = await supabase
    .from('whatsapp_messages')
    .select('id')
    .eq('wamid', wamid)
    .eq('direction', 'inbound')
    .limit(1)
    .maybeSingle()
  return data != null
}

/** last_message_at + the 24h service window, touched for every inbound. */
async function touchInbound(
  supabase: SupabaseClient,
  link: WhatsAppPhoneLink,
  conversationId: string | null,
  now: Date,
  armBurst: boolean,
): Promise<void> {
  await supabase
    .from('whatsapp_phone_links')
    .update({ last_message_at: now.toISOString() })
    .eq('id', link.id)
  if (!conversationId) return
  // Media arms the burst debounce: each file pushes the deadline forward,
  // and the deferred worker whose deadline survives claims the ONE ack.
  // Two literal payloads (not one built at runtime) so the phantom-column
  // scanner can verify both shapes.
  if (armBurst) {
    await supabase
      .from('whatsapp_conversations')
      .update({
        last_inbound_at: now.toISOString(),
        service_window_expires_at: new Date(now.getTime() + SERVICE_WINDOW_MS).toISOString(),
        debounce_until: new Date(now.getTime() + DEBOUNCE_WINDOW_MS).toISOString(),
        pending_ack: true,
      })
      .eq('id', conversationId)
  } else {
    await supabase
      .from('whatsapp_conversations')
      .update({
        last_inbound_at: now.toISOString(),
        service_window_expires_at: new Date(now.getTime() + SERVICE_WINDOW_MS).toISOString(),
      })
      .eq('id', conversationId)
  }
}

async function handleLinkedSender(
  supabase: SupabaseClient,
  msg: ParsedInboundMessage,
  phoneHash: string,
  link: WhatsAppPhoneLink,
  deferredMessageIds: string[],
): Promise<void> {
  const conversation = await getOrCreateConversation(supabase, link.id)
  const conversationId = conversation?.id ?? null
  const muted = link.muted_at != null
  let disposition = classify(msg, muted, conversation)

  // Late-answer probe: free text with no open awaiting state still answers a
  // recent question when it quotes one of its messages or one is open <=7d.
  if (disposition.kind === 'text_open') {
    const target = conversation
      ? await resolveAnswerTarget(supabase, conversation, msg.contextWamid)
      : null
    disposition = target ? { kind: 'answer' } : { kind: 'fallback' }
  }

  const correlationId = crypto.randomUUID()
  const copy = botCopy('sv')
  const now = new Date()
  const replyBase = {
    senderPhoneHash: phoneHash,
    phoneLinkId: link.id,
    conversationId,
    correlationId,
  }

  // ── Durable dispositions: effect first, terminal row after ──
  // Writing the row 'done' up front made these at-most-once: an instance that
  // died between the insert and the effect lost the action forever, because
  // Meta's redelivery hits the wamid dedupe and the sweep never claims 'done'
  // rows. A dropped STOP is a dropped opt-out, so the order is inverted here
  // and dedupe becomes a pre-check: the worst case is now a repeated (and
  // idempotent) effect plus a duplicate confirmation, never a lost one.
  if (DURABLE_DISPOSITIONS.has(disposition.kind)) {
    if (await inboundAlreadyPersisted(supabase, msg.wamid)) return
    await touchInbound(supabase, link, conversationId, now, false)

    switch (disposition.kind) {
      case 'company_digit':
      case 'company_interactive': {
        if (!conversation) return
        const options = getContext(conversation).company_options ?? []
        const via: CompanyChoiceVia =
          disposition.kind === 'company_digit'
            ? 'numbered'
            : options.length <= MAX_REPLY_BUTTONS
              ? 'button'
              : 'list'
        const applied = await applyCompanyChoice(supabase, {
          conversation,
          link,
          choice:
            disposition.kind === 'company_digit'
              ? { digit: disposition.digit }
              : { companyId: disposition.companyId },
          via,
          to: msg.from,
          replyBase,
        })
        if (applied.ok) {
          if (applied.stagedMessageIds.length > 0) {
            kickInboundProcessing(applied.stagedMessageIds, { companySelectedVia: via })
          }
        } else if (applied.reason === 'invalid_option' && options.length > 0) {
          // A typed digit outside the range is a typo, not a forged payload:
          // silence just leaves the receipts parked until they expire.
          await sendText(supabase, {
            to: msg.from,
            body: copy.m6CompanyRetry({ options: options.map((o) => o.name) }),
            template: TEMPLATE.m6CompanyRetry,
            ...replyBase,
          })
        }
        // Other rejections stay silent (stale or forged payloads).
        break
      }
      case 'byt': {
        if (conversation) {
          await updateConversation(supabase, conversation, (_current, context) => {
            const next: ConversationContext = { ...context }
            delete next.pin_expires_at
            delete next.pin_source
            return { company_id: null, context: next }
          })
        }
        await sendText(supabase, { to: msg.from, body: copy.m6BytPin(), template: TEMPLATE.m6BytPin, ...replyBase })
        break
      }
      case 'stop':
        await supabase
          .from('whatsapp_phone_links')
          .update({ muted_at: now.toISOString() })
          .eq('id', link.id)
          .is('muted_at', null)
        await sendText(supabase, { to: msg.from, body: copy.m11Stop(), template: TEMPLATE.m11Stop, ...replyBase })
        break
      case 'start':
        if (muted) {
          await supabase
            .from('whatsapp_phone_links')
            .update({ muted_at: null })
            .eq('id', link.id)
        }
        await sendText(supabase, { to: msg.from, body: copy.m12Start(), template: TEMPLATE.m12Start, ...replyBase })
        break
    }

    // Terminal row last. A concurrent redelivery that won the race 23505s.
    const { error: durableInsertError } = await supabase.from('whatsapp_messages').insert({
      direction: 'inbound',
      wamid: msg.wamid,
      sender_phone_hash: phoneHash,
      phone_link_id: link.id,
      conversation_id: conversationId,
      message_type: msg.type,
      body_text: msg.type === 'text' ? msg.text : (msg.caption ?? null),
      raw_payload: redactRawPayload(msg.raw),
      processing_status: 'done',
      correlation_id: correlationId,
    })
    if (durableInsertError && durableInsertError.code !== '23505') {
      log.error('Failed to persist handled WhatsApp message', durableInsertError)
    }
    return
  }

  // ── Everything else: persist-first ──────────────────────────
  // Dedupe on the inbound-wamid partial unique index. A redelivered wamid
  // violates it (23505): already handled, stop entirely.
  const initialStatus =
    disposition.kind === 'media' || disposition.kind === 'answer'
      ? 'received'
      : disposition.kind === 'silence'
        ? 'skipped'
        : 'done'
  // A muted sender is told the channel is paused, so nothing they send is
  // read: match the unknown-sender discipline and keep no content at all.
  const keepContent = !muted
  const { data: inserted, error: insertError } = await supabase
    .from('whatsapp_messages')
    .insert({
      direction: 'inbound',
      wamid: msg.wamid,
      sender_phone_hash: phoneHash,
      phone_link_id: link.id,
      conversation_id: conversationId,
      message_type: msg.type,
      body_text: keepContent ? (msg.type === 'text' ? msg.text : (msg.caption ?? null)) : null,
      media_id: keepContent ? (msg.media?.id ?? null) : null,
      media_mime: keepContent ? (msg.media?.mime ?? null) : null,
      media_sha256: keepContent ? (msg.media?.sha256 ?? null) : null,
      media_filename: keepContent ? (msg.media?.filename ?? null) : null,
      // The sender's plaintext E.164 number lived in here on every single
      // row, which defeated the AES-256-GCM phone_enc on the link. Replies
      // decrypt the link instead (resolveRecipient).
      raw_payload: keepContent ? redactRawPayload(msg.raw) : null,
      processing_status: initialStatus,
      // Deliberate silences carry their reason (#1552): a skipped row with
      // no explanation is exactly the blind spot this exists to close.
      error_message: disposition.kind === 'silence' ? SILENCE_REASON_TEXT[disposition.reason] : null,
      correlation_id: correlationId,
    })
    .select('id')
    .maybeSingle()

  if (insertError) {
    if (insertError.code === '23505') return // wamid dedupe: Meta redelivery
    log.error('Failed to persist inbound WhatsApp message', insertError)
    return
  }
  const messageId = (inserted as { id: string } | null)?.id ?? null

  await touchInbound(supabase, link, conversationId, now, disposition.kind === 'media')

  switch (disposition.kind) {
    case 'media':
    case 'answer':
      // Media intake and answer interpretation both run deferred (the answer
      // path may call the LLM; the webhook must 200 in seconds).
      if (messageId) deferredMessageIds.push(messageId)
      // Instant "received" signal: the detailed ack waits on extraction
      // (10-60s), which read as a black hole to someone standing at a
      // register. A reaction on the sender's own bubble lands within
      // seconds, adds no chat noise, and the row just persisted plus the
      // sweep guarantee (ingest or M18) make it honest. Only for files the
      // pipeline will accept: junk earns M15, not a checkmark. One Graph
      // call (~10s timeout worst case) stays inside Meta's webhook budget,
      // and a redelivered wamid returns on the 23505 above, so no re-react.
      if (disposition.kind === 'media' && msg.wamid) {
        if (CHAT_ALLOWED_MIME_TYPES.has(normalizeChatMime(msg.media?.mime))) {
          await sendReaction(msg.from, msg.wamid)
        }
      }
      return
    case 'company_retry': {
      const options = conversation ? (getContext(conversation).company_options ?? []) : []
      await sendText(supabase, {
        to: msg.from,
        body: options.length > 0 ? copy.m6CompanyRetry({ options: options.map((o) => o.name) }) : copy.m16Fallback(),
        template: options.length > 0 ? TEMPLATE.m6CompanyRetry : TEMPLATE.m16Fallback,
        ...replyBase,
      })
      return
    }
    case 'help':
      await sendText(supabase, { to: msg.from, body: copy.m13Help(), template: TEMPLATE.m13Help, ...replyBase })
      return
    case 'voice':
      await sendText(supabase, { to: msg.from, body: copy.m14Voice(), template: TEMPLATE.m14Voice, ...replyBase })
      return
    case 'unsupported':
      await sendText(supabase, { to: msg.from, body: copy.m15Unsupported(), template: TEMPLATE.m15Unsupported, ...replyBase })
      return
    case 'fallback':
      await sendText(supabase, { to: msg.from, body: copy.m16Fallback(), template: TEMPLATE.m16Fallback, ...replyBase })
      return
    case 'silence':
      return
  }
}

// ── Extension definition ─────────────────────────────────────

export const whatsappInboxExtension: Extension = {
  id: 'whatsapp-inbox',
  name: 'WhatsApp-inkorg',
  version: '1.0.0',
  sector: 'general',

  settingsPanel: {
    label: 'WhatsApp',
    path: '/settings/whatsapp',
  },

  apiRoutes: [
    // ── Meta webhook: subscription handshake ────────────────
    {
      method: 'GET',
      path: '/webhook',
      skipAuth: true,
      handler: async (request: Request) => {
        const expected = process.env.WHATSAPP_VERIFY_TOKEN
        if (!expected) {
          return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
        }
        const url = new URL(request.url)
        const mode = url.searchParams.get('hub.mode')
        const token = url.searchParams.get('hub.verify_token')
        const challenge = url.searchParams.get('hub.challenge')
        if (mode === 'subscribe' && verifyChallengeToken(token, expected) && challenge != null) {
          return new Response(challenge, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          })
        }
        return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
      },
    },

    // ── Meta webhook: inbound events ────────────────────────
    {
      method: 'POST',
      path: '/webhook',
      skipAuth: true,
      handler: async (request: Request) => {
        const appSecret = process.env.WHATSAPP_APP_SECRET
        if (!appSecret) {
          log.error('WHATSAPP_APP_SECRET not configured', undefined)
          return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
        }

        // Signature over the RAW body, before any parsing.
        const rawBody = await request.text()
        const signature = request.headers.get('x-hub-signature-256')
        if (!verifyMetaSignature(rawBody, signature, appSecret)) {
          return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
        }

        let body: unknown
        try {
          body = JSON.parse(rawBody)
        } catch {
          // Signed but unparseable: ack so Meta does not redeliver garbage.
          return NextResponse.json({ data: { ignored: 'unparseable' } })
        }

        const parsed = parseWebhookEnvelope(body)
        const supabase = buildServiceClient()

        // Outbound delivery lifecycle updates (sent -> delivered -> read).
        // A 'failed' status carries Meta's error detail (e.g. undeliverable,
        // recipient unavailable): keep it on the row (#1552), it is the only
        // record of WHY a reply never reached the sender. Two literal
        // payloads so the phantom-column scanner can verify both shapes.
        for (const status of parsed.statuses) {
          if (status.status === 'failed' && status.errorDetail) {
            await supabase
              .from('whatsapp_messages')
              .update({ delivery_status: status.status, error_message: status.errorDetail })
              .eq('wamid', status.wamid)
              .eq('direction', 'outbound')
          } else {
            await supabase
              .from('whatsapp_messages')
              .update({ delivery_status: status.status })
              .eq('wamid', status.wamid)
              .eq('direction', 'outbound')
          }
        }

        const deferredMessageIds: string[] = []
        for (const msg of parsed.messages) {
          try {
            const phoneHash = hashPhone(msg.from)
            const link = await lookupActiveLink(supabase, phoneHash)
            if (link) {
              await handleLinkedSender(supabase, msg, phoneHash, link, deferredMessageIds)
            } else {
              await handleUnknownSender(supabase, msg, phoneHash)
            }
          } catch (err) {
            // One bad message must not take down the batch or trigger a
            // Meta redelivery of messages we already handled.
            log.error('WhatsApp message handling failed', err, { wamid: msg.wamid })
          }
        }

        // 200 first, processing after: extraction takes 10-60s, answer
        // interpretation may call the LLM, and Meta expects the ack within
        // seconds.
        kickInboundProcessing(deferredMessageIds)

        return NextResponse.json({
          data: {
            received: parsed.messages.length,
            statuses: parsed.statuses.length,
            queued: deferredMessageIds.length,
          },
        })
      },
    },

    // ── Phone linking (authenticated settings panel) ────────
    {
      method: 'POST',
      path: '/link/start',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
          return NextResponse.json(
            { error: 'WhatsApp-kanalen är inte konfigurerad på den här installationen.' },
            { status: 503 },
          )
        }

        // whatsapp_link_codes is service-role only (RLS with no policies).
        const serviceClient = createServiceClient()
        let minted: Awaited<ReturnType<typeof mintLinkCode>>
        try {
          minted = await mintLinkCode(serviceClient, ctx.userId)
        } catch (err) {
          if (err instanceof LinkCodeRateLimitError) {
            return NextResponse.json(
              { error: 'För många koder begärda. Vänta en stund och försök igen.' },
              { status: 429 },
            )
          }
          throw err
        }

        // The wa.me link needs the real number, not the Graph object id.
        // WHATSAPP_PUBLIC_NUMBER (E.164 digits) is authoritative when set;
        // otherwise resolve display_phone_number from the Graph API (cached).
        const publicNumber = (process.env.WHATSAPP_PUBLIC_NUMBER ?? '').replace(/\D/g, '')
        const displayNumber = publicNumber || (await getDisplayPhoneNumber())
        const waLink = displayNumber
          ? `https://wa.me/${displayNumber}?text=${encodeURIComponent(minted.code)}`
          : null

        return NextResponse.json({
          data: { code: minted.code, expiresAt: minted.expiresAt, waLink },
        })
      },
    },

    {
      method: 'GET',
      path: '/link',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        const { data } = await ctx.supabase
          .from('whatsapp_phone_links')
          .select('id, phone_masked, default_company_id, muted_at, verified_at')
          .eq('user_id', ctx.userId)
          .is('revoked_at', null)
          .maybeSingle()

        if (!data) return NextResponse.json({ data: { linked: false } })
        const row = data as {
          id: string
          phone_masked: string
          default_company_id: string | null
          muted_at: string | null
          verified_at: string
        }

        // Last inbound event + last reply delivery (#1552): the panel answers
        // "when did you last hear from me and what happened". whatsapp_messages
        // is service-role only, so read with the service client, keyed strictly
        // by the link row RLS just proved the caller owns. Only a closed enum
        // and timestamps leave the server, never message content.
        const serviceClient = createServiceClient()
        const { data: lastInbound } = await serviceClient
          .from('whatsapp_messages')
          .select('created_at, processing_status, error_message, inbox_item_id')
          .eq('phone_link_id', row.id)
          .eq('direction', 'inbound')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        const { data: lastOutbound } = await serviceClient
          .from('whatsapp_messages')
          .select('delivery_status')
          .eq('phone_link_id', row.id)
          .eq('direction', 'outbound')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        // Channel health for THIS link, 7-day window, head counts only: how
        // many replies never reached the sender and how many inbound rows
        // parked with a reason. The panel turns nonzero counts into one
        // attention line; nothing else in the app reads delivery_status.
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        const { count: outboundFailed7d } = await serviceClient
          .from('whatsapp_messages')
          .select('id', { count: 'exact', head: true })
          .eq('phone_link_id', row.id)
          .eq('direction', 'outbound')
          .eq('delivery_status', 'failed')
          .gte('created_at', weekAgo)
        const { count: parkedInbound7d } = await serviceClient
          .from('whatsapp_messages')
          .select('id', { count: 'exact', head: true })
          .eq('phone_link_id', row.id)
          .eq('direction', 'inbound')
          .in('processing_status', ['skipped', 'error'])
          .not('error_message', 'is', null)
          .gte('created_at', weekAgo)

        const inboundRow = lastInbound as {
          created_at: string
          processing_status: string
          error_message: string | null
          inbox_item_id: string | null
        } | null
        return NextResponse.json({
          data: {
            linked: true,
            phoneMasked: row.phone_masked,
            defaultCompanyId: row.default_company_id,
            muted: row.muted_at != null,
            verifiedAt: row.verified_at,
            lastInboundAt: inboundRow?.created_at ?? null,
            lastInboundEvent: inboundRow ? summarizeInboundEvent(inboundRow) : null,
            lastReplyFailed:
              (lastOutbound as { delivery_status: string | null } | null)?.delivery_status ===
              'failed',
            health: {
              outboundFailed7d: outboundFailed7d ?? 0,
              parkedInbound7d: parkedInbound7d ?? 0,
            },
          },
        })
      },
    },

    {
      method: 'POST',
      path: '/link/revoke',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        await ctx.supabase
          .from('whatsapp_phone_links')
          .update({ revoked_at: new Date().toISOString() })
          .eq('user_id', ctx.userId)
          .is('revoked_at', null)
        return NextResponse.json({ data: { revoked: true } })
      },
    },

    {
      method: 'POST',
      path: '/link/unmute',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        // Clears a stopp pause from the app (the in-chat counterpart is the
        // literal text `start`). The user-scoped client is deliberate: RLS
        // (whatsapp_phone_links_update_own) proves the caller owns the row.
        // Idempotent on an unpaused link; only a missing active link 404s.
        const { data } = await ctx.supabase
          .from('whatsapp_phone_links')
          .update({ muted_at: null })
          .eq('user_id', ctx.userId)
          .is('revoked_at', null)
          .select('id')
        if (!Array.isArray(data) || data.length === 0) {
          return NextResponse.json(
            { error: 'Ingen aktiv WhatsApp-koppling hittades.' },
            { status: 404 },
          )
        }
        return NextResponse.json({ data: { unmuted: true } })
      },
    },

    {
      method: 'POST',
      path: '/link/default-company',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let parsedBody: z.infer<typeof DefaultCompanySchema>
        try {
          parsedBody = DefaultCompanySchema.parse(await request.json())
        } catch {
          return NextResponse.json({ error: 'Ogiltig förfrågan.' }, { status: 400 })
        }

        // The caller must be a member of the company receipts are routed to:
        // otherwise a user could point their intake at someone else's books.
        if (parsedBody.companyId) {
          const { data: membership } = await ctx.supabase
            .from('company_members')
            .select('id')
            .eq('company_id', parsedBody.companyId)
            .eq('user_id', ctx.userId)
            .maybeSingle()
          if (!membership) {
            return NextResponse.json(
              { error: 'Du är inte medlem i det företaget.' },
              { status: 403 },
            )
          }
        }

        const { error } = await ctx.supabase
          .from('whatsapp_phone_links')
          .update({ default_company_id: parsedBody.companyId })
          .eq('user_id', ctx.userId)
          .is('revoked_at', null)
        if (error) {
          return NextResponse.json(
            { error: 'Kunde inte spara standardföretaget.' },
            { status: 500 },
          )
        }
        return NextResponse.json({ data: { defaultCompanyId: parsedBody.companyId } })
      },
    },
  ],
}
