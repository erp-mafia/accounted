/**
 * Deterministic conversation state helpers (LLM-last: everything here is
 * plain code over whatsapp_conversations).
 *
 * The `context` jsonb column carries, per conversation:
 *   - pin_expires_at        8h sliding company-pin TTL (companion of company_id)
 *   - pin_source            how the live pin was chosen (button/list/numbered)
 *   - company_options       ordered options behind an open company question,
 *                           so a digit reply maps to a company id
 *   - pending_question      the ONE in-flight question (type + item + asked_at)
 *   - question_queue        questions admitted for later (burst budget of 2)
 *   - recent_questions      asked-question log for late answers (<= 7 days)
 *   - budget                daily content-question counter (Europe/Stockholm)
 *
 * Concurrency note: context is read-modify-write via PostgREST, and the
 * writers (burst-ack winner, answer worker, company-choice handler, sweep)
 * hold DIFFERENT claims (pending_ack vs processing_status), so they are not
 * serialized against each other. Every context write therefore goes through
 * updateConversation(), which guards on the updated_at it read and re-applies
 * the mutation against fresh state when it loses. Media staging deliberately
 * does NOT go through context (staged refs live as whatsapp_messages rows) so
 * parallel webhook invocations never race on this column at all.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { WhatsAppConversation, WhatsAppMessage } from '@/types'
import { decryptPhone } from './phone-crypto'
import { TEMPLATE } from './messages'

const log = createLogger('whatsapp-inbox/conversation')

// The M1 "not linked" greeting is hard throttled per phone hash: text gets
// 1/hour, media rides a 10-minute burst window instead (see below); both
// share the 3/day cap, then silence. Shared by the unknown-sender path
// (webhook) and the revoked-mid-processing path (process-inbound), so it
// lives here.
const GREETING_HOUR_MS = 60 * 60 * 1000
const GREETING_BURST_MS = 10 * 60 * 1000
const GREETING_DAY_MS = 24 * 60 * 60 * 1000
const GREETING_DAY_MAX = 3

/** True when another M1 greeting to this phone hash would exceed the cap.
 *  Fails CLOSED: if the throttle window cannot be read, no greeting goes
 *  out, matching the unknown-sender quota's stance.
 *
 *  `media: true` marks a message that carried an image or document: the
 *  sender is handing over a receipt they expect to be handled, so repeats are
 *  suppressed only inside a 10-minute burst window (one burst of photos earns
 *  exactly one M1) instead of the full hour. The daily cap applies to both. */
export async function greetingThrottled(
  supabase: SupabaseClient,
  phoneHash: string,
  opts: { media?: boolean } = {},
): Promise<boolean> {
  const since = new Date(Date.now() - GREETING_DAY_MS).toISOString()
  const { data, error } = await supabase
    .from('whatsapp_messages')
    .select('created_at')
    .eq('direction', 'outbound')
    .eq('sender_phone_hash', phoneHash)
    .eq('raw_payload->>template', TEMPLATE.m1Unlinked)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(GREETING_DAY_MAX)
  if (error) {
    log.warn('greeting throttle window unreadable; staying silent', { error: error.message })
    return true
  }
  const rows = (data ?? []) as Array<{ created_at: string }>
  if (rows.length >= GREETING_DAY_MAX) return true
  const windowStart = Date.now() - (opts.media ? GREETING_BURST_MS : GREETING_HOUR_MS)
  return rows.some((r) => new Date(r.created_at).getTime() > windowStart)
}

export const COMPANY_PIN_TTL_MS = 8 * 60 * 60 * 1000
export const QUESTION_TTL_MS = 48 * 60 * 60 * 1000
export const LATE_ANSWER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const DEBOUNCE_WINDOW_MS = 12 * 1000
export const MAX_QUESTIONS_PER_BURST = 2
export const MAX_QUESTIONS_PER_DAY = 6

/** error_message marker on whatsapp_messages rows parked while the company
 *  question is open. The answer handler re-opens exactly these. */
export const STAGED_AWAITING_COMPANY = 'staged_awaiting_company'
/** Marker after the 48h TTL expired: excluded from any later re-open. */
export const COMPANY_CHOICE_EXPIRED = 'company_choice_expired'
/** Terminal marker when the company question could not be asked at all:
 *  the sender has fewer than 2 companies to choose between, so nothing will
 *  change until they fix the linking in the app. The rows are never retried;
 *  M19 tells the sender why. */
