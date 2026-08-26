import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getAnthropic,
  MAX_TOKENS_DEEP,
  MAX_TOKENS_NO_THINKING,
  MAX_TOKENS_STANDARD,
  SONNET_MODEL,
} from '@/lib/agent/composer/client'
import type { AgentIntent } from '@/lib/agent/intents/types'
import { agentToolRegistry } from '@/lib/agent/tools/registry'
import type { AgentTool, AgentActorContext, StagedOperationResult } from '@/lib/agent/tools/types'
import { isStagedOperation } from '@/lib/agent/tools/types'
import { buildSystemPrompt } from './system-prompt'
import { createLogger } from '@/lib/logger'
import { swedishToday } from '@/lib/utils'

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

/**
 * True when a Bedrock stream failure is transient: the identical request can
 * succeed on an immediate retry without any input change. Covers throttling
 * (429), server errors (5xx), transport cuts (timeout/reset/socket), and the
 * two known SDK stream-corruption signatures observed in prod on the pinned
 * 0.29.x SDK ("Unexpected event order", "request ended without sending any
 * chunks"). Auth/validation failures (4xx other than 429) are NOT transient:
 * retrying them is wasted work and they must keep surfacing immediately.
 */
export function isTransientStreamError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status
  if (status === 429) return true
  if (typeof status === 'number' && status >= 500) return true
  // A non-429 4xx is permanent regardless of message text.
  if (typeof status === 'number' && status >= 400) return false

  const name = (err as { name?: string } | null)?.name ?? ''
  const raw = err instanceof Error ? err.message : ''
  let cause = ''
  try {
    const c = (err as { cause?: unknown } | null)?.cause
    cause = c instanceof Error ? `${c.name} ${c.message}` : c != null ? String(c) : ''
  } catch {
    cause = ''
  }
  const text = `${name} ${raw} ${cause}`.toLowerCase()
  return (
    text.includes('unexpected event order') ||
    text.includes('request ended without sending any chunks') ||
    text.includes('throttl') ||
    text.includes('rate limit') ||
    text.includes('rate exceeded') ||
    text.includes('too many') ||
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('etimedout') ||
    text.includes('econnreset') ||
    text.includes('network') ||
    text.includes('socket')
  )
}

// One automatic retry per turn on a transient stream failure, after a short
// backoff. Per-turn, not per-iteration: a turn that dies twice is not a blip.
const STREAM_RETRY_BACKOFF_MS = 750

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
  // Extended-thinking reasoning stream. Emitted token-by-token while the model
  // reasons, before it answers or calls a tool. Stream-time only: not
  // persisted, not hydrated on resume.
  | { kind: 'reasoning_delta'; delta: string }
  | { kind: 'tool_use'; tool_use_id: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; tool_use_id: string; result: unknown }
  | {
      kind: 'staged_operation'
      tool_use_id: string
      tool_name: string
      // The tool-use input: a superset of what the staging tool stored as
      // pending_operations.params (it may also carry transport fields such
      // as idempotency_key/dry_run). Carried so chat previews that need
      // params (e.g. attach_document's DocumentViewButton) work live;
      // previews read only the fields they need.
      params: Record<string, unknown>
      staged: StagedOperationResult
    }
  | {
      // The agent successfully wrote a memory mid-conversation (remember_fact
      // or forget_fact). Stream-time only: not persisted. The chat surface
      // renders a discreet "Sparat: …" chip so users know memory happened
      // without having to visit /settings/agent-memory.
      kind: 'memory_captured'
      tool_use_id: string
      action: 'remembered' | 'forgotten'
      memory_id: string
      memory_kind?: 'fact' | 'preference' | 'pattern' | 'correction'
      content?: string
    }
  | {
      // The Bedrock stream died on a transient error and the turn is being
      // retried once. Text and eager tool chips from the dead stream were
      // never persisted; the chat surface must reset the in-progress
      // assistant bubble to `assistant_text` (what had accumulated BEFORE the
      // failed attempt) and drop un-completed tool chips.
      kind: 'stream_restart'
      assistant_text: string
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
  // Profile summary the caller already loaded for this turn (the invoke route
  // reads it to build a first-turn prompt template). Passed through so the same
  // read doesn't happen twice per turn.
  //
  // Ranked memory is deliberately NOT shared: the route's variant selects fewer
  // columns and orders without is_pinned, and this one needs ids to stamp
  // last_accessed_at. Reusing it there would silently change both the prompt
  // and memory touch.
  preloadedProfileSummary?: string | null
  // Emit events back to the caller. Returns false if the stream was cancelled
  // and the loop should stop emitting (best-effort).
  emit: (event: StreamEvent) => boolean
}

