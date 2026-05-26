import type { SupabaseClient } from '@supabase/supabase-js'
import { getAnthropic, SONNET_MODEL } from '@/lib/agent/composer/client'
import type { AgentIntent } from '@/lib/agent/intents/types'
import { agentToolRegistry } from '@/lib/agent/tools/registry'
import type { AgentTool, AgentActorContext, StagedOperationResult } from '@/lib/agent/tools/types'
import { isStagedOperation } from '@/lib/agent/tools/types'
import { buildSystemPrompt } from './system-prompt'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent.chat.run-turn')

/**
 * Normalize a model/transport error into a short, friendly Swedish message.
 * Raw AWS Bedrock SDK errors (throttling, timeouts, 5xx) are English and
 * technical; the chat surface renders this verbatim, so keep it human.
 */
export function friendlyModelError(err: unknown): string {
  const status = (err as { status?: number } | null)?.status
  const name = (err as { name?: string } | null)?.name ?? ''
  const raw = err instanceof Error ? err.message : ''
  const text = `${name} ${raw}`.toLowerCase()
  if (
    status === 429 ||
    text.includes('throttl') ||
    text.includes('too many') ||
    text.includes('rate limit') ||
    text.includes('rate exceeded')
  ) {
    return 'Anna är upptagen just nu. Vänta en liten stund och försök igen.'
  }
  if (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('etimedout') ||
    text.includes('econnreset') ||
    text.includes('network') ||
    text.includes('socket')
  ) {
    return 'Anslutningen till assistenten bröts. Försök igen.'
  }
  if (typeof status === 'number' && status >= 500) {
    return 'Assistenttjänsten har ett tillfälligt fel. Försök igen om en stund.'
  }
  return 'Något gick fel hos assistenten. Försök igen om en stund.'
}

// One turn of the chat loop:
//
//   1. Resolve context (company, profile, ranked memory).
//   2. Resolve the intent's atom + tool set.
//   3. Build system prompt with two cache_control breakpoints.
//   4. Append message history + new user message.
//   5. Stream from Anthropic.
//   6. On tool_use: dispatch via agentToolRegistry → tool_result → continue.
//   7. On staged op: stamp pending_operations.agent_metadata.
//   8. Persist all messages to agent_messages.
//
// Plan refs: §9 (chat loop), §10 (caching), §5 (BFL audit on
// pending_operations.agent_metadata).

export type StreamEvent =
  | { kind: 'text_delta'; delta: string }
  | { kind: 'tool_use'; tool_use_id: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; tool_use_id: string; result: unknown }
  | {
      kind: 'staged_operation'
      tool_use_id: string
      tool_name: string
      staged: StagedOperationResult
    }
  | {
      // The agent successfully wrote a memory mid-conversation (remember_fact
      // or forget_fact). Stream-time only — not persisted. The chat surface
      // renders a discreet "Sparat: …" chip so users know memory happened
      // without having to visit /settings/agent-memory.
      kind: 'memory_captured'
      tool_use_id: string
      action: 'remembered' | 'forgotten'
      memory_id: string
      memory_kind?: 'fact' | 'preference' | 'pattern' | 'correction'
      content?: string
    }
  | { kind: 'turn_complete'; assistant_text: string }
  | { kind: 'error'; message: string }

interface RunTurnArgs {
  supabase: SupabaseClient
  userId: string
  companyId: string
  companyName: string
  firstName: string | null
  intent: AgentIntent
  conversationId: string
  userMessage: string
  // Whether to persist this user message + assistant turn to agent_messages.
  // Tests use false to keep the DB untouched.
  persist: boolean
  // True when userMessage was synthesized by /api/agent/invoke from the
  // intent's promptTemplate (i.e. the user didn't type it). The message is
  // still persisted for Anthropic context on subsequent turns, but flagged
  // hidden=true so /chat/[id] hydration doesn't surface it as a user bubble.
  userMessageHidden?: boolean
  // Emit events back to the caller. Returns false if the stream was cancelled
  // and the loop should stop emitting (best-effort).
  emit: (event: StreamEvent) => boolean
}

// Safety net: bound the tool-loop iterations so a misbehaving model can't
// run away forever. Real conversations rarely use more than 5-6 round trips.
const MAX_TOOL_ITERATIONS = 12

