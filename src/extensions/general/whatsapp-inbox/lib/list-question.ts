/**
 * The question list in the chat. An open question from a company's question
 * list (company_questions, src/lib/questions) is sent to a linked person as
 * one message with reply buttons, and their tap or their written reply
 * answers it through the path the app uses (answerAsPerson, closeAsPerson),
 * with the door recorded as whatsapp.
 *
 * In this extension such a question is a "list question". The "company
 * question" of company-question.ts is something else: the choice of which
 * company a receipt belongs to.
 *
 * A list question is sent only when all of this holds (sendListQuestion):
 *   - the question list is switched on for the question's company, the
 *     company is not archived, and the question is open;
 *   - the person is owner, admin or member of that company;
 *   - their phone link is active and not paused;
 *   - the 24 hour service window is open;
 *   - nothing else is in flight in the conversation: no receipt question, none
 *     queued, no company choice, no other list question, no burst waiting for
 *     its ack;
 *   - fewer than MAX_QUESTIONS_PER_DAY questions were asked there today,
 *     receipt questions and list questions together;
 *   - after a burst and after the last receipt question of one: the burst
 *     has a question left of its MAX_QUESTIONS_PER_BURST
 *     (context.list_question_slots).
 * The conversation does not have to be routed to the question's company.
 *
 * Which question (nextQuestionFor): the open questions of every company the
 * person keeps the books of, those of the company the conversation is routed
 * to (routing.ts) first when there is one, then the rest, the oldest first,
 * leaving out what expired in this conversation. A person who keeps the
 * books of more than one company gets the company's name on the first line
 * of the message.
 *
 * Four moments: a question is filed (offerFiledListQuestion); a burst of
 * receipts has its ack and its own questions are done
 * (offerListQuestionAfterBurst, offerListQuestionWhenDone); the person
 * writes a text that nothing else takes, in place of the fallback reply
 * (offerListQuestionOnText); and a list question is answered or closed in
 * the chat, after its acknowledgement (answerListQuestion). The two burst
 * moments stay with the company the conversation is routed to, the one the
 * receipts went to. The last two need no burst slot.
 *
 * State: the question in flight is context.pending_question with type
 * 'list_question', on a conversation that stays idle. A receipt question or
 * a company choice that comes after takes the slot as it does on any idle
 * conversation. A sent list question is counted on its own daily counter
 * (context.list_question_budget), never on the receipt questions'. The
 * state is written before the send and taken back when the send fails.
 * QUESTION_TTL_MS after it was sent the question expires here: nothing is
 * sent, it stays open on the list, and it is not sent in this conversation
 * again (context.list_questions_expired).
 *
 * A written reply: the webhook marks the inbound row with the question it
 * answers (listQuestionReplyMarker, in error_message while the row waits),
 * and the worker answers that question from the marker, whatever happened to
 * the conversation in between. When a reply reader is configured for the
 * question's company (src/lib/questions/reply-reader.ts), the worker hands
 * it the question and the reply first (readWrittenReply): "answer" saves the
 * reply as written, "dont_know" closes the question, and "later",
 * "question_back" and "other" leave it open and in flight with one reply to
 * the person and no next question (replyToOpenQuestion). Without a reader,
 * and without a usable reading, the reply is the answer as written.
 *
 * The plaintext phone is never stored: it is decrypted from the link for the
 * send only. Asked, answered and expired go to processing_history.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isBookkeepingWriterRole } from '@/lib/auth/invoicer-role'
import { companyQuestionsRollout, isCompanyQuestionsEnabled } from '@/lib/env/company-questions-switch'
import { isUuid } from '@/lib/invariants/uuid'
import { createLogger } from '@/lib/logger'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { APP_ANSWER_MAX, WHATSAPP_DOOR, answerAsPerson, closeAsPerson } from '@/lib/questions/app-answer'
import { listOpenQuestionsAcross, type OpenQuestionOfCompany } from '@/lib/questions/list'
import { hasReplyReader, readReply, type ReplyReading } from '@/lib/questions/reply-reader'
import { readQuestionRow, toQuestion } from '@/lib/questions/rows'
import type { CompanyQuestion } from '@/lib/questions/types'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { WhatsAppConversation, WhatsAppPhoneLink } from '@/types'
import {
  INTERACTIVE_BODY_MAX,
  sendReplyButtons,
  sendText,
  type ChoiceOption,
  type SendMessageBase,
} from './graph-api'
import { botCopy, TEMPLATE, type BotLocale } from './messages'
import {
  LIST_QUESTION,
  MAX_QUESTIONS_PER_BURST,
  MAX_QUESTIONS_PER_DAY,
  QUESTION_TTL_MS,
  bumpBudget,
  getContext,
  linkRecipient,
  loadConversation,
  questionsAskedToday,
  serviceWindowOpen,
  updateConversation,
  type ConversationContext,
} from './conversation'
import { resolveRoutedCompany } from './routing'

const log = createLogger('whatsapp-inbox/list-question')

/** A question with at most this many options also gets the "Vet inte" button (three buttons fit). */
const DONT_KNOW_BUTTON_MAX_OPTIONS = 2

/** A written reply that is exactly this (trimmed, any case) closes the question as dont_know. */
const DONT_KNOW_REPLY = 'vet inte'

/** Expired list questions a conversation remembers. */
const EXPIRED_MEMORY = 20

/** Conversations read per scan (the expiry pass, a question ended elsewhere). */
const SCAN_LIMIT = 50

/** User ids per `in` filter when the links of a company's members are read. */
const USER_ID_CHUNK = 100