// Safety net: bound the tool-loop iterations so a misbehaving model can't
// run away forever. Real conversations rarely use more than 5-6 round trips.
const MAX_TOOL_ITERATIONS = 12

// How many stored messages replay into a turn. Generous enough that no real
// conversation notices (a long working session is tens of messages, not
// hundreds) while bounding what a thread costs to continue.
export const MAX_HISTORY_MESSAGES = 200

// Bound a tool result before it enters the model context. Read tools (above
// all gnubok_get_document_content, which returns full OCR/PDF text) can return
// arbitrarily large payloads. Unbounded, that payload is re-sent on every later
// iteration of this turn's loop AND replayed on every future turn (it is
// persisted as a 'tool' message and rehydrated by loadConversationMessages),
// re-introducing the exact context rot we keep out of the system prompt. We cap
// the serialized result and tell the model how to narrow if it was truncated.
//
// Per Anthropic's tool guidance: truncate with sensible defaults and steer the
// agent to a narrower request; the practical ceiling cited for a single tool
// return is ~25k tokens, so 40k chars (~10k tokens) sits well under that while
// leaving multi-page receipts/invoices intact: only pathological dumps get cut.
export const MAX_TOOL_RESULT_CHARS = 40_000

export function boundToolResultText(raw: string): string {
  if (raw.length <= MAX_TOOL_RESULT_CHARS) return raw
  const head = raw.slice(0, MAX_TOOL_RESULT_CHARS)
  return `${head}\n\n[avkortat: resultatet var ${raw.length} tecken, visar de första ${MAX_TOOL_RESULT_CHARS}. Be om en smalare sökning (limit, datumintervall, specifikt dokument-id eller fält) för att se mer.]`
}

// Wrap a bounded tool-result string in <tool_output> markers before feeding
// it back to the model. Paired with the system-prompt rule that text inside
// <tool_output> is third-party data, never instructions: mitigates the
// prompt-injection surface from OCR'd documents, inbox items, and any
// other tool that returns untrusted vendor/customer text. Closing tag uses a
// distinct strings so a malicious payload containing the literal token can't
// trivially escape; the contained JSON is serialized so embedded `<` chars
// are escaped by JSON.stringify (which they are not; they survive
// stringification): to defend, we additionally strip the literal close-tag
// sequence from the content.
export function wrapToolResult(toolUseId: string, raw: string): string {
  const safe = raw.replaceAll('</tool_output>', '</tool_​output>') // ZWSP injected
  return `<tool_output id="${toolUseId}">\n${safe}\n</tool_output>`
}

