import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Thread persistence for the single-call chat console (/chat).
 *
 * The console answers in one call via answerAssistantQuestion (no tool loop,
 * no streaming: runs on a local model). But the founder wants the /chat
 * sidebar and "resume a thread" to keep working, so each console turn is
 * written to the SAME durable tables the streaming runtime uses:
 * agent_conversations + agent_messages. That way old and new threads live in
 * one list and one schema.
 *
 * Content is stored as the canonical Anthropic content array
 * ([{ type: 'text', text }]) so normalizeStoredMessages() renders these rows
 * identically to run-turn's, and the BFL append-only audit invariant on
 * agent_messages holds (no UPDATE/DELETE policy exists on that table).
 *
 * Only the general.help intent uses this path. Tool-loop intents
 * (categorization, invoice draft, supplier review) still go through
 * run-turn.ts because they stage operations and need the tool loop.
 */

/** The only intent the single-call console persists under. */
export const CHAT_INTENT_ID = 'general.help'

// The sidebar caches a one-line preview per row; the title is the sidebar
// label. Both are bounded so a long first question can't bloat the row.
const PREVIEW_MAX = 200
const TITLE_MAX = 80

/** Truncate on a whole-grapheme boundary is overkill here; a hard slice with an ellipsis is fine for a preview. */
function clamp(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ')
  if (t.length <= max) return t
  return `${t.slice(0, max - 1).trimEnd()}…`
}

function textBlocks(text: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text }]
}

export type ResolveConversationResult =
  | { ok: true; conversationId: string; created: boolean }
  // The client passed a conversation id that isn't this user's general.help
  // thread in this company. Same outcome as "doesn't exist": a 404, never a
  // 403 that would confirm someone else's id is real.
  | { ok: false; reason: 'not_found' }

/**
 * Resolve the conversation to append this turn to.
 *
 * With no id, create a fresh general.help conversation titled from the first
 * question. With an id, verify ownership the same way /api/agent/invoke does:
 * RLS on agent_conversations is COMPANY-scoped, so a colleague's thread would
 * otherwise load; the user_id + company_id + intent_id checks close that.
 */
export async function resolveChatConversation(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  conversationId: string | null | undefined,
  firstQuestion: string,
  contextRef?: string | null,
): Promise<ResolveConversationResult> {
  if (conversationId) {
    const { data: conv } = await supabase
      .from('agent_conversations')
      .select('id, user_id, company_id, intent_id')
      .eq('id', conversationId)
      .maybeSingle()
    if (
      !conv ||
      conv.user_id !== userId ||
      conv.company_id !== companyId ||
      conv.intent_id !== CHAT_INTENT_ID
    ) {
      return { ok: false, reason: 'not_found' }
    }
    return { ok: true, conversationId: conv.id as string, created: false }
  }

  const { data: created, error } = await supabase
    .from('agent_conversations')
    .insert({
      company_id: companyId,
      user_id: userId,
      intent_id: CHAT_INTENT_ID,
      context_ref: contextRef ?? null,
      title: clamp(firstQuestion, TITLE_MAX) || 'Fråga din assistent',
    })
    .select('id')
    .single()
  if (error || !created) throw error ?? new Error('Failed to create conversation')
  return { ok: true, conversationId: created.id as string, created: true }
}

/** Append the user's question as a persisted turn (append-only). */
export async function persistUserTurn(
  supabase: SupabaseClient,
  conversationId: string,
  question: string,
): Promise<void> {
  const { error } = await supabase.from('agent_messages').insert({
    conversation_id: conversationId,
    role: 'user',
    content: textBlocks(question),
  })
  if (error) throw error
}

/**
 * Append the assistant's answer and roll the conversation row forward so the
 * sidebar shows this thread at the top with a fresh preview. run-turn updates
 * the same two columns on every assistant turn; we mirror that exactly.
 */
export async function persistAssistantTurn(
  supabase: SupabaseClient,
  conversationId: string,
  answer: string,
): Promise<void> {
  const { error: msgErr } = await supabase.from('agent_messages').insert({
    conversation_id: conversationId,
    role: 'assistant',
    content: textBlocks(answer),
  })
  if (msgErr) throw msgErr

  // Best-effort: a failed roll-forward only mis-sorts the sidebar row, it does
  // not lose the answer (already persisted above). Do not fail the request on it.
  await supabase
    .from('agent_conversations')
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: clamp(answer, PREVIEW_MAX),
    })
    .eq('id', conversationId)
}
