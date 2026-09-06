/**
 * The company question (M6): asked when a multi-company sender has no live
 * pin and no default, answered with a reply button, a list row, or a typed
 * digit. The answer pins the conversation's company for 8 sliding hours.
 *
 * While the question is open, the receipt rows are PARKED as
 * whatsapp_messages with processing_status='skipped' and
 * error_message='staged_awaiting_company' (no upload happens: a document
 * cannot enter the company-scoped WORM archive before a company exists).
 * The rows themselves are the staged refs; media stays re-downloadable from
 * Meta for days, so no bytes are stored anywhere else.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { WhatsAppConversation, WhatsAppPhoneLink } from '@/types'
import {
  sendReplyButtons,
  sendList,
  sendText,
  MAX_REPLY_BUTTONS,
  MAX_LIST_ROWS,
  type SendMessageBase,
  type SendTextResult,
} from './graph-api'
import { botCopy, TEMPLATE } from './messages'
import {
  COMPANY_CHOICE_EXPIRED,
  COMPANY_PIN_TTL_MS,
  NO_COMPANY_OPTIONS,
  STAGED_AWAITING_COMPANY,
  STAGED_MEDIA_MAX_AGE_MS,
  getContext,
  updateConversation,
  type ConversationContext,
} from './conversation'

const log = createLogger('whatsapp-inbox/company-question')

/** Defensive ceiling on the numbered text list (>10 companies). */
const MAX_NUMBERED_OPTIONS = 30

/** M19 (no company to file into) is sent at most once per this window per
 *  conversation: every parked row of a burst walks through the no-options
 *  branch, and five photos must not earn five identical replies. */
const NO_OPTIONS_NOTICE_WINDOW_MS = 10 * 60 * 1000

export type CompanyChoiceVia = 'button' | 'list' | 'numbered'

export interface CompanyOption {
  id: string
  name: string
}

type ReplyBase = Omit<SendMessageBase, 'to' | 'template'>

/** All non-archived companies the linked user belongs to, alphabetical
 *  (stable digits). An archived company is not a place receipts can go, and
 *  offering it produced a Meta-rejected payload when it shared its name with
 *  the live one (#1589). Returns null when a query FAILED: a transient DB
 *  error must read as "unknown", never as "no memberships", or the caller
 *  parks receipts behind a question that can never be asked. */
export async function loadCompanyOptions(
  supabase: SupabaseClient,
  userId: string,
): Promise<CompanyOption[] | null> {
  const { data: memberships, error: membershipsError } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', userId)
  if (membershipsError) {
    log.warn('company options membership query failed', { error: membershipsError.message })
    return null
  }
  const companyIds = [...new Set((memberships ?? []).map((m) => m.company_id as string))]
  if (companyIds.length === 0) return []

  const { data: companies, error: companiesError } = await supabase
    .from('companies')
    .select('id, name')
    .in('id', companyIds)
    .is('archived_at', null)
  if (companiesError) {
    log.warn('company options company query failed', { error: companiesError.message })
    return null
  }
  const options = ((companies ?? []) as { id: string; name: string | null }[]).map((c) => ({
    id: c.id,
    name: c.name ?? 'Företag',
  }))
  options.sort((a, b) => a.name.localeCompare(b.name, 'sv'))
  return options.slice(0, MAX_NUMBERED_OPTIONS)
}

/** How an ask attempt ended.
 *  - asked: this caller sent the question; rows stay staged for the answer.
 *  - not_asked: lost the guarded transition or the send failed; the episode
 *    is owned elsewhere (or re-triggers on the next receipt). Rows stay staged.
 *  - no_options: fewer than 2 companies genuinely exist, so no question can
 *    help; the staged rows were re-marked no_company_options and M19 told the
 *    sender to fix the linking in the app. Terminal by design.
 *  - transient_error: the options could not be LOADED (DB error): the caller
 *    must release its row back to 'received' so the sweep retries it. */
export type AskCompanyQuestionOutcome = 'asked' | 'not_asked' | 'no_options' | 'transient_error'

