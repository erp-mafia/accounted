import type Anthropic from '@anthropic-ai/sdk'
import { createAiClient, toProviderModelId, type AiClient } from '../provider'
import type { ResolvedAiConfig } from '../config'
import { capabilitiesFor } from '../config'
import type {
  AiDocumentInput,
  AiService,
  AiTier,
  AiUsage,
  ExtractFromDocumentRequest,
  ExtractFromDocumentResult,
  GenerateStructuredRequest,
  GenerateStructuredResult,
  GenerateTextRequest,
  GenerateTextResult,
} from '../types'

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
      const params: MessageCreateParams = {
        model,
        max_tokens: req.maxTokens,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content: req.prompt }],
      }
      const resp = await getClient().messages.create(params)
      return { text: textOf(resp), model, usage: usageOf(resp) }
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