type ReplyBase = Omit<SendMessageBase, 'to' | 'template'>

// ── Button ids ───────────────────────────────────────────────

const BUTTON_PREFIX = 'cq:'
const UUID_LENGTH = 36

/** A tap on one of a list question's buttons: an option, or "Vet inte". */
export type QuestionTap =
  | { companyId: string; questionId: string; kind: 'option'; optionId: string }
  | { companyId: string; questionId: string; kind: 'dont_know' }

/**
 * The id of a list question's reply button:
 *   cq:<company id>:<question id>:o:<option id>   an option
 *   cq:<company id>:<question id>:k               "Vet inte"
 * A company choice button carries a bare company id, so the prefix tells the
 * two apart.
 */
export function questionButtonId(companyId: string, questionId: string, optionId: string | null): string {
  const head = `${BUTTON_PREFIX}${companyId}:${questionId}`
  return optionId === null ? `${head}:k` : `${head}:o:${optionId}`
}

/** The tap a button id stands for, or null when it is not a list question's button. */
export function parseQuestionButtonId(id: string | null | undefined): QuestionTap | null {
  if (typeof id !== 'string' || !id.startsWith(BUTTON_PREFIX)) return null
  const companyStart = BUTTON_PREFIX.length
  const questionStart = companyStart + UUID_LENGTH + 1
  const restStart = questionStart + UUID_LENGTH + 1
  const companyId = id.slice(companyStart, companyStart + UUID_LENGTH)
  const questionId = id.slice(questionStart, questionStart + UUID_LENGTH)
  if (!isUuid(companyId) || !isUuid(questionId)) return null
  if (id[questionStart - 1] !== ':' || id[restStart - 1] !== ':') return null
  const rest = id.slice(restStart)
  if (rest === 'k') return { companyId, questionId, kind: 'dont_know' }
  if (rest.startsWith('o:') && rest.length > 2) return { companyId, questionId, kind: 'option', optionId: rest.slice(2) }
  return null
}

// ── The question in flight ───────────────────────────────────

export interface PendingListQuestion {
  questionId: string
  companyId: string
  askedAt: string
}

/** The list question in the conversation's slot, whatever its age. */
function listQuestionOf(context: ConversationContext): PendingListQuestion | null {
  const pending = context.pending_question
  if (!pending || pending.type !== LIST_QUESTION || !pending.question_id || !pending.company_id) return null
  return { questionId: pending.question_id, companyId: pending.company_id, askedAt: pending.asked_at }
}

function isExpired(pending: PendingListQuestion, now: Date): boolean {
  return now.getTime() - new Date(pending.askedAt).getTime() > QUESTION_TTL_MS
}

/**
 * The list question a written reply answers: in flight on an idle
 * conversation, inside its 48 hours, and of a company the question list is
 * still switched on for.
 */
export function pendingListQuestion(
  conversation: WhatsAppConversation,
  now: Date = new Date(),
): PendingListQuestion | null {
  if (conversation.state !== 'idle') return null
  const pending = listQuestionOf(getContext(conversation))
  if (!pending || isExpired(pending, now)) return null
  return isCompanyQuestionsEnabled(pending.companyId) ? pending : null
}

function rememberExpired(context: ConversationContext, questionId: string): string[] {
  const kept = (context.list_questions_expired ?? []).filter((id) => id !== questionId)
  return [...kept, questionId].slice(-EXPIRED_MEMORY)
}

/** No receipt question, none queued, no company choice, no burst waiting for its ack, and no list question inside its 48 hours. */
function nothingInFlight(conversation: WhatsAppConversation, context: ConversationContext, now: Date): boolean {
  if (conversation.state !== 'idle' || conversation.pending_ack) return false
  if ((context.company_options?.length ?? 0) > 0) return false
  if ((context.question_queue?.length ?? 0) > 0) return false
  if (!context.pending_question) return true
  const listQuestion = listQuestionOf(context)
  return listQuestion !== null && isExpired(listQuestion, now)
}

/** Questions asked in the conversation today: receipt questions and list questions together. */
function askedToday(context: ConversationContext, now: Date): number {
  return questionsAskedToday(context, now) + questionsAskedToday(context, now, 'list_question_budget')
}

/**
 * What the link and the conversation say, without a query: the link is
 * active and not paused, the service window is open, nothing else is in
 * flight, the day has a question left and, after a burst, so has the burst.
 */
export function conversationTakesListQuestion(
  conversation: WhatsAppConversation,
  link: Pick<WhatsAppPhoneLink, 'revoked_at' | 'muted_at'>,
  opts: { usesBurstSlot: boolean; now?: Date },
): boolean {
  const now = opts.now ?? new Date()
  const context = getContext(conversation)
  if (link.revoked_at != null || link.muted_at != null) return false
  if (!serviceWindowOpen(conversation, now)) return false
  if (!nothingInFlight(conversation, context, now)) return false
  if (askedToday(context, now) >= MAX_QUESTIONS_PER_DAY) return false
  if (opts.usesBurstSlot && (context.list_question_slots ?? 0) <= 0) return false
  return true
}

/**
 * Whether the person keeps the books of the company: a membership with a
 * bookkeeping role in a company that is not archived. Null when the read
 * failed.
 */
async function keepsTheBooks(supabase: SupabaseClient, userId: string, companyId: string): Promise<boolean | null> {
  const { data, error } = await supabase
    .from('company_members')
    .select('role, companies!inner(archived_at)')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .is('companies.archived_at', null)
    .limit(1)
    .maybeSingle()
  if (error) {
    log.warn('membership read failed', { companyId, error: error.message })
    return null
  }
  return isBookkeepingWriterRole((data as { role?: string | null } | null)?.role)
}

