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
} from './graph-api'
import { botCopy, TEMPLATE } from './messages'
import {
  COMPANY_PIN_TTL_MS,
  NO_COMPANY_OPTIONS,
  STAGED_AWAITING_COMPANY,
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

/** All companies the linked user belongs to, alphabetical (stable digits).
 *  Returns null when a query FAILED: a transient DB error must read as
 *  "unknown", never as "no memberships", or the caller parks receipts behind
 *  a question that can never be asked. */
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
  const base = { to: args.to, template: TEMPLATE.m6CompanyQuestion, ...args.replyBase }

  let sent: { ok: boolean }
  if (options.length <= MAX_REPLY_BUTTONS) {
    sent = await sendReplyButtons(supabase, {
      ...base,
      body,
      buttons: options.map((o) => ({ id: o.id, title: o.name })),
    })
  } else if (options.length <= MAX_LIST_ROWS) {
    sent = await sendList(supabase, {
      ...base,
      body,
      buttonLabel: 'Välj företag',
      rows: options.map((o) => ({ id: o.id, title: o.name })),
    })
  } else {
    sent = await sendText(supabase, {
      ...base,
      body: copy.m6CompanyQuestionNumbered({
        count: args.stagedCount,
        options: options.map((o) => o.name),
      }),
    })
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
    })
    return 'not_asked'
  }
  return 'asked'
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

  // Defense in depth: the chosen company must be one the sender belongs to,
  // whatever the payload claimed. A query ERROR is not a missing membership:
  // treating a transient failure as "not a member" silently drops the answer.
  const { data: membership, error: membershipError } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', args.link.user_id)
    .eq('company_id', companyId)
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

  const { data: reopened } = await supabase
    .from('whatsapp_messages')
    .update({ processing_status: 'received', error_message: null })
    .eq('conversation_id', args.conversation.id)
    .eq('processing_status', 'skipped')
    .eq('error_message', STAGED_AWAITING_COMPANY)
    .select('id')

  return {
    ok: true,
    companyId,
    companyName,
    stagedMessageIds: ((reopened ?? []) as { id: string }[]).map((r) => r.id),
  }
}