export const NO_COMPANY_OPTIONS = 'no_company_options'

export type QuestionType = 'representation' | 'context' | 'resend'
export type ConversationQuestionType = QuestionType | 'company'

export interface PendingQuestion {
  type: ConversationQuestionType
  /** Null for company questions (no item exists before the answer). */
  inbox_item_id: string | null
  asked_at: string
}

export interface QueuedQuestion {
  type: QuestionType
  inbox_item_id: string
}

export interface RecentQuestion {
  type: QuestionType
  inbox_item_id: string
  asked_at: string
  status: 'open' | 'answered' | 'moved_to_app'
}

export interface ConversationContext {
  pin_expires_at?: string
  pin_source?: 'button' | 'list' | 'numbered'
  company_options?: { id: string; name: string }[]
  pending_question?: PendingQuestion
  question_queue?: QueuedQuestion[]
  recent_questions?: RecentQuestion[]
  budget?: { day_key: string; count: number }
}

export function getContext(conversation: WhatsAppConversation): ConversationContext {
  return (conversation.context ?? {}) as ConversationContext
}

/** Load (or lazily create) the conversation row for a phone link. */
export async function getOrCreateConversation(
  supabase: SupabaseClient,
  phoneLinkId: string,
): Promise<WhatsAppConversation | null> {
  const { data: existing } = await supabase
    .from('whatsapp_conversations')
    .select('*')
    .eq('phone_link_id', phoneLinkId)
    .maybeSingle()
  if (existing) return existing as WhatsAppConversation
  const { data: created } = await supabase
    .from('whatsapp_conversations')
    .insert({ phone_link_id: phoneLinkId })
    .select('*')
    .maybeSingle()
  return (created as WhatsAppConversation | null) ?? null
}

export async function loadConversation(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<WhatsAppConversation | null> {
  const { data } = await supabase
    .from('whatsapp_conversations')
    .select('*')
    .eq('id', conversationId)
    .maybeSingle()
  return (data as WhatsAppConversation | null) ?? null
}

/** Fields a conversation write may touch. Anything omitted stays as it is. */
export interface ConversationPatch {
  state?: WhatsAppConversation['state']
  context?: ConversationContext
  company_id?: string | null
  last_outbound_at?: string
  pending_ack?: boolean
  debounce_until?: string
}

/**
 * Optimistic-concurrency write of a conversation row.
 *
 * `context` is a whole-jsonb column written read-modify-write, and its writers
 * hold different claims (the ack winner holds pending_ack, an answer worker
 * holds its own row's processing_status, the sweep holds nothing), so a blind
 * `.eq('id')` update silently clobbers whatever landed in between: resurrected
 * questions, wiped pending_question, dropped queue entries.
 *
 * The updated_at trigger makes that column a revision counter, so guarding on
 * the value the mutation was derived from turns every write into a
 * compare-and-set. On a lost race the row is reloaded and `mutate` runs again
 * against fresh state; returning null from it aborts (the work is already
 * done, or no longer applies).
 */
export async function updateConversation(
  supabase: SupabaseClient,
  conversation: WhatsAppConversation,
  mutate: (
    current: WhatsAppConversation,
    context: ConversationContext,
  ) => ConversationPatch | null,
  maxAttempts = 4,
): Promise<WhatsAppConversation | null> {
  let current: WhatsAppConversation | null = conversation
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!current) return null
    const patch = mutate(current, getContext(current))
    if (!patch) return null
    // Literal payload so the phantom-column scanner can verify the column
    // names; undefined values drop out of the JSON body PostgREST receives.
    const { data } = await supabase
      .from('whatsapp_conversations')
      .update({
        state: patch.state,
        context: patch.context as Record<string, unknown> | undefined,
        company_id: patch.company_id,
        last_outbound_at: patch.last_outbound_at,
        pending_ack: patch.pending_ack,
        debounce_until: patch.debounce_until,
      })
      .eq('id', current.id)
      .eq('updated_at', current.updated_at)
      .select('*')
    // PostgREST returns [] only when the revision guard did not match.
    if (!Array.isArray(data) || data.length > 0) {
      const written = Array.isArray(data) ? (data[0] as WhatsAppConversation) : null
      return written ?? ({ ...current, ...patch } as WhatsAppConversation)
    }
    current = await loadConversation(supabase, current.id)
  }
  log.warn('conversation write gave up after concurrent modifications', {
    conversationId: conversation.id,
  })
  return null
}

