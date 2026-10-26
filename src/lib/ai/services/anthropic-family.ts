import type Anthropic from '@anthropic-ai/sdk'
import { createAiClient, toProviderModelId, type AiClient } from '../provider'
import type { ResolvedAiConfig } from '../config'
import { capabilitiesFor } from '../config'
import type {
  AiChatTurn,
  AiDocumentInput,
  AiService,
  AiTier,
  AiToolDef,
  AiUsage,
  ExtractFromDocumentRequest,
  ExtractFromDocumentResult,
  GenerateStructuredRequest,
  GenerateStructuredResult,
  GenerateTextRequest,
  GenerateTextResult,
} from '../types'

const DEFAULT_MAX_STEPS = 4

// Bound a serialized tool result before it enters the model context. Mirrors
// boundToolResultText in lib/agent/chat/run-turn.ts: same 40k-char ceiling
// (~10k tokens, well under the ~25k-token practical ceiling for a single tool
// return). Unbounded, one large read (full OCR text, a big ledger report) is
// re-sent on every later loop turn and can eat the whole max_tokens budget
// before the model produces any visible text.
const MAX_TOOL_RESULT_CHARS = 40_000

function boundToolResult(raw: string): string {
  if (raw.length <= MAX_TOOL_RESULT_CHARS) return raw
  const head = raw.slice(0, MAX_TOOL_RESULT_CHARS)
  return `${head}\n\n[avkortat: resultatet var ${raw.length} tecken, visar de första ${MAX_TOOL_RESULT_CHARS}. Be om en smalare sökning (limit, datumintervall, specifikt id eller fält) för att se mer.]`
}

// The user-turn text of the final no-tools turn. Without it the model gets a
// transcript that ends on tool results (or on a turn it already ended without
// text) and nothing that says "answer now", so the forced turn can come back
// empty too. Anthropic's stop-reason guide for an empty end_turn says exactly
// this: add a continuation prompt as a new user message, never resend the
// request unchanged (the model already decided it was done). Text after tool
// results is only harmful as a recurring pattern in the history; here it
// closes the conversation.
const FINAL_ANSWER_REQUEST =
  'Answer the question now, in plain text, from what you have already gathered. Do not call any more tools. If that is not enough to answer, say what is missing. Keep to the reply language your instructions set.'

/**
 * The transcript plus the final answer request. Appended to the closing user
 * turn (tool results, or the question itself): the API merges consecutive
 * user messages into one turn anyway, and one explicit turn is valid on every
 * backend.
 */
function withFinalAnswerRequest(
  messages: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  const ask: Anthropic.Messages.TextBlockParam = { type: 'text', text: FINAL_ANSWER_REQUEST }
  const last = messages[messages.length - 1]
  if (last?.role !== 'user') return [...messages, { role: 'user', content: [ask] }]
  const blocks: Anthropic.Messages.ContentBlockParam[] =
    typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content
  return [...messages.slice(0, -1), { role: 'user', content: [...blocks, ask] }]
}

const EMPTY_USAGE: AiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
}

/**
 * Earlier turns as real message turns, then the prompt as the final user
 * message. With no history this is exactly the single-message array every
 * non-chat caller sent before (hosted stays byte-identical for them).
 */
function messagesFor(
  prompt: string,
  history: AiChatTurn[] | undefined,
): Anthropic.Messages.MessageParam[] {
  const prior: Anthropic.Messages.MessageParam[] = (history ?? []).map((t) => ({
    role: t.role,
    content: t.text,
  }))
  return [...prior, { role: 'user', content: prompt }]
}

/** Sum usage across the turns of a tool loop so the reported cost is truthful. */
function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  const s = (x: number | null, y: number | null) => (x ?? 0) + (y ?? 0)
  return {
    inputTokens: s(a.inputTokens, b.inputTokens),
    outputTokens: s(a.outputTokens, b.outputTokens),
    cacheCreationInputTokens: s(a.cacheCreationInputTokens, b.cacheCreationInputTokens),
    cacheReadInputTokens: s(a.cacheReadInputTokens, b.cacheReadInputTokens),
  }
}

/**
 * The Anthropic family (AWS Bedrock and the direct API) behind the job-shaped
 * interface. Delegates to the existing client factory and builds the EXACT
 * request literals the call sites built before the abstraction existed, so
 * hosted stays byte-identical on the wire: the request-shape tests in
 * lib/ai/__tests__ deep-equal those literals.
 */