/** A company the person keeps the books of. */
interface BookkeptCompany {
  id: string
  /** Null when the company has no name on record. */
  name: string | null
}

/**
 * The companies the person keeps the books of: owner, admin or member of a
 * company that is not archived. Throws when the read fails.
 */
async function bookkeptCompanies(supabase: SupabaseClient, userId: string): Promise<BookkeptCompany[]> {
  type Named = { name: string | null }
  const rows = await fetchAllRows<{ company_id: string; role: string | null; companies: Named | Named[] | null }>(({ from, to }) =>
    supabase
      .from('company_members')
      .select('company_id, role, companies!inner(name, archived_at)')
      .eq('user_id', userId)
      .is('companies.archived_at', null)
      .order('company_id', { ascending: true })
      .range(from, to),
  )
  const companies = new Map<string, BookkeptCompany>()
  for (const row of rows) {
    if (!isBookkeepingWriterRole(row.role)) continue
    const company = Array.isArray(row.companies) ? row.companies[0] : row.companies
    companies.set(row.company_id, { id: row.company_id, name: company?.name?.trim() || null })
  }
  return [...companies.values()]
}

/**
 * The company's name as the question message shows it: only for a person who
 * keeps the books of more than one company.
 */
function companyNameFor(companies: readonly BookkeptCompany[], companyId: string): string | null {
  if (companies.length <= 1) return null
  return companies.find((company) => company.id === companyId)?.name ?? null
}

// ── History ──────────────────────────────────────────────────

async function appendListQuestionHistory(args: {
  companyId: string
  questionId: string
  eventType: 'ChannelQuestionAsked' | 'ChannelQuestionAnswered' | 'ChannelQuestionExpired'
  correlationId?: string | null
}): Promise<void> {
  try {
    await appendProcessingHistory({
      companyId: args.companyId,
      correlationId: args.correlationId ?? args.questionId,
      aggregateType: 'System',
      aggregateId: args.questionId,
      eventType: args.eventType,
      payload: { channel: 'whatsapp', question_id: args.questionId, question_type: LIST_QUESTION },
      actor: { type: 'system', id: 'whatsapp-inbound' },
      occurredAt: new Date(),
    })
  } catch (err: unknown) {
    log.error('list question history append failed', err, { questionId: args.questionId })
  }
}

// ── Sending ──────────────────────────────────────────────────

/**
 * The body of a list question's message: the company's name in bold on the
 * first line when one is given, the question, why it is asked on a line of
 * its own, then the closing line saying a written answer is welcome. When
 * all of it is longer than an interactive body holds, the why is left out
 * first, then the closing line. The question and the company's name are
 * never cut or left out.
 */
export function listQuestionBody(
  question: Pick<CompanyQuestion, 'question' | 'why'>,
  opts: { company?: string | null; locale?: BotLocale } = {},
): string {
  const copy = botCopy(opts.locale ?? 'sv')
  const kept = { question: question.question, company: opts.company ?? null }
  const whole = copy.m23ListQuestion({ ...kept, why: question.why })
  if (whole.length <= INTERACTIVE_BODY_MAX) return whole
  const withoutWhy = copy.m23ListQuestion({ ...kept, why: null })
  if (withoutWhy.length <= INTERACTIVE_BODY_MAX) return withoutWhy
  return copy.m23ListQuestion({ ...kept, why: null, closing: false })
}

/** The question's options in order, then "Vet inte" when a button is left for it. */
function questionButtons(companyId: string, question: CompanyQuestion): ChoiceOption[] {
  const buttons: ChoiceOption[] = question.options.map((option) => ({
    id: questionButtonId(companyId, question.question_id, option.id),
    title: option.label,
  }))
  if (question.options.length <= DONT_KNOW_BUTTON_MAX_OPTIONS) {
    buttons.push({ id: questionButtonId(companyId, question.question_id, null), title: botCopy('sv').m23ListDontKnow() })
  }
  return buttons
}

/**
 * How an attempt to send a list question ended:
 *  - sent: the question went out and the conversation holds it;
 *  - not_sent: a condition did not hold, or no question was there to send;
 *    nothing was sent and the conversation is as it was;
 *  - send_failed: every condition held, the send failed and the conversation
 *    was put back as it was.
 */
export type ListQuestionOffer = 'sent' | 'not_sent' | 'send_failed'

interface SendListQuestionArgs {
  conversation: WhatsAppConversation
  link: WhatsAppPhoneLink
  question: CompanyQuestion
  /** The company whose list the question is on. */
  companyId: string
  /** The company's name for the first line of the message; null leaves the line out (companyNameFor). */
  companyName: string | null
  /** After a burst: the question takes one of the burst's slots. */
  usesBurstSlot: boolean
  now: Date
}

/**
 * Sends one list question when every condition in the file header holds, and
 * says how it ended. The conversation holds the question before the send; a
 * failed send takes it back, with its count against the day and the burst.
 */