// Anthropic content block types ------------------------------------------------
// We don't import the SDK type: accept any to keep this file decoupled from
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

  // 1 + 2: load profile + ranked memory + atoms + tools.
  //
  // On a first turn the caller already read the profile summary to build the
  // intent's prompt template, so it hands it over rather than making the same
  // round trip again for the system prompt.
  const [profile, memory, vatStatus] = await Promise.all([
    args.preloadedProfileSummary !== undefined
      ? Promise.resolve(args.preloadedProfileSummary)
      : loadProfileSummary(supabase, companyId),
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
    today: swedishToday(),
    supabase,
  })

  const tools = await collectIntentTools(intent)

  // 3: assemble Anthropic messages: prior history + new user turn.
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
  // stop_reason of the last completed model call: lets the post-loop check
  // tell "finished" from "ran out of output budget before any visible text".
  let lastStopReason: string | null = null
  // One automatic retry per TURN when the Bedrock stream dies on a transient
  // error (throttling, 5xx, transport cut, stream corruption). The failed
  // attempt persisted nothing (persist happens after finalMessage() succeeds),
  // so a clean retry is safe; the client is told to discard the partial
  // bubble via stream_restart.
  let streamRetryUsed = false

  // Extended thinking ("tänka längre"): when the intent opts in, every model
  // call in the loop gets a reasoning channel so the agent reasons BEFORE it
  // answers or commits to a tool, instead of narrating its steps in the
  // visible reply. The reasoning streams to the client as reasoning_delta and
  // renders in a collapsible "Tänkte…" block.
  //
  // display:'summarized' is load-bearing, not cosmetic. The default is
  // 'omitted', which still emits thinking blocks but with empty text: measured
  // on this account at xhigh effort, summarized returned ~1k characters of
  // reasoning and the default returned none. Without it the collapsible
  // "Tänker …" block in the chat would silently never populate.
  //
  // max_tokens now covers thinking and the reply together, so the ceiling
  // follows what the intent opted into. An intent with no thinking keeps its
  // reply-sized cap: giving it the reasoning tier's headroom would let a plain
  // answer run four times longer for no reason.
  const thinking = intent.thinking
    ? { type: 'adaptive' as const, display: 'summarized' as const }
    : undefined
  const outputConfig = intent.thinking ? { effort: intent.thinking.effort } : undefined
  const maxTokens = !intent.thinking
    ? MAX_TOKENS_NO_THINKING
    : intent.thinking.effort === 'xhigh' || intent.thinking.effort === 'max'
      ? MAX_TOKENS_DEEP
      : MAX_TOKENS_STANDARD

  // 4 + 5 + 6: iterate until the model stops requesting tools.
  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++

    // Token-by-token streaming. The Anthropic SDK's MessageStream emits a
    // `text` event for every text delta as Bedrock pushes them, so the user
    // sees Anna's reply appear word-by-word instead of waiting 1-5 s for
    // the full block to land. We still collect the final assembled message
    // for tool detection, persistence and stop-reason control flow.
    //
    // The attempt loop wraps stream creation + finalMessage() so a transient
    // failure (throttling, 5xx, transport cut, stream corruption) gets ONE
    // automatic retry per turn. Everything the dead stream emitted is
    // reverted: assistantText rolls back to its pre-attempt snapshot and the
    // client discards the partial bubble on stream_restart.
    let response
    let eagerToolIds = new Set<string>()
    for (;;) {
      const assistantTextBefore = assistantText
      const stream = anthropic.messages.stream({
        model,
        max_tokens: maxTokens,
        system: systemPrompt.blocks,
        messages,
        tools: tools.length > 0 ? tools.map(toAnthropicTool) : undefined,
        ...(thinking ? { thinking } : {}),
        ...(outputConfig ? { output_config: outputConfig } : {}),
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
      eagerToolIds = new Set<string>()
      stream.on('streamEvent', (ev) => {
        // The raw stream event shape depends on the SDK; we care about
        // content_block_start with a tool_use block, and content_block_delta
        // carrying extended-thinking text.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = ev as any
        if (
          e?.type === 'content_block_delta' &&
          e?.delta?.type === 'thinking_delta' &&
          typeof e.delta.thinking === 'string'
        ) {
          emit({ kind: 'reasoning_delta', delta: e.delta.thinking })
          return
        }
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

      try {
        response = await stream.finalMessage()
        break
      } catch (err) {
        if (!streamRetryUsed && isTransientStreamError(err)) {
          streamRetryUsed = true
          log.warn('Bedrock stream failed transiently, retrying once', {
            conversationId,
            companyId,
            model,
            iterations,
            errMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
            errStatus: (err as { status?: number } | null)?.status,
          })
          // Roll back what the dead stream produced. Nothing was persisted
          // (persist happens after finalMessage() succeeds), so state-wise
          // this attempt never happened; the client resets its bubble.
          assistantText = assistantTextBefore
          emit({ kind: 'stream_restart', assistant_text: assistantText })
          await new Promise((resolve) => setTimeout(resolve, STREAM_RETRY_BACKOFF_MS))
          continue
        }
        // Surface as a chat error so the UI clears its streaming state. Re-throw
        // to let the route's outer try/catch persist the failure if needed.
        // Normalize Bedrock throttling/timeout/5xx into a friendly Swedish line.
        //
        // Extract status/code/cause/stack explicitly: the logger keeps only
        // name/message/code from an Error and drops the stack in production, so
        // the real failure was invisible (every prod log just said "request ended
        // without sending any chunks"). These fields tell us whether the empty
        // stream is auth (403), bad model/region (400), throttling (429), or a
        // genuine transport cut. No secrets: AWS/SDK errors carry none, and the
        // logger still redacts personnummer/UUIDs from any string.
        const bedrockErr = err as {
          status?: number
          code?: string
          cause?: unknown
          stack?: string
        }
        let errCause: string | undefined
        try {
          errCause =
            bedrockErr?.cause != null
              ? String(
                  bedrockErr.cause instanceof Error
                    ? `${bedrockErr.cause.name}: ${bedrockErr.cause.message}`
                    : bedrockErr.cause,
                ).slice(0, 300)
              : undefined
        } catch {
          errCause = '[uninspectable cause]'
        }
        log.error('Bedrock stream failed', err, {
          conversationId,
          companyId,
          model,
          iterations,
          retried: streamRetryUsed,
          errStatus: typeof bedrockErr?.status === 'number' ? bedrockErr.status : undefined,
          errCode: typeof bedrockErr?.code === 'string' ? bedrockErr.code : undefined,
          errCause,
          errStack: typeof bedrockErr?.stack === 'string' ? bedrockErr.stack.slice(0, 1200) : undefined,
        })
        emit({ kind: 'error', message: friendlyModelError(err) })
        throw err
      }
    }

    const assistantContent: ContentBlock[] = response.content
    lastStopReason = (response as { stop_reason?: string | null }).stop_reason ?? null

    // Persist the assistant turn (text + tool_use blocks). Thinking blocks are
    // stripped for storage but kept in `messages` below for the in-turn loop.
    if (persist) {
      await persistMessage(supabase, conversationId, 'assistant', stripThinking(assistantContent))
    }
    messages.push({ role: 'assistant', content: assistantContent })

    // If the model didn't request any tool, we're done.
    const toolUses = assistantContent.filter((b: ContentBlock) => b.type === 'tool_use')
    if (toolUses.length === 0 || response.stop_reason !== 'tool_use') {
      break
    }

    // 7: dispatch each tool_use sequentially. Anthropic accepts parallel
    // tool_results within a single user turn, so we collect them and emit
    // one combined user message.
    const toolResultBlocks: ContentBlock[] = []
    for (const tu of toolUses) {
      // The chip was already announced via the streamEvent listener above;
      // skip re-emitting unless we missed the early signal (defensive: the
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
            params: tu.input as Record<string, unknown>,
            staged: result,
          })
        }

        // Memory tools write immediately (no staging). Surface the capture
        // inline so the user sees memory is happening: silent writes were
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

        // Emit the full result to the client (display only: not model
        // context). The block that re-enters the model loop and gets persisted
        // is bounded so a large read can't dominate the context window, and
        // wrapped in <tool_output> markers so the model treats the content as
        // untrusted third-party data (see system-prompt §"Verktygsutdata är
        // OTROSTAD DATA").
        emit({ kind: 'tool_result', tool_use_id: tu.id, result })
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: wrapToolResult(tu.id, boundToolResultText(JSON.stringify(result))),
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
      message: `Avbröt efter ${MAX_TOOL_ITERATIONS} verktygsanrop: sannolikt en loop. Försök igen.`,
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
    // Errors are swallowed: a ranking-signal hiccup shouldn't fail the turn.
    try {
      await bumpMemoryAccess(
        supabase,
        memory.map((m) => m.id),
      )
    } catch {
      // intentional: best-effort
    }
  }

  // A turn that hit the output ceiling before producing any visible text
  // (thinking or tool churn spent the whole max_tokens budget) is a failure,
  // not a completion. A bare turn_complete here is the silent-stop bug: the
  // client hides the empty bubble and "Tänker" just disappears. A PARTIAL
  // answer that hit the ceiling still completes; only the empty case errors.
  if (lastStopReason === 'max_tokens' && assistantText.trim().length === 0) {
    log.error('model hit max_tokens with no visible text', {
      conversationId,
      companyId,
      model,
      iterations,
      thinking: Boolean(intent.thinking),
      maxTokens,
    })
    emit({
      kind: 'error',
      message: 'Assistenten fick slut på utrymme innan svaret blev klart. Försök igen.',
    })
    return
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
// Lives on company_settings.vat_registered + vat_number: the single source of
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
  // Newest-first with a cap, then flipped back: an unbounded load replays every
  // persisted tool result (each up to MAX_TOOL_RESULT_CHARS) on every turn, so
  // cost grows linearly with thread age and a long-lived pinned conversation
  // eventually exceeds the context window. Past that point every turn fails and
  // the store is append-only, so the thread is unusable for good.
  //
  // Slicing a tail can orphan a tool_result whose tool_use fell off the top, or
  // strand a tool_use whose result did: repairDanglingToolUse below normalizes
  // both, which is what makes the cap safe.
  const { data } = await supabase
    .from('agent_messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    // Tie-break so the cutoff row is the same on every replay: created_at
    // defaults to now(), and rows written inside one transaction share it to
    // the microsecond. Which of a tied pair lands inside the window is
    // arbitrary but no longer varies request to request. id is a random uuid,
    // so this orders ties stably rather than by insertion: the ordering that
    // actually matters, tool_use before its tool_result, is restored by
    // repairDanglingToolUse below rather than by this clause.
    .order('id', { ascending: false })
    .limit(MAX_HISTORY_MESSAGES)

  // role='tool' messages were written as user messages on the Anthropic side.
  const messages = (data ?? []).slice().reverse().map((m: { role: string; content: ContentBlock }) => {
    if (m.role === 'assistant') {
      return { role: 'assistant' as const, content: m.content as ContentBlock }
    }
    return { role: 'user' as const, content: m.content as ContentBlock }
  })

  return repairDanglingToolUse(messages)
}

/**
 * Synthesize `tool_result` blocks for any `tool_use` the stored history never
 * answered.
 *
 * The assistant message carrying `tool_use` blocks is persisted before the
 * tools run, and their results only after the whole batch finishes. If the
 * process dies in between (client disconnect terminating the function, a
 * deploy, a tool that outlives the request), the stored conversation ends on an
 * unanswered `tool_use`. The Messages API rejects that shape on replay, so
 * every later turn 400s: and because agent_messages is append-only by design
 * (no UPDATE/DELETE policies, BFL audit trail), nothing can repair the row.
 * The conversation is bricked forever.
 *
 * Repairing on read keeps the stored trail untouched and the thread usable.
 * The synthesized result is flagged as an error so the model treats it as a
 * failed call rather than silently inventing an outcome from it.
 */
export function repairDanglingToolUse(
  messages: { role: 'user' | 'assistant'; content: ContentBlock }[],
): { role: 'user' | 'assistant'; content: ContentBlock }[] {
  const toolResultIds = (content: ContentBlock): Set<string> => {
    const ids = new Set<string>()
    if (!Array.isArray(content)) return ids
    for (const block of content) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        ids.add(block.tool_use_id)
      }
    }
    return ids
  }

  // The API requires results in the message IMMEDIATELY following the tool_use,
  // so position matters, not just presence: a result that landed after an
  // intervening turn (two turns racing on one conversation) is still an invalid
  // shape. Walk pairwise, and treat only same-position results as answers.
  const out: { role: 'user' | 'assistant'; content: ContentBlock }[] = []
  const satisfied = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    out.push(m)
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue

    const pending = m.content
      .filter((block: ContentBlock) => block?.type === 'tool_use' && typeof block.id === 'string')
      .map((block: ContentBlock) => block.id as string)
    if (pending.length === 0) continue

    const answeredHere = toolResultIds(messages[i + 1]?.content)
    const missing = pending.filter((id) => !answeredHere.has(id))
    for (const id of pending) {
      if (answeredHere.has(id)) satisfied.add(id)
    }

    if (missing.length > 0) {
      for (const id of missing) satisfied.add(id)
      out.push({
        role: 'user',
        content: missing.map((id) => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: 'Avbröts innan verktyget hann svara. Kör om det om du behöver resultatet.',
          is_error: true,
        })) as ContentBlock,
      })
    }
  }

  // Drop any tool_result that is now orphaned: either a late duplicate of one
  // we just stubbed, or a result whose tool_use never immediately preceded it.
  // An unmatched tool_result is rejected by the API just as an unanswered
  // tool_use is, so leaving it in would defeat the repair.
  return out
    .map((m, idx) => {
      if (!Array.isArray(m.content)) return m
      const prev = out[idx - 1]
      const openedByPrev =
        prev?.role === 'assistant' && Array.isArray(prev.content)
          ? new Set(
              prev.content
                .filter(
                  (b: ContentBlock) => b?.type === 'tool_use' && typeof b.id === 'string',
                )
                .map((b: ContentBlock) => b.id as string),
            )
          : new Set<string>()

      const kept = m.content.filter((block: ContentBlock) => {
        if (block?.type !== 'tool_result') return true
        return openedByPrev.has(block.tool_use_id)
      })
      if (kept.length === m.content.length) return m
      return { ...m, content: kept as ContentBlock }
    })
    .filter((m) => !Array.isArray(m.content) || m.content.length > 0)
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

// Thinking blocks stay in the in-memory `messages` array: Anthropic requires
// the preceding assistant turn's thinking block to be present when you return
// tool_results within the same turn, but we strip them before persistence:
// they hold the raw chain of thought (storage bloat), and replaying past-turn
// thinking on resume is neither required nor used by the model. The chat
// surface shows reasoning live via reasoning_delta; it is not hydrated.
export function stripThinking(content: ContentBlock[]): ContentBlock[] {
  if (!Array.isArray(content)) return content
  return content.filter(
    (b: ContentBlock) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking',
  )
}

function toAnthropicTool(t: AgentTool) {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as { type: 'object' } & Record<string, unknown>,
  }
}