// Anthropic content block types ------------------------------------------------
// We don't import the SDK type — accept any to keep this file decoupled from
// SDK version churn. The shapes we read are stable: text blocks have `text`,
// tool_use blocks have `id`, `name`, `input`.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContentBlock = any

export async function runChatTurn(args: RunTurnArgs): Promise<void> {
  const {
    supabase,
    userId,
    companyId,
    companyName,
    firstName,
    intent,
    conversationId,
    userMessage,
    persist,
    userMessageHidden,
    emit,
  } = args

  // 1 + 2 — load profile + ranked memory + atoms + tools.
  const [profile, memory, vatStatus] = await Promise.all([
    loadProfileSummary(supabase, companyId),
    loadRankedMemory(supabase, companyId, 30),
    loadVatStatus(supabase, companyId),
  ])

  const systemPrompt = await buildSystemPrompt({
    intent,
    companyId,
    companyName,
    firstName,
    profileSummary: profile,
    rankedMemory: memory,
    vatStatus,
    supabase,
  })

  const tools = await collectIntentTools(intent)

  // 3 — assemble Anthropic messages: prior history + new user turn.
  const history = await loadConversationMessages(supabase, conversationId)
  const newUserMessage = { role: 'user' as const, content: userMessage }

  if (persist) {
    await persistMessage(
      supabase,
      conversationId,
      'user',
      userMessage,
      userMessageHidden === true,
    )
  }

  const messages: { role: 'user' | 'assistant'; content: ContentBlock }[] = [
    ...history,
    newUserMessage,
  ]

  const actor: AgentActorContext = {
    type: 'agent_chat',
    id: conversationId,
    label: 'In-app chat',
  }

  const anthropic = getAnthropic()
  const model = intent.model || SONNET_MODEL

  let assistantText = ''
  let iterations = 0

  // 4 + 5 + 6 — iterate until the model stops requesting tools.
  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++

    // Token-by-token streaming. The Anthropic SDK's MessageStream emits a
    // `text` event for every text delta as Bedrock pushes them, so the user
    // sees Anna's reply appear word-by-word instead of waiting 1–5 s for
    // the full block to land. We still collect the final assembled message
    // for tool detection, persistence and stop-reason control flow.
    const stream = anthropic.messages.stream({
      model,
      max_tokens: 4096,
      system: systemPrompt.blocks,
      messages,
      tools: tools.length > 0 ? tools.map(toAnthropicTool) : undefined,
    })

    stream.on('text', (delta) => {
      assistantText += delta
      emit({ kind: 'text_delta', delta })
    })

    // Track which tool_use ids have already been announced to the client so
    // the dispatch loop below doesn't re-emit them. Eager-emitting on
    // `content_block_start` shaves the perceived lag for tool chips: the
    // chip appears the moment the LLM commits to a tool call, instead of
    // after the entire response is buffered.
    const eagerToolIds = new Set<string>()
    stream.on('streamEvent', (ev) => {
      // The raw stream event shape depends on the SDK; we only care about
      // content_block_start events with a tool_use content block.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = ev as any
      if (e?.type === 'content_block_start' && e?.content_block?.type === 'tool_use') {
        const block = e.content_block
        if (typeof block.id === 'string' && typeof block.name === 'string') {
          eagerToolIds.add(block.id)
          emit({
            kind: 'tool_use',
            tool_use_id: block.id,
            name: block.name,
            // Input is still being streamed at this point; the chip only
            // displays the tool name so empty input is fine.
            input: {},
          })
        }
      }
    })

    let response
    try {
      response = await stream.finalMessage()
    } catch (err) {
      // Surface as a chat error so the UI clears its streaming state. Re-throw
      // to let the route's outer try/catch persist the failure if needed.
      // Normalize Bedrock throttling/timeout/5xx into a friendly Swedish line.
      log.error('Bedrock stream failed', err, {
        conversationId,
        companyId,
        model,
        iterations,
      })
      emit({ kind: 'error', message: friendlyModelError(err) })
      throw err
    }

    const assistantContent: ContentBlock[] = response.content

    // Persist the assistant turn (text + tool_use blocks together).
    if (persist) {
      await persistMessage(supabase, conversationId, 'assistant', assistantContent)
    }
    messages.push({ role: 'assistant', content: assistantContent })

    // If the model didn't request any tool, we're done.
    const toolUses = assistantContent.filter((b: ContentBlock) => b.type === 'tool_use')
    if (toolUses.length === 0 || response.stop_reason !== 'tool_use') {
      break
    }

    // 7 — dispatch each tool_use sequentially. Anthropic accepts parallel
    // tool_results within a single user turn, so we collect them and emit
    // one combined user message.
    const toolResultBlocks: ContentBlock[] = []
    for (const tu of toolUses) {
      // The chip was already announced via the streamEvent listener above;
      // skip re-emitting unless we missed the early signal (defensive — the
      // dispatch loop should never run faster than the stream events).
      if (!eagerToolIds.has(tu.id)) {
        emit({
          kind: 'tool_use',
          tool_use_id: tu.id,
          name: tu.name,
          input: tu.input as Record<string, unknown>,
        })
      }

      const tool = agentToolRegistry.get(tu.name)
      if (!tool) {
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: true,
          content: `Verktyget ${tu.name} är inte registrerat.`,
        })
        continue
      }

      try {
        const result = await tool.execute(
          tu.input as Record<string, unknown>,
          companyId,
          userId,
          supabase,
          actor,
        )

        // If the tool staged a pending_operation, stamp the agent metadata
        // for BFL audit reconstructability (plan §5).
        if (isStagedOperation(result) && result.operation_id) {
          await stampAgentMetadata(supabase, result.operation_id, {
            conversation_id: conversationId,
            intent_id: intent.id,
            model,
            prompt_hash: systemPrompt.promptHash,
            atoms_loaded: systemPrompt.atomsLoaded,
          })
          emit({
            kind: 'staged_operation',
            tool_use_id: tu.id,
            tool_name: tu.name,
            staged: result,
          })
        }

        // Memory tools write immediately (no staging). Surface the capture
        // inline so the user sees memory is happening — silent writes were
        // the biggest UX gap pre-2026-05-18 (plan §11 transparency).
        if (tu.name === 'gnubok_remember_fact') {
          const r = result as { id?: unknown; kind?: unknown; content?: unknown }
          if (typeof r?.id === 'string') {
            emit({
              kind: 'memory_captured',
              tool_use_id: tu.id,
              action: 'remembered',
              memory_id: r.id,
              memory_kind:
                typeof r.kind === 'string' &&
                ['fact', 'preference', 'pattern', 'correction'].includes(r.kind)
                  ? (r.kind as 'fact' | 'preference' | 'pattern' | 'correction')
                  : undefined,
              content: typeof r.content === 'string' ? r.content : undefined,
            })
          }
        } else if (tu.name === 'gnubok_forget_fact') {
          const r = result as { id?: unknown }
          if (typeof r?.id === 'string') {
            emit({
              kind: 'memory_captured',
              tool_use_id: tu.id,
              action: 'forgotten',
              memory_id: r.id,
            })
          }
        }

        emit({ kind: 'tool_result', tool_use_id: tu.id, result })
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown tool error'
        emit({
          kind: 'tool_result',
          tool_use_id: tu.id,
          result: { error: message },
        })
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: true,
          content: message,
        })
      }
    }

    // Append the tool_result user message and loop again.
    const toolMessage = { role: 'user' as const, content: toolResultBlocks }
    messages.push(toolMessage)
    if (persist) {
      await persistMessage(supabase, conversationId, 'tool', toolResultBlocks)
    }
  }

  if (iterations >= MAX_TOOL_ITERATIONS) {
    emit({
      kind: 'error',
      message: `Avbröt efter ${MAX_TOOL_ITERATIONS} verktygsanrop — sannolikt en loop. Försök igen.`,
    })
  }

  // Touch the conversation's last_message_at + cache a 200-char preview of
  // the assistant text so /chat sidebar can render previews without joining
  // agent_messages. Trim newlines so the preview is single-line-friendly.
  if (persist) {
    const preview = assistantText
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
    await supabase
      .from('agent_conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: preview.length > 0 ? preview : null,
      })
      .eq('id', conversationId)

    // Update recency of the memories included in this turn's prompt block.
    // Errors are swallowed — a ranking-signal hiccup shouldn't fail the turn.
    try {
      await bumpMemoryAccess(
        supabase,
        memory.map((m) => m.id),
      )
    } catch {
      // intentional: best-effort
    }
  }

  emit({ kind: 'turn_complete', assistant_text: assistantText })
}

