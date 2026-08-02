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
 * Concurrency note: context is read-modify-write via PostgREST. Single-writer
 * discipline keeps that safe: only the burst-ack winner, the answer worker,
 * the company-choice handler and the sweep write it, and the pending_ack /
 * processing_status claims serialize them. Media staging deliberately does
 * NOT go through context (staged refs live as whatsapp_messages rows) so
 * parallel webhook invocations never race on this column.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { WhatsAppConversation, WhatsAppMessage } from '@/types'

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
  return { day_key: dayKey, count: current + asked }
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
}

const TEXT_ANSWERABLE: ReadonlySet<string> = new Set(['representation', 'context'])

/**
 * Resolve which question a free-text message answers.
 *
 * 1. An awaiting_representation/awaiting_context state answers its own
 *    pending question.
 * 2. Otherwise a quoted reply (context.message_id -> whatsapp_messages.wamid,
 *    either direction) resolves through that row's inbox_item_id.
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

  if (
    (conversation.state === 'awaiting_representation' ||
      conversation.state === 'awaiting_context') &&
    context.pending_question &&
    TEXT_ANSWERABLE.has(context.pending_question.type) &&
    context.pending_question.inbox_item_id
  ) {
    return {
      type: context.pending_question.type as TextAnswerableQuestionType,
      inboxItemId: context.pending_question.inbox_item_id,
      late: false,
    }
  }

  const recent = (context.recent_questions ?? []).filter(
    (q): q is RecentQuestion & { type: TextAnswerableQuestionType } =>
      TEXT_ANSWERABLE.has(q.type) &&
      q.status !== 'answered' &&
      now.getTime() - new Date(q.asked_at).getTime() <= LATE_ANSWER_MAX_AGE_MS,
  )

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
      const match = recent.find((q) => q.inbox_item_id === quotedItemId)
      if (match) return { type: match.type, inboxItemId: match.inbox_item_id, late: true }
    }
  }

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

/** The recipient phone (E.164 digits) for replies, read back from the
 *  persisted raw payload (the row never stores the raw number elsewhere). */
export function extractRecipient(row: WhatsAppMessage): string | null {
  const raw = row.raw_payload as { from?: unknown } | null
  return raw && typeof raw.from === 'string' && raw.from.length > 0 ? raw.from : null
}