type MessageCreateParams = Anthropic.Messages.MessageCreateParamsNonStreaming

function usageOf(resp: { usage?: unknown }): AiUsage {
  const usage = (resp.usage ?? {}) as {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number | null
    cache_read_input_tokens?: number | null
  }
  return {
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? null,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? null,
  }
}

function textOf(resp: { content: Array<{ type: string; text?: string }> }): string {
  return resp.content
    .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('')
    .trim()
}

/** How the last turn ended, for the caller: cut off at max_tokens, and the raw reason for logs. */
function endOf(resp: { stop_reason?: string | null }): Pick<GenerateTextResult, 'truncated' | 'stopReason'> {
  return {
    ...(resp.stop_reason === 'max_tokens' ? { truncated: true as const } : {}),
    ...(resp.stop_reason ? { stopReason: resp.stop_reason } : {}),
  }
}

/** User content blocks for one document + trailing instruction. Same literals the inbox extractor sent. */
export function buildAnthropicDocumentContent(
  document: AiDocumentInput,
  instruction: string
): Anthropic.Messages.ContentBlockParam[] {
  const tail = { type: 'text' as const, text: instruction }
  if (document.kind === 'text') {
    return [{ type: 'text' as const, text: document.text }, tail]
  }
  const base64 = document.data.toString('base64')
  if (document.kind === 'pdf') {
    return [
      {
        type: 'document' as const,
        source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 },
      },
      tail,
    ]
  }
  return [
    {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: document.mediaType, data: base64 },
    },
    tail,
  ]
}