// ── Persistence helpers ────────────────────────────────────────────────────

async function loadProfileSummary(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('agent_profiles')
    .select('profile_summary')
    .eq('company_id', companyId)
    .maybeSingle()
  return (data?.profile_summary as string | null) ?? null
}

// Hard-fact VAT status the agent must cite before any moms recommendation.
// Lives on company_settings.vat_registered + vat_number — the single source of
// truth. Agent has historically guessed this from the conversation ("eftersom
// du inte är momsregistrerad…") instead of reading the company profile;
// surfacing it as a structured fact in the prompt removes the temptation.
async function loadVatStatus(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ vat_registered: boolean; vat_number: string | null } | null> {
  try {
    const { data } = await supabase
      .from('company_settings')
      .select('vat_registered, vat_number')
      .eq('company_id', companyId)
      .maybeSingle()
    if (!data) return null
    return {
      vat_registered: Boolean(data.vat_registered),
      vat_number: (data.vat_number as string | null) ?? null,
    }
  } catch {
    return null
  }
}

async function loadRankedMemory(
  supabase: SupabaseClient,
  companyId: string,
  cap: number,
): Promise<{ id: string; content: string; kind: string }[]> {
  const { data } = await supabase
    .from('agent_memory')
    .select('id, content, kind, relevance_score, last_accessed_at, is_pinned')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('is_pinned', { ascending: false })
    .order('relevance_score', { ascending: false })
    .order('last_accessed_at', { ascending: false, nullsFirst: false })
    .limit(cap)
  return (data ?? []).map((r: { id: string; content: string; kind: string }) => ({
    id: r.id,
    content: r.content,
    kind: r.kind,
  }))
}

