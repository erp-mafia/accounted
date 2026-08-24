import type Anthropic from '@anthropic-ai/sdk'
import { createAiClient, toProviderModelId, type AiClient } from '../provider'
import type { ResolvedAiConfig } from '../config'
import { capabilitiesFor } from '../config'
import type {
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

const EMPTY_USAGE: AiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
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
  const getClient = (): AiClient => {
    if (!client) client = createAiClient()
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
          messages: [{ role: 'user', content: req.prompt }],
        }
        const resp = await getClient().messages.create(params)
        return { text: textOf(resp), model, usage: usageOf(resp) }
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
      const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: req.prompt }]
      const maxSteps = req.maxSteps ?? DEFAULT_MAX_STEPS
      let usage = EMPTY_USAGE

      for (let step = 0; step < maxSteps; step++) {
        const resp = await getClient().messages.create({
          model,
          max_tokens: req.maxTokens,
          ...(req.system ? { system: req.system } : {}),
          tools,
          messages,
        })
        usage = addUsage(usage, usageOf(resp))
        if (resp.stop_reason !== 'tool_use') {
          return { text: textOf(resp), model, usage }
        }

        messages.push({ role: 'assistant', content: resp.content })
        const results: Anthropic.Messages.ContentBlockParam[] = []
        for (const block of resp.content) {
          if (block.type !== 'tool_use') continue
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

      // Spent the step budget without a final answer: force one more turn that
      // cannot call tools. The tools param MUST stay in the request: the
      // transcript above holds tool_use/tool_result blocks, and the Messages
      // API rejects a request that replays those without declaring the tools
      // they refer to. tool_choice none is the sanctioned "answer in text" knob.
      const final = await getClient().messages.create({
        model,
        max_tokens: req.maxTokens,
        ...(req.system ? { system: req.system } : {}),
        tools,
        tool_choice: { type: 'none' },
        messages,
      })
      return { text: textOf(final), model, usage: addUsage(usage, usageOf(final)) }
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
      const resp = await getClient().messages.create(params)
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
      const model = modelFor('extraction')
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
      const resp = await getClient().messages.create(params)
      return { ok: true, text: textOf(resp), model, usage: usageOf(resp) }
    },
  }
}