export async function sendListQuestion(supabase: SupabaseClient, args: SendListQuestionArgs): Promise<ListQuestionOffer> {
  const { conversation, link, question, companyId, usesBurstSlot, now } = args
  if (!isCompanyQuestionsEnabled(companyId) || question.status !== 'open') return 'not_sent'
  if (!conversationTakesListQuestion(conversation, link, { usesBurstSlot, now })) return 'not_sent'
  if ((await keepsTheBooks(supabase, link.user_id, companyId)) !== true) return 'not_sent'
  const to = linkRecipient(link)
  if (!to) return 'not_sent'

  const questionId = question.question_id
  const askedAt = now.toISOString()
  const committed = await updateConversation(supabase, conversation, (current, context) => {
    if (!conversationTakesListQuestion(current, link, { usesBurstSlot, now })) return null
    const next: ConversationContext = {
      ...context,
      pending_question: {
        type: LIST_QUESTION,
        inbox_item_id: null,
        asked_at: askedAt,
        question_id: questionId,
        company_id: companyId,
      },
      list_question_budget: bumpBudget(context, 1, now, 'list_question_budget'),
    }
    // Only an expired list question can still be in the slot here.
    const replaced = listQuestionOf(context)
    if (replaced && replaced.questionId !== questionId) {
      next.list_questions_expired = rememberExpired(context, replaced.questionId)
    }
    if (usesBurstSlot) next.list_question_slots = Math.max(0, (context.list_question_slots ?? 0) - 1)
    return { context: next, last_outbound_at: askedAt }
  })
  if (!committed) return 'not_sent'

  const sent = await sendReplyButtons(supabase, {
    to,
    template: TEMPLATE.m23ListQuestion,
    body: listQuestionBody(question, { company: args.companyName }),
    buttons: questionButtons(companyId, question),
    senderPhoneHash: link.phone_hash,
    phoneLinkId: link.id,
    conversationId: conversation.id,
  })

  if (!sent.ok) {
    await updateConversation(supabase, committed, (_current, context) => {
      const pending = listQuestionOf(context)
      if (!pending || pending.questionId !== questionId || pending.askedAt !== askedAt) return null
      const rolledBack: ConversationContext = {
        ...context,
        list_question_budget: bumpBudget(context, -1, now, 'list_question_budget'),
      }
      delete rolledBack.pending_question
      if (usesBurstSlot) rolledBack.list_question_slots = (context.list_question_slots ?? 0) + 1
      return { context: rolledBack }
    })
    log.warn('list question send failed; the question was taken back', {
      conversationId: conversation.id,
      questionId,
      failure: sent.failure,
    })
    return 'send_failed'
  }

  await appendListQuestionHistory({ companyId, questionId, eventType: 'ChannelQuestionAsked' })
  return 'sent'
}

// ── The moments ──────────────────────────────────────────────

function listIsOnForNobody(): boolean {
  const rollout = companyQuestionsRollout()
  return rollout !== 'all' && rollout.length === 0
}