export function createAnthropicFamilyService(cfg: ResolvedAiConfig): AiService {
  let client: AiClient | null = null
  const getClient = async (): Promise<AiClient> => {
    if (!client) client = await createAiClient()
    return client
  }
  const modelFor = (tier: AiTier): string =>
    // The Anthropic family always has a model (Claude default), so the null
    // branch is unreachable; keep the fallback so the type stays honest.
    toProviderModelId(cfg.models[tier] ?? 'claude-sonnet-5', cfg.provider)

  return {
    provider: cfg.provider,
    capabilities: capabilitiesFor(cfg),
    modelFor,

    async generateText(req: GenerateTextRequest): Promise<GenerateTextResult> {
      const model = modelFor(req.tier)

      // Fast path (unchanged: keeps hosted byte-identical for every non-tool
      // caller, which is all of them today): one turn, no tools.
      if (!req.tools || req.tools.length === 0) {
        const params: MessageCreateParams = {
          model,
          max_tokens: req.maxTokens,
          ...(req.system ? { system: req.system } : {}),
          messages: messagesFor(req.prompt, req.history),
        }
        const resp = await (await getClient()).messages.create(params)
        return { text: textOf(resp), model, usage: usageOf(resp), ...endOf(resp) }
      }

      // Bounded read-only tool loop. The same dispatch shape run-turn.ts uses,
      // minus streaming and staging: the model asks for a report, we run it,
      // feed the JSON back, repeat up to maxSteps model turns, then answer.
      const tools: Anthropic.Messages.Tool[] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.jsonSchema as Anthropic.Messages.Tool['input_schema'],
      }))
      const byName = new Map<string, AiToolDef>(req.tools.map((t) => [t.name, t]))
      const messages: Anthropic.Messages.MessageParam[] = messagesFor(req.prompt, req.history)
      const maxSteps = req.maxSteps ?? DEFAULT_MAX_STEPS
      let usage = EMPTY_USAGE
      let forcedFinal: 'step_limit' | 'no_text' = 'step_limit'

      for (let step = 0; step < maxSteps; step++) {
        const resp = await (await getClient()).messages.create({
          model,
          max_tokens: req.maxTokens,
          ...(req.system ? { system: req.system } : {}),
          tools,
          messages,
        })
        usage = addUsage(usage, usageOf(resp))
        const toolUses = resp.content.filter(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
        )

        if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
          // A tool call cut off at max_tokens has incomplete input: never run
          // it, and its text is at most a preamble ("Jag hämtar..."), not an
          // answer. Any other turn's text is the answer, cut off or not.
          const text = toolUses.length > 0 ? '' : textOf(resp)
          // A refusal is the model's answer: never re-ask around it.
          if (text || resp.stop_reason === 'refusal') {
            return { text, model, usage, ...endOf(resp) }
          }
          // No visible text: an end_turn with nothing in it, or a turn whose
          // whole max_tokens budget went to (empty-text) thinking blocks or to
          // the cut-off tool call. Returning '' here was the "Assistenten gav
          // inget svar" bug. The turn is dropped (its blocks cannot be replayed:
          // a cut-off tool_use has no result) and the model is asked for the
          // answer below.
          forcedFinal = 'no_text'
          break
        }

        messages.push({ role: 'assistant', content: resp.content })
        const results: Anthropic.Messages.ContentBlockParam[] = []
        for (const block of toolUses) {
          const def = byName.get(block.name)
          let content: string
          let isError = false
          try {
            if (!def) {
              isError = true
              content = JSON.stringify({ error: `Verktyget ${block.name} är inte tillgängligt.` })
            } else {
              const out = await def.execute((block.input ?? {}) as Record<string, unknown>)
              content = JSON.stringify(out ?? null)
            }
          } catch (err) {
            isError = true
            content = JSON.stringify({ error: err instanceof Error ? err.message : 'Tool failed' })
          }
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: boundToolResult(content),
            is_error: isError,
          })
        }
        messages.push({ role: 'user', content: results })
      }

      // No answer yet (step budget spent, or a turn without visible text):
      // force one more turn that cannot call tools and is told to answer. The
      // tools param MUST stay in the request: the transcript above holds
      // tool_use/tool_result blocks, and the Messages API rejects a request
      // that replays those without declaring the tools they refer to.
      // tool_choice none is the sanctioned "answer in text" knob. One turn
      // only: if this one is empty too, the caller fails it honestly.
      const final = await (await getClient()).messages.create({
        model,
        max_tokens: req.maxTokens,
        ...(req.system ? { system: req.system } : {}),
        tools,
        tool_choice: { type: 'none' },
        messages: withFinalAnswerRequest(messages),
      })
      return {
        text: textOf(final),
        model,
        usage: addUsage(usage, usageOf(final)),
        ...endOf(final),
        forcedFinal,
      }
    },

    async generateStructured(req: GenerateStructuredRequest): Promise<GenerateStructuredResult> {
      const model = modelFor(req.tier)
      // Forced tool choice is the reliable way to get schema-shaped output
      // from Claude (mirrors receipt-hunt's adjudicate/mail-intelligence).
      const params: MessageCreateParams = {
        model,
        max_tokens: req.maxTokens,
        ...(req.system ? { system: req.system } : {}),
        tools: [
          {
            name: req.schema.name,
            ...(req.schema.description ? { description: req.schema.description } : {}),
            input_schema: req.schema.jsonSchema as Anthropic.Messages.Tool['input_schema'],
          },
        ],
        tool_choice: { type: 'tool', name: req.schema.name },
        messages: [{ role: 'user', content: req.prompt }],
      }
      const resp = await (await getClient()).messages.create(params)
      const toolUse = resp.content.find(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use' && b.name === req.schema.name
      )
      if (!toolUse) {
        throw new Error(`Model answered without the forced tool "${req.schema.name}"`)
      }
      return { value: toolUse.input, model, usage: usageOf(resp) }
    },

    async extractFromDocument(req: ExtractFromDocumentRequest): Promise<ExtractFromDocumentResult> {
      if (!cfg.configured) return { ok: false, skipped: 'ai_unconfigured' }
      const model = modelFor(req.tier ?? 'extraction')
      // The system prompt is byte-stable per deploy and a few KB: marking it
      // ephemeral lets the backend reuse the prompt cache on rapid sequential
      // extractions (a user uploading a stack of receipts within minutes).
      // Bedrock honours the short default TTL; the direct API the same.
      const params: MessageCreateParams = {
        model,
        max_tokens: req.maxTokens,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildAnthropicDocumentContent(req.document, req.instruction) }],
      }
      const resp = await (await getClient()).messages.create(params)
      return {
        ok: true,
        text: textOf(resp),
        model,
        usage: usageOf(resp),
        ...(resp.stop_reason === 'max_tokens' ? { truncated: true } : {}),
      }
    },
  }
}
