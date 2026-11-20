import type { SupabaseClient } from '@supabase/supabase-js'
import { findOwnConversation } from '@/lib/agent/ask/persist'

/**
 * Where a support conversation is kept.
 *
 * In the same two tables as every other assistant conversation
 * (agent_conversations, agent_messages), under its own intent: the turns are
 * company-scoped by the same RLS, append-only like the rest, and the answer
 * rating (POST /api/agent/feedback) and the hand-off record point at one
 * conversation id. The turns themselves are written and read with the
 * question box's helpers (lib/agent/ask/persist.ts).
 *
 * A support conversation is created archived. The chat's own list
 * (app/(dashboard)/chat/layout.tsx, GET /api/agent/conversations) shows every
 * unarchived conversation of the user whatever its intent, and a support
 * thread opened there would be handed to the chat runtime, which has no such
 * intent. Archived keeps it out of that list without a change to the chat,
 * which is on its way out (ASSISTANT_CHAT_ENABLED).
 */
export const SUPPORT_INTENT_ID = 'support.help'

const TITLE_MAX = 80

function title(question: string): string {
  const text = question.trim().replace(/\s+/g, ' ')
  if (text.length <= TITLE_MAX) return text
  return `${text.slice(0, TITLE_MAX - 1).trimEnd()}…`
}

export type ResolveSupportConversationResult =
  | { ok: true; conversationId: string; created: boolean }
  // Not this user's support conversation in this company: the same answer
  // for a missing id and for someone else's.
  | { ok: false; reason: 'not_found' }

/**
 * The conversation a question belongs to: the one named, when it is this
 * user's support conversation in this company (findOwnConversation), or a
 * new one.
 */
export async function resolveSupportConversation(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  conversationId: string | null | undefined,
  firstQuestion: string,
  route?: string | null,
): Promise<ResolveSupportConversationResult> {
  if (conversationId) {
    const own = await findOwnConversation(supabase, userId, companyId, conversationId, SUPPORT_INTENT_ID)
    return own ? { ok: true, conversationId: own, created: false } : { ok: false, reason: 'not_found' }
  }

  const { data: created, error } = await supabase
    .from('agent_conversations')
    .insert({
      company_id: companyId,
      user_id: userId,
      intent_id: SUPPORT_INTENT_ID,
      context_ref: route ? `page:${route}`.slice(0, 200) : null,
      title: title(firstQuestion) || 'Supportfråga',
      archived: true,
    })
    .select('id')
    .single()
  if (error || !created) throw error ?? new Error('Failed to create support conversation')
  return { ok: true, conversationId: created.id as string, created: true }
}
