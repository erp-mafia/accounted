/**
 * channel_context helpers for invoice_inbox_items rows created by the chat
 * channel, plus the processing_history audit events for the question
 * lifecycle (asked/answered/expired: together with representation.raw_answer
 * these form the Skatteverket documentation trail).
 *
 * channel_context is deliberately separate from extracted_data:
 * retry-extraction overwrites extracted_data wholesale, and verified human
 * answers must never share a container with untrusted OCR output.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { createLogger } from '@/lib/logger'
import type { InboxChannelContext } from '@/types'

const log = createLogger('whatsapp-inbox/item-context')

export async function loadItemContext(
  supabase: SupabaseClient,
  inboxItemId: string,
): Promise<InboxChannelContext> {
  const { data } = await supabase
    .from('invoice_inbox_items')
    .select('channel_context')
    .eq('id', inboxItemId)
    .maybeSingle()
  const context = (data as { channel_context: InboxChannelContext | null } | null)
    ?.channel_context
  return context ?? { channel: 'whatsapp' }
}

export async function updateItemContext(
  supabase: SupabaseClient,
  inboxItemId: string,
  mutate: (context: InboxChannelContext) => InboxChannelContext,
): Promise<void> {
  const current = await loadItemContext(supabase, inboxItemId)
  await supabase
    .from('invoice_inbox_items')
    .update({ channel_context: mutate(current) as unknown as Record<string, unknown> })
    .eq('id', inboxItemId)
}

export async function appendQuestionHistory(
  supabase: SupabaseClient,
  args: {
    inboxItemId: string
    eventType: 'ChannelQuestionAsked' | 'ChannelQuestionAnswered' | 'ChannelQuestionExpired'
    questionType: string
    correlationId?: string | null
  },
): Promise<void> {
  try {
    const { data } = await supabase
      .from('invoice_inbox_items')
      .select('company_id, correlation_id')
      .eq('id', args.inboxItemId)
      .maybeSingle()
    const item = data as { company_id: string; correlation_id: string | null } | null
    if (!item) return
    await appendProcessingHistory({
      companyId: item.company_id,
      correlationId: args.correlationId ?? item.correlation_id ?? args.inboxItemId,
      aggregateType: 'System',
      aggregateId: args.inboxItemId,
      eventType: args.eventType,
      payload: {
        channel: 'whatsapp',
        inbox_item_id: args.inboxItemId,
        question_type: args.questionType,
      },
      actor: { type: 'system', id: 'whatsapp-inbound' },
      occurredAt: new Date(),
    })
  } catch (err) {
    log.error('question history append failed', err, { inboxItemId: args.inboxItemId })
  }
}