// Bump last_accessed_at for the memories that participated in this turn.
// Plan §11 ranking is "recency-weighted relevance": the column was being
// read for ordering but never written, so the recency signal was dead.
// Writing here keeps memories the agent actually uses fresh at the top.
// Awaited before turn_complete so the update isn't dropped when the handler
// finalizes on Vercel.
async function bumpMemoryAccess(
  supabase: SupabaseClient,
  memoryIds: string[],
): Promise<void> {
  if (memoryIds.length === 0) return
  await supabase
    .from('agent_memory')
    .update({ last_accessed_at: new Date().toISOString() })
    .in('id', memoryIds)
}

async function loadConversationMessages(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<{ role: 'user' | 'assistant'; content: ContentBlock }[]> {
  const { data } = await supabase
    .from('agent_messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  // role='tool' messages were written as user messages on the Anthropic side.
  return (data ?? []).map((m: { role: string; content: ContentBlock }) => {
    if (m.role === 'assistant') {
      return { role: 'assistant', content: m.content as ContentBlock }
    }
    return { role: 'user', content: m.content as ContentBlock }
  })
}

async function persistMessage(
  supabase: SupabaseClient,
  conversationId: string,
  role: 'user' | 'assistant' | 'tool',
  content: unknown,
  hidden: boolean = false,
): Promise<void> {
  // For text-only user/assistant messages we store the string; otherwise we
  // store the full Anthropic content array. This shape matches what
  // loadConversationMessages expects on read.
  await supabase.from('agent_messages').insert({
    conversation_id: conversationId,
    role,
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    hidden,
  })
}

async function stampAgentMetadata(
  supabase: SupabaseClient,
  operationId: string,
  meta: {
    conversation_id: string
    intent_id: string
    model: string
    prompt_hash: string
    atoms_loaded: string[]
  },
): Promise<void> {
  await supabase
    .from('pending_operations')
    .update({ agent_metadata: meta })
    .eq('id', operationId)
}

// ── Tool conversion ────────────────────────────────────────────────────────

async function collectIntentTools(intent: AgentIntent): Promise<AgentTool[]> {
  return agentToolRegistry.getMany(intent.tools)
}

function toAnthropicTool(t: AgentTool) {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as { type: 'object' } & Record<string, unknown>,
  }
}
