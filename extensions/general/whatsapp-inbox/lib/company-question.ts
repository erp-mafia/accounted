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
  STAGED_AWAITING_COMPANY,
  getContext,
  type ConversationContext,
} from './conversation'

const log = createLogger('whatsapp-inbox/company-question')

/** Defensive ceiling on the numbered text list (>10 companies). */
const MAX_NUMBERED_OPTIONS = 30

export type CompanyChoiceVia = 'button' | 'list' | 'numbered'

export interface CompanyOption {
  id: string
  name: string
}

type ReplyBase = Omit<SendMessageBase, 'to' | 'template'>

/** All companies the linked user belongs to, alphabetical (stable digits). */
export async function loadCompanyOptions(
  supabase: SupabaseClient,
  userId: string,
): Promise<CompanyOption[]> {
  const { data: memberships } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', userId)
  const companyIds = [...new Set((memberships ?? []).map((m) => m.company_id as string))]
  if (companyIds.length === 0) return []

  const { data: companies } = await supabase
    .from('companies')
    .select('id, name')
    .in('id', companyIds)
  const options = ((companies ?? []) as { id: string; name: string | null }[]).map((c) => ({
    id: c.id,
    name: c.name ?? 'Företag',
  }))
  options.sort((a, b) => a.name.localeCompare(b.name, 'sv'))
  return options.slice(0, MAX_NUMBERED_OPTIONS)
}

/**
 * Ask the company question ONCE per open episode. The guarded state
 * transition (WHERE state <> 'awaiting_company') makes concurrent workers of
 * one burst produce exactly one M6; losers stage silently.
 *
 * Returns true when this caller sent the question.
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
): Promise<boolean> {
  const options = await loadCompanyOptions(supabase, args.link.user_id)
  if (options.length < 2) {
    // Degenerate: resolution should have succeeded. Leave the rows staged;
    // the sweep TTL cleans up if this persists.
    log.warn('company question requested with fewer than 2 options', {
      conversationId: args.conversation.id,
    })
    return false
  }

  const now = new Date()
  const context = getContext(args.conversation)
  const nextContext: ConversationContext = {
    ...context,
    company_options: options,
    pending_question: { type: 'company', inbox_item_id: null, asked_at: now.toISOString() },
  }

  const { data: won } = await supabase
    .from('whatsapp_conversations')
    .update({ state: 'awaiting_company', context: nextContext as Record<string, unknown> })
    .eq('id', args.conversation.id)
    .neq('state', 'awaiting_company')
    .select('id')
  if (!Array.isArray(won) || won.length === 0) return false

  const copy = botCopy('sv')
  const body = copy.m6CompanyQuestion({ count: args.stagedCount })
  const base = { to: args.to, template: TEMPLATE.m6CompanyQuestion, ...args.replyBase }

  if (options.length <= MAX_REPLY_BUTTONS) {
    await sendReplyButtons(supabase, {
      ...base,
      body,
      buttons: options.map((o) => ({ id: o.id, title: o.name })),
    })
  } else if (options.length <= MAX_LIST_ROWS) {
    await sendList(supabase, {
      ...base,
      body,
      buttonLabel: 'Välj företag',
      rows: options.map((o) => ({ id: o.id, title: o.name })),
    })
  } else {
    await sendText(supabase, {
      ...base,
      body: copy.m6CompanyQuestionNumbered({
        count: args.stagedCount,
        options: options.map((o) => o.name),
      }),
    })
  }
  return true
}

export interface AppliedCompanyChoice {
  companyId: string
  companyName: string
  /** Parked message rows re-opened for processing (run through the kick). */
  stagedMessageIds: string[]
}

/**
 * Apply a company answer (button/list id or typed digit). Validates
 * membership, pins the company for 8h, confirms with M6-confirm, re-opens
 * the parked rows and arms the combined ack. Returns null on an invalid or
 * unauthorized choice (callers stay silent: only stale or forged payloads
 * get here).
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
): Promise<AppliedCompanyChoice | null> {
  const context = getContext(args.conversation)
  const options = context.company_options ?? []

  let companyId: string | null = null
  if ('companyId' in args.choice) {
    companyId = args.choice.companyId
  } else {
    const option = options[args.choice.digit - 1]
    companyId = option?.id ?? null
  }
  if (!companyId) return null

  // Defense in depth: the chosen company must be one the sender belongs to,
  // whatever the payload claimed.
  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', args.link.user_id)
    .eq('company_id', companyId)
    .limit(1)
    .maybeSingle()
  if (!membership) {
    log.warn('company choice rejected: sender is not a member', {
      conversationId: args.conversation.id,
    })
    return null
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
  const nextContext: ConversationContext = { ...context }
  delete nextContext.company_options
  delete nextContext.pending_question
  nextContext.pin_expires_at = new Date(now.getTime() + COMPANY_PIN_TTL_MS).toISOString()
  nextContext.pin_source = args.via

  // Pin + arm the combined ack: the staged receipts process right after,
  // and the finalize step claims `pending_ack AND debounce_until <= now()`.
  await supabase
    .from('whatsapp_conversations')
    .update({
      state: 'idle',
      company_id: companyId,
      context: nextContext as Record<string, unknown>,
      pending_ack: true,
      debounce_until: now.toISOString(),
    })
    .eq('id', args.conversation.id)

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
    companyId,
    companyName,
    stagedMessageIds: ((reopened ?? []) as { id: string }[]).map((r) => r.id),
  }
}