async function loadConversationWithLink(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<{ conversation: WhatsAppConversation; link: WhatsAppPhoneLink } | null> {
  const conversation = await loadConversation(supabase, conversationId)
  if (!conversation) return null
  const { data } = await supabase
    .from('whatsapp_phone_links')
    .select('*')
    .eq('id', conversation.phone_link_id)
    .maybeSingle()
  const link = (data as WhatsAppPhoneLink | null) ?? null
  return link ? { conversation, link } : null
}

/** A question to send, with the name its message starts with. */
interface NextQuestion {
  companyId: string
  question: CompanyQuestion
  companyName: string | null
}

/** The questions of the routed company first, then the rest; each part keeps its order, the oldest first. */
function routedFirst(open: readonly OpenQuestionOfCompany[], routedCompanyId: string | null): OpenQuestionOfCompany[] {
  return [
    ...open.filter((entry) => entry.companyId === routedCompanyId),
    ...open.filter((entry) => entry.companyId !== routedCompanyId),
  ]
}

/**
 * The next question for the person, or null when there is none. Taken from
 * the companies they keep the books of that have the question list switched
 * on: with `scope` 'all' from every one of them, the routed company's first,
 * with 'routed' from the routed company alone. A question that expired in
 * this conversation, or sits expired in its slot, is passed by.
 */
async function nextQuestionFor(
  supabase: SupabaseClient,
  conversation: WhatsAppConversation,
  link: WhatsAppPhoneLink,
  scope: 'all' | 'routed',
  now: Date,
): Promise<NextQuestion | null> {
  const companies = await bookkeptCompanies(supabase, link.user_id)
  const withList = companies.filter((company) => isCompanyQuestionsEnabled(company.id))
  if (withList.length === 0) return null

  // With one company to choose from and no restriction to the routed one, the routing decides nothing.
  let routedCompanyId: string | null = null
  if (scope === 'routed' || withList.length > 1) {
    const routed = await resolveRoutedCompany(supabase, link, conversation, now)
    routedCompanyId = routed === 'transient_error' || routed === null ? null : routed.companyId
  }
  const from = scope === 'routed' ? withList.filter((company) => company.id === routedCompanyId) : withList
  if (from.length === 0) return null

  const open = await listOpenQuestionsAcross(
    supabase,
    from.map((company) => company.id),
  )
  const context = getContext(conversation)
  const expiredHere = new Set(context.list_questions_expired ?? [])
  const inSlot = listQuestionOf(context)
  if (inSlot) expiredHere.add(inSlot.questionId)
  const next = routedFirst(open, routedCompanyId).find((entry) => !expiredHere.has(entry.question.question_id))
  return next ? { ...next, companyName: companyNameFor(companies, next.companyId) } : null
}

/**
 * Sends the next question for the person (nextQuestionFor). After a burst it
 * goes against one of the burst's slots and stays with the routed company.
 */
async function offerNextListQuestion(
  supabase: SupabaseClient,
  conversation: WhatsAppConversation,
  link: WhatsAppPhoneLink,
  usesBurstSlot: boolean,
): Promise<ListQuestionOffer> {
  const now = new Date()
  if (!conversationTakesListQuestion(conversation, link, { usesBurstSlot, now })) return 'not_sent'
  const next = await nextQuestionFor(supabase, conversation, link, usesBurstSlot ? 'routed' : 'all', now)
  if (!next) return 'not_sent'
  return sendListQuestion(supabase, {
    conversation,
    link,
    question: next.question,
    companyId: next.companyId,
    companyName: next.companyName,
    usesBurstSlot,
    now,
  })
}

/**
 * A burst of receipts has its ack. The conversation records how many list
 * questions the burst leaves room for (MAX_QUESTIONS_PER_BURST less the
 * receipt questions it admitted), and the oldest open one of the routed
 * company is sent when nothing else is in flight. Reads nothing unless the
 * list is switched on for a company the burst filed into. Never throws.
 */
export async function offerListQuestionAfterBurst(
  supabase: SupabaseClient,
  conversationId: string,
  burst: { admitted: number; companyIds: readonly (string | null)[] },
): Promise<void> {
  try {
    if (!burst.companyIds.some((companyId) => isCompanyQuestionsEnabled(companyId))) return
    const loaded = await loadConversationWithLink(supabase, conversationId)
    if (!loaded) return
    const slots = Math.max(0, MAX_QUESTIONS_PER_BURST - burst.admitted)
    const recorded = await updateConversation(supabase, loaded.conversation, (_current, context) =>
      (context.list_question_slots ?? 0) === slots ? null : { context: { ...context, list_question_slots: slots } },
    )
    await offerNextListQuestion(supabase, recorded ?? loaded.conversation, loaded.link, true)
  } catch (err: unknown) {
    log.warn('list question after a burst failed', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * The conversation's receipt questions are done: one was answered and none
 * waits. The next open list question of the routed company is sent when the
 * latest burst has a slot left. Reads nothing unless the list is switched on
 * for some company. Never throws.
 */
export async function offerListQuestionWhenDone(supabase: SupabaseClient, conversationId: string): Promise<void> {
  try {
    if (listIsOnForNobody()) return
    const loaded = await loadConversationWithLink(supabase, conversationId)
    if (!loaded) return
    await offerNextListQuestion(supabase, loaded.conversation, loaded.link, true)
  } catch (err: unknown) {
    log.warn('list question after the last answer failed', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Sends the next open list question of any company the person keeps the
 * books of, with no burst slot, when every other condition in the file
 * header holds, read off the conversation and its phone link as they stand
 * now (a stop may have come in meanwhile). Says how it ended; a read that
 * fails ends as not_sent. Reads nothing unless the list is switched on for
 * some company. Never throws.
 */
async function offerNextWithoutSlot(
  supabase: SupabaseClient,
  conversationId: string,
  moment: 'text' | 'answer',
): Promise<ListQuestionOffer> {
  try {
    if (listIsOnForNobody()) return 'not_sent'
    const loaded = await loadConversationWithLink(supabase, conversationId)
    if (!loaded) return 'not_sent'
    return await offerNextListQuestion(supabase, loaded.conversation, loaded.link, false)
  } catch (err: unknown) {
    log.warn('the next list question was not sent', {
      moment,
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return 'not_sent'
  }
}

/**
 * The person wrote a text that nothing else takes (no keyword, no answer to
 * a question): the fallback reply would be next. The next open list question
 * of a company they keep the books of is sent in its place, with no burst
 * slot, read off the conversation as it stands after that text. The text
 * itself answers nothing. Says how it ended. Never throws.
 */
export function offerListQuestionOnText(supabase: SupabaseClient, conversationId: string): Promise<ListQuestionOffer> {
  return offerNextWithoutSlot(supabase, conversationId, 'text')
}

/** The active, unpaused links of the company's members with a bookkeeping role. */
async function bookkeeperLinks(supabase: SupabaseClient, companyId: string): Promise<WhatsAppPhoneLink[]> {
  const { data: members, error: membersError } = await supabase
    .from('company_members')
    .select('user_id, role')
    .eq('company_id', companyId)
  if (membersError) throw new Error(`company members could not be read: ${membersError.message}`)
  const userIds = [
    ...new Set(
      ((members ?? []) as { user_id: string; role: string | null }[])
        .filter((member) => isBookkeepingWriterRole(member.role))
        .map((member) => member.user_id),
    ),
  ]

  const links: WhatsAppPhoneLink[] = []
  for (let at = 0; at < userIds.length; at += USER_ID_CHUNK) {
    const { data, error } = await supabase
      .from('whatsapp_phone_links')
      .select('*')
      .in('user_id', userIds.slice(at, at + USER_ID_CHUNK))
      .is('revoked_at', null)
      .is('muted_at', null)
    if (error) throw new Error(`phone links could not be read: ${error.message}`)
    links.push(...((data ?? []) as WhatsAppPhoneLink[]))
  }
  return links
}

/**
 * A question was filed for the company. It is sent to every member the
 * conditions hold for, whatever company their conversation is routed to;
 * whoever answers first ends it for the others. Never throws.
 */
export async function offerFiledListQuestion(
  supabase: SupabaseClient,
  filed: { companyId: string; questionId: string },
): Promise<void> {
  try {
    if (!isCompanyQuestionsEnabled(filed.companyId)) return
    const links = await bookkeeperLinks(supabase, filed.companyId)
    if (links.length === 0) return

    const { data: conversationRows, error: conversationsError } = await supabase
      .from('whatsapp_conversations')
      .select('*')
      .in(
        'phone_link_id',
        links.map((link) => link.id),
      )
    if (conversationsError) throw new Error(`conversations could not be read: ${conversationsError.message}`)
    const byLink = new Map<string, WhatsAppConversation>()
    for (const conversation of (conversationRows ?? []) as WhatsAppConversation[]) {
      byLink.set(conversation.phone_link_id, conversation)
    }

    const now = new Date()
    const open: { link: WhatsAppPhoneLink; conversation: WhatsAppConversation }[] = []
    for (const link of links) {
      const conversation = byLink.get(link.id)
      if (conversation && conversationTakesListQuestion(conversation, link, { usesBurstSlot: false, now })) {
        open.push({ link, conversation })
      }
    }
    if (open.length === 0) return

    const question = toQuestion(await readQuestionRow(supabase, filed.companyId, filed.questionId))
    for (const { link, conversation } of open) {
      try {
        const companies = await bookkeptCompanies(supabase, link.user_id)
        await sendListQuestion(supabase, {
          conversation,
          link,
          question,
          companyId: filed.companyId,
          companyName: companyNameFor(companies, filed.companyId),
          usesBurstSlot: false,
          now,
        })
      } catch (err: unknown) {
        log.warn('a filed question was not sent to one of the members', {
          companyId: filed.companyId,
          questionId: filed.questionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } catch (err: unknown) {
    log.warn('a filed question was not sent', {
      companyId: filed.companyId,
      questionId: filed.questionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ── Replies ──────────────────────────────────────────────────

const REPLY_MARKER_PREFIX = 'list_question_reply:'

/** The question a written reply answers, and the company whose list it is on. */
export interface ListQuestionRef {
  companyId: string
  questionId: string
}

/**
 * The marker the webhook puts on an inbound text row it read as the reply to
 * a list question: `list_question_reply:<company id>:<question id>`. It sits
 * in error_message while the row waits for the worker; the row's terminal
 * status replaces it.
 */
export function listQuestionReplyMarker(question: ListQuestionRef): string {
  return `${REPLY_MARKER_PREFIX}${question.companyId}:${question.questionId}`
}

/** The question a row's marker names, or null when the row carries none. */
export function parseListQuestionReplyMarker(marker: string | null | undefined): ListQuestionRef | null {
  if (typeof marker !== 'string' || !marker.startsWith(REPLY_MARKER_PREFIX)) return null
  const [companyId, questionId, ...rest] = marker.slice(REPLY_MARKER_PREFIX.length).split(':')
  if (rest.length > 0 || !isUuid(companyId) || !isUuid(questionId)) return null
  return { companyId, questionId }
}

type ListAnswer = { optionId: string } | { text: string } | { dontKnow: true }

/** Takes the question out of the conversation's slot when it is the one in it. */
async function clearListQuestion(
  supabase: SupabaseClient,
  conversation: WhatsAppConversation,
  questionId: string,
): Promise<void> {
  await updateConversation(supabase, conversation, (_current, context) => {
    if (listQuestionOf(context)?.questionId !== questionId) return null
    const next: ConversationContext = { ...context }
    delete next.pending_question
    return { context: next }
  })
}

function refusalCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

/** Refusals that say the question is no longer there to answer: it leaves the conversation, and nothing is said. */
const GONE_REFUSALS: ReadonlySet<string> = new Set(['COMPANY_QUESTION_NOT_FOUND', 'COMPANY_QUESTIONS_OFF'])

interface AnswerListQuestionArgs {
  link: WhatsAppPhoneLink
  conversation: WhatsAppConversation | null
  to: string
  replyBase: ReplyBase
  companyId: string
  questionId: string
  answer: ListAnswer
  /** Whether a question found already ended is told to the person. */
  announceEnded: boolean
}

/**
 * Answers or closes the question as the linked person, through the path the
 * app uses, replies with one line, and then sends the next open list
 * question when one may be sent. A question that had already ended is told
 * in one line and nothing is written. Throws what the core path throws
 * beyond its refusals.
 */
async function answerListQuestion(supabase: SupabaseClient, args: AnswerListQuestionArgs): Promise<void> {
  const { link, conversation, companyId, questionId, answer } = args
  const copy = botCopy('sv')
  let closed = false
  try {
    if ('dontKnow' in answer) {
      await closeAsPerson(supabase, {
        companyId,
        questionId,
        reason: 'dont_know',
        userId: link.user_id,
        door: WHATSAPP_DOOR,
      })
      closed = true
    } else {
      await answerAsPerson(supabase, supabase, {
        companyId,
        questionId,
        optionId: 'optionId' in answer ? answer.optionId : null,
        text: 'text' in answer ? answer.text : null,
        userId: link.user_id,
        locale: 'sv',
        door: WHATSAPP_DOOR,
      })
    }
  } catch (error: unknown) {
    const code = refusalCode(error)
    if (code === 'COMPANY_QUESTION_ALREADY_ENDED') {
      if (conversation) await clearListQuestion(supabase, conversation, questionId)
      if (args.announceEnded) {
        await sendText(supabase, { to: args.to, body: copy.m25ListEnded(), template: TEMPLATE.m25ListEnded, ...args.replyBase })
      }
      return
    }
    if (code !== null && GONE_REFUSALS.has(code)) {
      log.warn('list question reply refused', { companyId, questionId, code })
      if (conversation) await clearListQuestion(supabase, conversation, questionId)
      return
    }
    // A reply that names an option the question does not have: dropped, and the question stays as it is.
    if (code === 'VALIDATION_ERROR') {
      log.warn('list question reply refused', { companyId, questionId, code })
      return
    }
    throw error
  }

  if (conversation) await clearListQuestion(supabase, conversation, questionId)
  await appendListQuestionHistory({
    companyId,
    questionId,
    eventType: 'ChannelQuestionAnswered',
    correlationId: args.replyBase.correlationId,
  })
  await sendText(supabase, {
    to: args.to,
    body: closed ? copy.m24ListClosed() : copy.m24ListAnswered(),
    template: closed ? TEMPLATE.m24ListClosed : TEMPLATE.m24ListAnswered,
    ...args.replyBase,
  })
  // The next open list question follows the acknowledgement, with no burst
  // slot. A receipt question in flight or in the queue stays first: nothing
  // is sent then.
  if (conversation) await offerNextWithoutSlot(supabase, conversation.id, 'answer')
}

interface EndedQuestionRow {
  status: string
  close_reason: string | null
  answer_option: string | null
  answered_by: string | null
  answered_via: string | null
}

/** Whether the question already carries exactly what this tap would write, by this person, through this door. */
function isOwnAnswer(row: EndedQuestionRow, tap: QuestionTap, userId: string): boolean {
  if (row.answered_via !== WHATSAPP_DOOR || row.answered_by !== userId) return false
  return tap.kind === 'option'
    ? row.status === 'answered' && row.answer_option === tap.optionId
    : row.status === 'closed' && row.close_reason === 'dont_know'
}

/**
 * A tap on a list question's button: the option answers the question, "Vet
 * inte" closes it as dont_know. Works on any open question of a company the
 * person keeps the books of, in flight here or not. A tap that names another
 * company's question, a missing one or an option the question does not have
 * is dropped without a reply. A second delivery of a tap that was already
 * applied gets the same line again. Throws what the core path throws beyond
 * its refusals.
 */
export async function applyListQuestionTap(
  supabase: SupabaseClient,
  args: {
    link: WhatsAppPhoneLink
    conversation: WhatsAppConversation | null
    tap: QuestionTap
    to: string
    replyBase: ReplyBase
  },
): Promise<void> {
  const { link, tap } = args
  if (!isCompanyQuestionsEnabled(tap.companyId)) return
  if ((await keepsTheBooks(supabase, link.user_id, tap.companyId)) !== true) return

  const { data, error } = await supabase
    .from('company_questions')
    .select('status, close_reason, answer_option, answered_by, answered_via')
    .eq('id', tap.questionId)
    .eq('company_id', tap.companyId)
    .maybeSingle()
  if (error) {
    log.warn('tapped question could not be read', { questionId: tap.questionId, error: error.message })
    return
  }
  const row = data as EndedQuestionRow | null
  if (!row) return

  if (row.status !== 'open') {
    if (args.conversation) await clearListQuestion(supabase, args.conversation, tap.questionId)
    const copy = botCopy('sv')
    if (!isOwnAnswer(row, tap, link.user_id)) {
      await sendText(supabase, { to: args.to, body: copy.m25ListEnded(), template: TEMPLATE.m25ListEnded, ...args.replyBase })
      return
    }
    const closed = tap.kind === 'dont_know'
    await sendText(supabase, {
      to: args.to,
      body: closed ? copy.m24ListClosed() : copy.m24ListAnswered(),
      template: closed ? TEMPLATE.m24ListClosed : TEMPLATE.m24ListAnswered,
      ...args.replyBase,
    })
    return
  }

  await answerListQuestion(supabase, {
    link,
    conversation: args.conversation,
    to: args.to,
    replyBase: args.replyBase,
    companyId: tap.companyId,
    questionId: tap.questionId,
    answer: tap.kind === 'option' ? { optionId: tap.optionId } : { dontKnow: true },
    announceEnded: true,
  })
}

/**
 * What the company's reply reader makes of a written reply to an open
 * question. Null when the reply is taken as written: no reader for the
 * company, a question that is no longer open or cannot be read, or no usable
 * reading. Never throws.
 */
async function readWrittenReply(
  supabase: SupabaseClient,
  question: ListQuestionRef,
  text: string,
): Promise<ReplyReading | null> {
  if (!hasReplyReader(question.companyId)) return null
  try {
    const asked = toQuestion(await readQuestionRow(supabase, question.companyId, question.questionId))
    if (asked.status !== 'open') return null
    return await readReply({
      companyId: question.companyId,
      question: { id: asked.question_id, text: asked.question, why: asked.why, options: asked.options },
      replyText: text,
      locale: 'sv',
    })
  } catch (error: unknown) {
    log.warn('a written reply was not handed to the reply reader', {
      companyId: question.companyId,
      questionId: question.questionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * The one reply to a written reply that leaves its question open and in
 * flight. Nothing about the question or the conversation is written, and no
 * next question follows.
 *   - later: m27, fixed copy.
 *   - question_back: m28, the reader's own reply as readReply cleaned it.
 *   - other: the fallback reply a text gets when no question is in flight.
 * m27 and m28 go out only while the service window is open and fewer than
 * MAX_QUESTIONS_PER_DAY questions were asked in the conversation today;
 * neither is counted as one. A retry of the same message sends nothing.
 */
async function replyToOpenQuestion(
  supabase: SupabaseClient,
  args: { conversation: WhatsAppConversation; to: string; replyBase: ReplyBase; firstAttempt: boolean },
  reading: ReplyReading,
): Promise<void> {
  if (!args.firstAttempt) return
  const copy = botCopy('sv')
  if (reading.kind !== 'later' && reading.kind !== 'question_back') {
    await sendText(supabase, { to: args.to, body: copy.m16Fallback(), template: TEMPLATE.m16Fallback, ...args.replyBase })
    return
  }
  const now = new Date()
  if (!serviceWindowOpen(args.conversation, now)) return
  if (askedToday(getContext(args.conversation), now) >= MAX_QUESTIONS_PER_DAY) return
  if (reading.kind === 'question_back') {
    await sendText(supabase, {
      to: args.to,
      body: copy.m28ListQuestionBack({ reply: reading.reply }),
      template: TEMPLATE.m28ListQuestionBack,
      ...args.replyBase,
    })
    return
  }
  await sendText(supabase, { to: args.to, body: copy.m27ListLater(), template: TEMPLATE.m27ListLater, ...args.replyBase })
}

/**
 * A written reply to a list question (the one the webhook marked the row
 * with). A text over APP_ANSWER_MAX characters is not saved: one line asks
 * for a shorter one and the question stays in flight. A reply that is
 * exactly "vet inte" closes the question as dont_know. Any other reply goes
 * to the company's reply reader when it has one (readWrittenReply): what it
 * reads as an answer is saved as written, "dont_know" closes the question,
 * and the other kinds leave it open with one reply (replyToOpenQuestion).
 * With no reader or no reading the text is the answer as written, with no
 * outside call. Throws what the core path throws beyond its refusals, and
 * when the person's membership cannot be read.
 */
export async function applyListQuestionText(
  supabase: SupabaseClient,
  args: {
    link: WhatsAppPhoneLink
    conversation: WhatsAppConversation
    question: ListQuestionRef
    text: string
    to: string
    replyBase: ReplyBase
    /**
     * False on a retry of the same message: a question found ended is then
     * not told again, and a reply that leaves the question open is not sent
     * again.
     */
    announceEnded: boolean
  },
): Promise<void> {
  const { link, conversation, question } = args
  const text = args.text.trim()
  if (!text) return
  if (text.length > APP_ANSWER_MAX) {
    await sendText(supabase, {
      to: args.to,
      body: botCopy('sv').m26ListAnswerTooLong({ max: APP_ANSWER_MAX }),
      template: TEMPLATE.m26ListAnswerTooLong,
      ...args.replyBase,
    })
    return
  }

  const member = await keepsTheBooks(supabase, link.user_id, question.companyId)
  if (member === null) throw new Error('the membership behind a reply to a list question could not be read')
  if (!member || !isCompanyQuestionsEnabled(question.companyId)) {
    await clearListQuestion(supabase, conversation, question.questionId)
    return
  }

  const typedDontKnow = text.toLowerCase() === DONT_KNOW_REPLY
  const reading = typedDontKnow ? null : await readWrittenReply(supabase, question, text)
  if (reading && reading.kind !== 'answer' && reading.kind !== 'dont_know') {
    await replyToOpenQuestion(
      supabase,
      { conversation, to: args.to, replyBase: args.replyBase, firstAttempt: args.announceEnded },
      reading,
    )
    return
  }

  await answerListQuestion(supabase, {
    link,
    conversation,
    to: args.to,
    replyBase: args.replyBase,
    companyId: question.companyId,
    questionId: question.questionId,
    answer: typedDontKnow || reading?.kind === 'dont_know' ? { dontKnow: true } : { text },
    announceEnded: args.announceEnded,
  })
}

// ── Other doors, and the 48 hours ────────────────────────────

/**
 * The question was answered or closed through some door: it is taken out of
 * every conversation it is in flight in. Nothing is sent. Never throws.
 */
export async function clearEndedListQuestion(supabase: SupabaseClient, questionId: string): Promise<void> {
  try {
    if (!isUuid(questionId)) return
    const { data, error } = await supabase
      .from('whatsapp_conversations')
      .select('*')
      .eq('context->pending_question->>question_id', questionId)
      .limit(SCAN_LIMIT)
    if (error) throw new Error(`conversations could not be read: ${error.message}`)
    for (const conversation of (data ?? []) as WhatsAppConversation[]) {
      await clearListQuestion(supabase, conversation, questionId)
    }
  } catch (err: unknown) {
    log.warn('an ended question was not cleared from its conversations', {
      questionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Takes every list question past its 48 hours out of its conversation, and
 * remembers it there as expired. Sends nothing and leaves the question open
 * on the list. Answers how many expired; throws when the scan cannot be read.
 */
export async function expireListQuestions(supabase: SupabaseClient, now: number): Promise<number> {
  // asked_at is always written by toISOString(), so the stored text sorts as time.
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select('*')
    .eq('context->pending_question->>type', LIST_QUESTION)
    .lt('context->pending_question->>asked_at', new Date(now - QUESTION_TTL_MS).toISOString())
    .limit(SCAN_LIMIT)
  if (error) throw new Error(`pending list questions could not be read: ${error.message}`)

  const at = new Date(now)
  let expired = 0
  for (const conversation of (data ?? []) as WhatsAppConversation[]) {
    const pending = listQuestionOf(getContext(conversation))
    if (!pending || !isExpired(pending, at)) continue
    const written = await updateConversation(supabase, conversation, (_current, context) => {
      const inSlot = listQuestionOf(context)
      if (!inSlot || inSlot.questionId !== pending.questionId || inSlot.askedAt !== pending.askedAt) return null
      const next: ConversationContext = {
        ...context,
        list_questions_expired: rememberExpired(context, pending.questionId),
      }
      delete next.pending_question
      return { context: next }
    })
    if (!written) continue
    await appendListQuestionHistory({
      companyId: pending.companyId,
      questionId: pending.questionId,
      eventType: 'ChannelQuestionExpired',
    })
    expired++
  }
  return expired
}