/**
 * Atomic burst-ack claim. Exactly one caller per debounce window gets a row
 * back; everyone else stays silent. `debounce_until <= now` uses the caller's
 * clock: harmless skew only shifts WHEN the winner fires, never how many win
 * (pending_ack is the exclusivity bit).
 */
export async function claimAck(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('whatsapp_conversations')
    .update({ pending_ack: false })
    .eq('id', conversationId)
    .eq('pending_ack', true)
    .lte('debounce_until', new Date().toISOString())
    .select('id')
  return Array.isArray(data) && data.length > 0
}

/** Day key for the daily question budget, in the sender's civil day. */
export function stockholmDayKey(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/** Content questions already asked today (rolls over at Stockholm midnight). */
export function questionsAskedToday(context: ConversationContext, now: Date = new Date()): number {
  const budget = context.budget
  if (!budget || budget.day_key !== stockholmDayKey(now)) return 0
  return budget.count
}

export function bumpBudget(
  context: ConversationContext,
  asked: number,
  now: Date = new Date(),
): ConversationContext['budget'] {
  const dayKey = stockholmDayKey(now)
  const current = context.budget?.day_key === dayKey ? context.budget.count : 0
  // Negative `asked` refunds a question whose send failed; never below zero.
  return { day_key: dayKey, count: Math.max(0, current + asked) }
}

/** True when the company pin on the conversation is present and unexpired. */
export function hasLivePin(
  conversation: WhatsAppConversation,
  now: Date = new Date(),
): boolean {
  if (!conversation.company_id) return false
  const expiresAt = getContext(conversation).pin_expires_at
  if (!expiresAt) return false
  return new Date(expiresAt).getTime() > now.getTime()
}

/** True when the 24h service window is open (we may send free-form replies). */
export function serviceWindowOpen(
  conversation: WhatsAppConversation,
  now: Date = new Date(),
): boolean {
  const expiresAt = conversation.service_window_expires_at
  return expiresAt != null && new Date(expiresAt).getTime() > now.getTime()
}

/** Question types a free-text reply can answer. Resend needs media. */
export type TextAnswerableQuestionType = Extract<QuestionType, 'representation' | 'context'>

export interface AnswerTarget {
  type: TextAnswerableQuestionType
  inboxItemId: string
  /** True when matched outside an awaiting_* state (quoted or recent). */
  late: boolean
  /** The quoted receipt's question was already answered: this is a follow-up
   *  correction, appended to the note instead of overwriting the answer. */
  followUp?: boolean
}

const TEXT_ANSWERABLE: ReadonlySet<string> = new Set(['representation', 'context'])

function isTextAnswerable(
  question: RecentQuestion,
): question is RecentQuestion & { type: TextAnswerableQuestionType } {
  return TEXT_ANSWERABLE.has(question.type)
}

/**
 * Resolve which question a free-text message answers.
 *
 * 1. A quoted reply (context.message_id -> whatsapp_messages.wamid, either
 *    direction) names its receipt, so it wins over everything else, including
 *    an unrelated pending question and including a question that receipt has
 *    already answered (the reply is then a follow-up correction). Binding a
 *    quoted correction to some OTHER receipt because the quoted one was
 *    settled is how the wrong item gets the note.
 * 2. Otherwise an awaiting_representation/awaiting_context state answers its
 *    own pending question.
 * 3. Otherwise the single most recent question asked within 7 days that has
 *    not been answered yet (moved_to_app still accepts a late answer).
 */
export async function resolveAnswerTarget(
  supabase: SupabaseClient,
  conversation: WhatsAppConversation,
  quotedWamid: string | null,
  now: Date = new Date(),
): Promise<AnswerTarget | null> {
  const context = getContext(conversation)

  const pending =
    (conversation.state === 'awaiting_representation' ||
      conversation.state === 'awaiting_context') &&
    context.pending_question &&
    TEXT_ANSWERABLE.has(context.pending_question.type) &&
    context.pending_question.inbox_item_id
      ? {
          type: context.pending_question.type as TextAnswerableQuestionType,
          inboxItemId: context.pending_question.inbox_item_id,
        }
      : null

  const withinWindow = (question: RecentQuestion): boolean =>
    now.getTime() - new Date(question.asked_at).getTime() <= LATE_ANSWER_MAX_AGE_MS

  if (quotedWamid) {
    const { data: quotedRow } = await supabase
      .from('whatsapp_messages')
      .select('inbox_item_id')
      .eq('wamid', quotedWamid)
      .not('inbox_item_id', 'is', null)
      .limit(1)
      .maybeSingle()
    const quotedItemId = (quotedRow as { inbox_item_id: string | null } | null)?.inbox_item_id
    if (quotedItemId) {
      // Quoting the very question that is open: an ordinary answer, not late.
      if (pending && pending.inboxItemId === quotedItemId) {
        return { ...pending, late: false }
      }
      const quoted = [...(context.recent_questions ?? [])]
        .filter((q) => isTextAnswerable(q) && withinWindow(q) && q.inbox_item_id === quotedItemId)
        .sort((a, b) => new Date(b.asked_at).getTime() - new Date(a.asked_at).getTime())[0]
      if (quoted && isTextAnswerable(quoted)) {
        return {
          type: quoted.type,
          inboxItemId: quoted.inbox_item_id,
          late: true,
          followUp: quoted.status === 'answered',
        }
      }
    }
  }

  if (pending) return { ...pending, late: false }

  const recent = (context.recent_questions ?? []).filter(
    (q): q is RecentQuestion & { type: TextAnswerableQuestionType } =>
      isTextAnswerable(q) && q.status !== 'answered' && withinWindow(q),
  )

  if (recent.length > 0) {
    const latest = [...recent].sort(
      (a, b) => new Date(b.asked_at).getTime() - new Date(a.asked_at).getTime(),
    )[0]
    return { type: latest.type, inboxItemId: latest.inbox_item_id, late: true }
  }

  return null
}

/** Mark one recent-question entry with a new status (pure helper). */
export function markRecentQuestion(
  context: ConversationContext,
  inboxItemId: string,
  status: RecentQuestion['status'],
): RecentQuestion[] {
  return (context.recent_questions ?? []).map((q) =>
    q.inbox_item_id === inboxItemId ? { ...q, status } : q,
  )
}

/** Append an asked question to the recent log, pruning entries beyond 7 days
 *  and capping the log at 10 entries. */
export function appendRecentQuestion(
  context: ConversationContext,
  entry: RecentQuestion,
  now: Date = new Date(),
): RecentQuestion[] {
  const kept = (context.recent_questions ?? []).filter(
    (q) => now.getTime() - new Date(q.asked_at).getTime() <= LATE_ANSWER_MAX_AGE_MS,
  )
  return [...kept, entry].slice(-10)
}

/**
 * Legacy recipient read: rows persisted before the raw payload was redacted
 * still carry the sender's plaintext number under `from`. New rows do not,
 * so this returns null for them and the caller decrypts the phone link.
 */
export function extractRecipient(row: WhatsAppMessage): string | null {
  const raw = row.raw_payload as { from?: unknown } | null
  return raw && typeof raw.from === 'string' && raw.from.length > 0 ? raw.from : null
}

/**
 * The recipient phone (E.164 digits) for replies.
 *
 * The authoritative copy is whatsapp_phone_links.phone_enc (AES-256-GCM):
 * persisting the plaintext number in every message's raw_payload defeated the
 * whole point of encrypting it once on the link. Falls back to the legacy
 * raw_payload copy for rows written before the redaction.
 */
export function resolveRecipient(
  row: WhatsAppMessage,
  link: { phone_enc?: string | null } | null,
): string | null {
  const legacy = extractRecipient(row)
  if (legacy) return legacy
  if (!link?.phone_enc) return null
  try {
    const phone = decryptPhone(link.phone_enc)
    return phone.length > 0 ? phone : null
  } catch (err) {
    // Shredded (retention/erasure sets phone_enc = '') or a key rotation:
    // there is no one left to reply to, and that must not throw here.
    log.warn('could not decrypt phone link for reply', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** Strip the sender's plaintext phone number out of the payload we persist.
 *  Everything else (type, timestamp, quoted context.id) is kept verbatim. */
export function redactRawPayload(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const { from: _from, ...rest } = raw as Record<string, unknown>
  return rest
}