/**
 * Ask the company question ONCE per open episode. The guarded state
 * transition (WHERE state <> 'awaiting_company') makes concurrent workers of
 * one burst produce exactly one M6; losers stage silently.
 *
 * The state is committed BEFORE the send (a fast tap must find it) but rolled
 * back when the send fails: sends are best-effort and never throw, so without
 * the rollback an expired token or a Graph 5xx left the conversation parked on
 * a question the user never received, with the guard suppressing every later
 * ask and the 48h TTL eventually discarding the staged receipts.
 *
 * Send ladder: reply buttons (<=3) or a list (<=10), then the numbered text
 * variant when Meta rejects the interactive payload synchronously (#1589:
 * HTTP 400 "Duplicate button title" and similar payload-shape errors are
 * final for that payload, but plain text still delivers), and only when the
 * text send ALSO fails is the question rolled back. The fallback reuses the
 * M6 template id, so the audit/throttle keys are unchanged, and the answer
 * path is mode-agnostic: a typed digit is accepted whenever company_options
 * are open and is recorded as via='numbered'.
 */
export async function askCompanyQuestion(
  supabase: SupabaseClient,
  args: {
    conversation: WhatsAppConversation
    link: WhatsAppPhoneLink
    to: string
    replyBase: ReplyBase
    /** How many receipts wait on the answer (question body wording). */
    stagedCount: number
  },
): Promise<AskCompanyQuestionOutcome> {
  const options = await loadCompanyOptions(supabase, args.link.user_id)
  if (options === null) return 'transient_error'
  if (options.length < 2) {
    // Genuinely degenerate (a real empty/1-length result, not a query error):
    // the sender has nothing to choose between, so no question can help and
    // nothing will change until they act in the app. The old behavior parked
    // the rows silently forever; instead mark them with a terminal, greppable
    // marker and say so in the chat.
    log.warn('company question requested with fewer than 2 options', {
      conversationId: args.conversation.id,
    })
    await supabase
      .from('whatsapp_messages')
      .update({ error_message: NO_COMPANY_OPTIONS })
      .eq('conversation_id', args.conversation.id)
      .eq('processing_status', 'skipped')
      .eq('error_message', STAGED_AWAITING_COMPANY)
    // One M19 per burst window (same idiom as the M17 rate-limit notice).
    const since = new Date(Date.now() - NO_OPTIONS_NOTICE_WINDOW_MS).toISOString()
    const { data: noticeSent } = await supabase
      .from('whatsapp_messages')
      .select('id')
      .eq('direction', 'outbound')
      .eq('conversation_id', args.conversation.id)
      .eq('raw_payload->>template', TEMPLATE.m19NoCompany)
      .gte('created_at', since)
      .limit(1)
      .maybeSingle()
    if (!noticeSent) {
      await sendText(supabase, {
        to: args.to,
        body: botCopy('sv').m19NoCompany(),
        template: TEMPLATE.m19NoCompany,
        ...args.replyBase,
      })
    }
    return 'no_options'
  }

  const now = new Date()
  const askedAt = now.toISOString()
  const previousState = args.conversation.state
  const context = getContext(args.conversation)
  const nextContext: ConversationContext = {
    ...context,
    company_options: options,
    pending_question: { type: 'company', inbox_item_id: null, asked_at: askedAt },
  }

  const { data: won } = await supabase
    .from('whatsapp_conversations')
    .update({ state: 'awaiting_company', context: nextContext as Record<string, unknown> })
    .eq('id', args.conversation.id)
    .neq('state', 'awaiting_company')
    .select('*')
  if (!Array.isArray(won) || won.length === 0) return 'not_asked'
  // Take updated_at (the revision guard) from the echoed row, but state and
  // context from what we just wrote: that is what a rollback must match.
  const committed: WhatsAppConversation = {
    ...args.conversation,
    ...((won[0] as WhatsAppConversation | undefined) ?? {}),
    state: 'awaiting_company',
    context: nextContext as Record<string, unknown>,
  }

  const copy = botCopy('sv')
  const body = copy.m6CompanyQuestion({ count: args.stagedCount })
  const numberedBody = copy.m6CompanyQuestionNumbered({
    count: args.stagedCount,
    options: options.map((o) => o.name),
  })
  const base = { to: args.to, template: TEMPLATE.m6CompanyQuestion, ...args.replyBase }

  const interactive = options.length <= MAX_LIST_ROWS
  let sent: SendTextResult
  if (options.length <= MAX_REPLY_BUTTONS) {
    sent = await sendReplyButtons(supabase, {
      ...base,
      body,
      buttons: options.map((o) => ({ id: o.id, title: o.name })),
    })
  } else if (interactive) {
    sent = await sendList(supabase, {
      ...base,
      body,
      buttonLabel: 'Välj företag',
      rows: options.map((o) => ({ id: o.id, title: o.name })),
    })
  } else {
    sent = await sendText(supabase, { ...base, body: numberedBody })
  }

  if (!sent.ok && interactive && sent.failure === 'http_rejected') {
    // Meta rejected the interactive payload at send time (no wamid was ever
    // issued, so nothing reached the phone): ask the same question as plain
    // numbered text instead of going silent. Same template id, same open
    // question; only the answer mechanism changes (digit instead of tap).
    // ONLY on an HTTP rejection: a transport error (timeout, reset) means
    // Meta may have accepted the interactive message before the failure
    // surfaced, and a text resend would put a second question on the phone
    // (#2062). That case falls through to the rollback below: the next
    // receipt re-asks, and a tap on a question that did arrive is at worst
    // ignored, which beats two open questions.
    log.warn('company question interactive send rejected; falling back to numbered text', {
      conversationId: args.conversation.id,
      errorDetail: sent.errorDetail,
    })
    sent = await sendText(supabase, { ...base, body: numberedBody })
  }

  if (!sent.ok) {
    // Undo the ask so the next receipt re-triggers it. Only our own question
    // is rolled back: a newer one (different asked_at) is left alone.
    await updateConversation(supabase, committed, (current, currentContext) => {
      if (
        current.state !== 'awaiting_company' ||
        currentContext.pending_question?.asked_at !== askedAt
      ) {
        return null
      }
      const rolledBack: ConversationContext = { ...currentContext }
      delete rolledBack.company_options
      delete rolledBack.pending_question
      return { state: previousState === 'awaiting_company' ? 'idle' : previousState, context: rolledBack }
    })
    log.warn('company question send failed; question rolled back', {
      conversationId: args.conversation.id,
      failure: sent.failure,
    })
    return 'not_asked'
  }
  return 'asked'
}

export interface DrainedParkedRows {
  /** Parked rows re-opened for processing (run through the kick). */
  reopenedIds: string[]
  /** Parked rows older than Meta's media retention, stamped expired instead. */
  expiredCount: number
}

/**
 * Re-open the receipts parked behind a company question, in the ONE shape
 * both drains share (the answer path and the single-live-company path).
 *
 * Rows older than STAGED_MEDIA_MAX_AGE_MS are stamped company_choice_expired
 * rather than re-opened: Meta no longer serves their media, so re-opening
 * them only ran each one through the MAX_ATTEMPTS error path and an M18
 * about a receipt sent a month ago (#2062). The sweep stamps the same cutoff
 * for conversations still in awaiting_company; this covers the idle ones
 * (question TTL passed, options kept) that only a drain ever touches again.
 * The stamp is guarded on the staged marker, so a second drain finds nothing
 * new to expire and the notice goes out once.
 */
export async function drainParkedRows(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<DrainedParkedRows> {
  const staleCutoff = new Date(Date.now() - STAGED_MEDIA_MAX_AGE_MS).toISOString()
  const { data: expired } = await supabase
    .from('whatsapp_messages')
    .update({ error_message: COMPANY_CHOICE_EXPIRED })
    .eq('conversation_id', conversationId)
    .eq('processing_status', 'skipped')
    .eq('error_message', STAGED_AWAITING_COMPANY)
    .lt('created_at', staleCutoff)
    .select('id')
  const { data: reopened } = await supabase
    .from('whatsapp_messages')
    .update({ processing_status: 'received', error_message: null })
    .eq('conversation_id', conversationId)
    .eq('processing_status', 'skipped')
    .eq('error_message', STAGED_AWAITING_COMPANY)
    .gte('created_at', staleCutoff)
    .select('id')
  return {
    reopenedIds: ((reopened ?? []) as { id: string }[]).map((r) => r.id),
    expiredCount: Array.isArray(expired) ? expired.length : 0,
  }
}

/**
 * Tell the sender which parked receipts could not be recovered. Sent at the
 * drain, never from the sweep: the drain runs on an inbound message, so the
 * 24h service window is open; thirty days after the last receipt it is not,
 * and a free-form send would fail. No-op for a count of zero.
 */
export async function notifyExpiredParkedRows(
  supabase: SupabaseClient,
  args: { to: string; replyBase: ReplyBase; expiredCount: number },
): Promise<void> {
  if (args.expiredCount <= 0) return
  await sendText(supabase, {
    to: args.to,
    body: botCopy('sv').m20ReceiptsExpired({ count: args.expiredCount }),
    template: TEMPLATE.m20ReceiptsExpired,
    ...args.replyBase,
  })
}

export interface AppliedCompanyChoice {
  ok: true
  companyId: string
  companyName: string
  /** Parked message rows re-opened for processing (run through the kick). */
  stagedMessageIds: string[]
}

export interface RejectedCompanyChoice {
  ok: false
  /**
   *  - invalid_option: a typed digit outside the numbered range. Ordinary
   *    user input (a typo), so the caller re-prompts instead of going silent.
   *  - not_member / lookup_failed / already_applied: stale or forged payloads
   *    and races. Silence.
   */
  reason: 'invalid_option' | 'not_member' | 'lookup_failed' | 'already_applied'
}

export type CompanyChoiceResult = AppliedCompanyChoice | RejectedCompanyChoice

/**
 * Apply a company answer (button/list id or typed digit). Validates
 * membership, pins the company for 8h, confirms with M6-confirm, re-opens
 * the parked rows and arms the combined ack.
 *
 * The open question, not the conversation state, is the thing being claimed:
 * company_options are deleted by the winning write, so a double tap delivered
 * into parallel invocations confirms exactly once, and a LATE answer (the 48h
 * TTL reset the state to idle but kept the options) still lands.
 */
export async function applyCompanyChoice(
  supabase: SupabaseClient,
  args: {
    conversation: WhatsAppConversation
    link: WhatsAppPhoneLink
    choice: { companyId: string } | { digit: number }
    via: CompanyChoiceVia
    to: string
    replyBase: ReplyBase
  },
): Promise<CompanyChoiceResult> {
  const context = getContext(args.conversation)
  const options = context.company_options ?? []
  if (options.length === 0) return { ok: false, reason: 'already_applied' }

  let companyId: string | null = null
  if ('companyId' in args.choice) {
    companyId = args.choice.companyId
  } else {
    const option = options[args.choice.digit - 1]
    companyId = option?.id ?? null
    if (!companyId) return { ok: false, reason: 'invalid_option' }
  }
  if (!companyId) return { ok: false, reason: 'invalid_option' }

  // Defense in depth: the chosen company must be one the sender belongs to
  // AND still be live, whatever the payload claimed (a stale tap can name a
  // company archived since the question was asked). A query ERROR is not a
  // missing membership: treating a transient failure as "not a member"
  // silently drops the answer.
  const { data: membership, error: membershipError } = await supabase
    .from('company_members')
    .select('company_id, companies!inner(archived_at)')
    .eq('user_id', args.link.user_id)
    .eq('company_id', companyId)
    .is('companies.archived_at', null)
    .limit(1)
    .maybeSingle()
  if (membershipError) {
    log.error('company choice membership lookup failed', membershipError, {
      conversationId: args.conversation.id,
    })
    return { ok: false, reason: 'lookup_failed' }
  }
  if (!membership) {
    log.warn('company choice rejected: sender is not a member', {
      conversationId: args.conversation.id,
    })
    return { ok: false, reason: 'not_member' }
  }

  const known = options.find((o) => o.id === companyId)
  let companyName = known?.name ?? null
  if (!companyName) {
    const { data: company } = await supabase
      .from('companies')
      .select('name')
      .eq('id', companyId)
      .maybeSingle()
    companyName = (company as { name?: string } | null)?.name ?? 'Företag'
  }

  const now = new Date()
  // Pin + arm the combined ack: the staged receipts process right after,
  // and the finalize step claims `pending_ack AND debounce_until <= now()`.
  // Guarded: whoever deletes company_options first owns the answer.
  const applied = await updateConversation(supabase, args.conversation, (_current, currentContext) => {
    if ((currentContext.company_options?.length ?? 0) === 0) return null
    const nextContext: ConversationContext = { ...currentContext }
    delete nextContext.company_options
    delete nextContext.pending_question
    nextContext.pin_expires_at = new Date(now.getTime() + COMPANY_PIN_TTL_MS).toISOString()
    nextContext.pin_source = args.via
    return {
      state: 'idle',
      company_id: companyId,
      context: nextContext,
      pending_ack: true,
      debounce_until: now.toISOString(),
    }
  })
  if (!applied) return { ok: false, reason: 'already_applied' }

  await supabase
    .from('whatsapp_phone_links')
    .update({ last_company_id: companyId })
    .eq('id', args.link.id)

  await sendText(supabase, {
    to: args.to,
    body: botCopy('sv').m6CompanyConfirm({ companyName }),
    template: TEMPLATE.m6CompanyConfirm,
    ...args.replyBase,
  })

  const drained = await drainParkedRows(supabase, args.conversation.id)
  await notifyExpiredParkedRows(supabase, {
    to: args.to,
    replyBase: args.replyBase,
    expiredCount: drained.expiredCount,
  })

  return {
    ok: true,
    companyId,
    companyName,
    stagedMessageIds: drained.reopenedIds,
  }
}
