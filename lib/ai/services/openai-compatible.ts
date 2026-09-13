import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  generateText,
  jsonSchema,
  Output,
  stepCountIs,
  tool,
  type ModelMessage,
  type ToolSet,
  type UserContent,
} from 'ai'
import { capabilitiesFor, type ResolvedAiConfig } from '../config'
import { wrapGeminiThoughtSignatureFetch } from '../gemini-thought-signatures'
import { extractJsonObject } from '../json'
import { rasterizePdf } from '../rasterize-pdf'
import type {
  AiChatTurn,
  AiDocumentInput,
  AiService,
  AiTier,
  AiToolDef,
  AiUsage,
  ExtractFromDocumentRequest,
  ExtractFromDocumentResult,
  ExtractionSkipReason,
  GenerateStructuredRequest,
  GenerateStructuredResult,
  GenerateTextRequest,
  GenerateTextResult,
} from '../types'

const DEFAULT_MAX_STEPS = 4

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
  }
}

/** Earlier turns as message turns, then the prompt as the final user message. */
function messagesWithHistory(prompt: string, history: AiChatTurn[]): ModelMessage[] {
  const prior: ModelMessage[] = history.map((t) =>
    t.role === 'assistant'
      ? { role: 'assistant', content: t.text }
      : { role: 'user', content: t.text },
  )
  return [...prior, { role: 'user', content: prompt }]
}

/**
 * Map our provider-agnostic tool defs onto the AI SDK's tool() shape. The SDK
 * runs the loop itself (calls execute, feeds the result back) up to the
 * stopWhen bound. Returns undefined when there is nothing to attach.
 */
function toSdkTools(defs: AiToolDef[] | undefined): ToolSet | undefined {
  if (!defs || defs.length === 0) return undefined
  const out: ToolSet = {}
  for (const def of defs) {
    out[def.name] = tool({
      description: def.description,
      inputSchema: jsonSchema<Record<string, unknown>>(def.jsonSchema),
      execute: async (args) => {
        const result = await def.execute((args ?? {}) as Record<string, unknown>)
        // The SDK serialises whatever we return as the tool result; null is a
        // valid "nothing" that a model reads fine, undefined is not.
        return result ?? null
      },
    })
  }
  return out
}

/**
 * Any endpoint speaking the OpenAI chat-completions API, through the Vercel
 * AI SDK's openai-compatible provider. This is the sovereign self-host path:
 * the operator points AI_BASE_URL + AI_API_KEY at a Swedish inference
 * provider (Berget AI, evroc, ...) and names the models per tier.
 *
 * Scope discipline: the AI SDK is used ONLY here. The hosted Bedrock /
 * direct-API path stays on the Anthropic SDK (services/anthropic-family.ts)
 * and no call site imports `ai` directly (antipattern guard direct-ai-client).
 *
 * Provider quirks this has to absorb, by design choice:
 *   - PDFs: most such endpoints have no PDF part; the default is to rasterize
 *     the first pages with poppler (AI_PDF_MODE=rasterize). Operators whose
 *     provider accepts the OpenAI `file` part can set AI_PDF_MODE=native.
 *   - Vision: AI_VISION=false declares a text-only model; images and PDFs are
 *     then skipped honestly (`ai_no_vision`) instead of failing with a 400.
 *     HTML mail invoices arrive as text and extract on every model.
 *   - JSON: the default is JSON-in-prose plus the caller's extraction + Zod,
 *     which works everywhere; AI_STRICT_JSON=true opts into response_format
 *     json_schema for providers that enforce it.
 *   - Gemini 3 thought signatures: Google's OpenAI-compat tool loop 400s
 *     unless extra_content.google.thought_signature is echoed. Wrapped fetch
 *     restores that field; other OpenAI-compat endpoints are untouched.
 */

export function createOpenAICompatibleService(cfg: ResolvedAiConfig): AiService {
  const provider = createOpenAICompatible({
    name: 'accounted-byo',
    baseURL: cfg.baseUrl ?? '',
    // Only send a key when one is configured: a keyless local server would
    // reject or ignore an empty Bearer, and omitting it means no auth header.
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    supportsStructuredOutputs: cfg.strictJson,
    // Gemini 3 400s a tool-loop turn when thought_signature is dropped. The
    // SDK stores it under this custom provider name and only echoes
    // providerOptions.google; wrap fetch so the wire format is restored.
    fetch: wrapGeminiThoughtSignatureFetch(),
  })
  const capabilities = capabilitiesFor(cfg)
  const modelFor = (tier: AiTier): string => {
    const id = cfg.models[tier]
    if (!id) throw new Error(`No AI model configured for tier "${tier}" (set AI_MODEL or AI_${tier.toUpperCase()}_MODEL)`)
    return id
  }

  function usageOf(result: { usage: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } } }): AiUsage {
    const u = result.usage
    return {
      inputTokens: u.inputTokens ?? null,
      outputTokens: u.outputTokens ?? null,
      cacheCreationInputTokens: u.inputTokenDetails?.cacheWriteTokens ?? null,
      cacheReadInputTokens: u.inputTokenDetails?.cacheReadTokens ?? null,
    }
  }

  async function buildUserContent(
    document: AiDocumentInput,
    instruction: string
  ): Promise<
    | { ok: true; content: UserContent; pagesRasterized?: number }
    | { ok: false; skipped: ExtractionSkipReason }
  > {
    const tail = { type: 'text' as const, text: instruction }
    if (document.kind === 'text') {
      return { ok: true, content: [{ type: 'text', text: document.text }, tail] }
    }
    if (!capabilities.imageInput) return { ok: false, skipped: 'ai_no_vision' }
    if (document.kind === 'image') {
      return {
        ok: true,
        content: [{ type: 'image', image: document.data, mediaType: document.mediaType }, tail],
      }
    }
    // PDF
    if (capabilities.pdfNative) {
      return {
        ok: true,
        content: [
          {
            type: 'file',
            data: document.data,
            mediaType: 'application/pdf',
            ...(document.fileName ? { filename: document.fileName } : {}),
          },
          tail,
        ],
      }
    }
    const raster = await rasterizePdf(document.data, { maxPages: cfg.pdfMaxPages })
    if (!raster.ok) {
      return {
        ok: false,
        skipped: raster.reason === 'rasterizer_missing' ? 'pdf_rasterizer_missing' : 'pdf_rasterize_failed',
      }
    }
    return {
      ok: true,
      pagesRasterized: raster.pageCount,
      content: [
        ...raster.pages.map((page) => ({ type: 'image' as const, image: page, mediaType: raster.mediaType })),
        tail,
      ],
    }
  }

  return {
    provider: cfg.provider,
    capabilities,
    modelFor,

    async generateText(req: GenerateTextRequest): Promise<GenerateTextResult> {
      const model = modelFor(req.tier)
      // Only attach tools when the configured model advertises tool use; a
      // text-only local model still answers, just from the prompt (+ snapshot).
      const tools = capabilities.toolUse ? toSdkTools(req.tools) : undefined
      const maxSteps = req.maxSteps ?? DEFAULT_MAX_STEPS
      const hasHistory = req.history && req.history.length > 0
      const initialMessages: ModelMessage[] = hasHistory
        ? messagesWithHistory(req.prompt, req.history)
        : [{ role: 'user', content: req.prompt }]

      const result = await generateText({
        model: provider(model),
        ...(req.system ? { system: req.system } : {}),
        // The SDK takes either `prompt` or `messages`, never both: a plain
        // single-turn call keeps `prompt`; a conversation sends the earlier
        // turns as real messages with the prompt as the final user turn.
        ...(hasHistory ? { messages: initialMessages } : { prompt: req.prompt }),
        maxOutputTokens: req.maxTokens,
        ...(tools
          ? {
              tools,
              stopWhen: stepCountIs(maxSteps),
              // Mirror anthropic-family: the last allowed step must answer in
              // prose. Without this, a VAT-style first question can burn the
              // whole step budget on tool calls and return empty text.
              prepareStep: ({ stepNumber }) =>
                stepNumber === maxSteps - 1 ? { toolChoice: 'none' as const } : {},
            }
          : {}),
      })

      let text = result.text.trim()
      let usage = usageOf(result)

      // Belt-and-suspenders: if the model still ends tool-only (ignored
      // toolChoice, or max_tokens on the last step), replay the transcript
      // once more with tools declared but toolChoice none.
      if (!text && tools && result.steps.length > 0) {
        const final = await generateText({
          model: provider(model),
          ...(req.system ? { system: req.system } : {}),
          messages: [...initialMessages, ...result.response.messages],
          maxOutputTokens: req.maxTokens,
          tools,
          toolChoice: 'none',
        })
        text = final.text.trim()
        usage = addUsage(usage, usageOf(final))
      }

      return { text, model, usage }
    },

    async generateStructured(req: GenerateStructuredRequest): Promise<GenerateStructuredResult> {
      const model = modelFor(req.tier)
      if (cfg.strictJson) {
        const result = await generateText({
          model: provider(model),
          ...(req.system ? { system: req.system } : {}),
          prompt: req.prompt,
          maxOutputTokens: req.maxTokens,
          output: Output.object({ schema: jsonSchema<Record<string, unknown>>(req.schema.jsonSchema) }),
        })
        return { value: result.output, model, usage: usageOf(result) }
      }
      // Prose JSON: ask for the shape in the prompt, then pull the first
      // parseable object out of whatever the model wrapped it in.
      const schemaHint =
        `Answer with ONLY a single JSON object${req.schema.description ? ` (${req.schema.description})` : ''}` +
        ` matching this JSON Schema, no prose, no markdown fences:\n${JSON.stringify(req.schema.jsonSchema)}`
      const result = await generateText({
        model: provider(model),
        system: req.system ? `${req.system}\n\n${schemaHint}` : schemaHint,
        prompt: req.prompt,
        maxOutputTokens: req.maxTokens,
      })
      const value: unknown = JSON.parse(extractJsonObject(result.text))
      return { value, model, usage: usageOf(result) }
    },

    async extractFromDocument(req: ExtractFromDocumentRequest): Promise<ExtractFromDocumentResult> {
      if (!cfg.configured) return { ok: false, skipped: 'ai_unconfigured' }
      const model = modelFor('extraction')
      const built = await buildUserContent(req.document, req.instruction)
      if (!built.ok) return { ok: false, skipped: built.skipped }
      const messages: ModelMessage[] = [{ role: 'user', content: built.content }]
      if (cfg.strictJson && req.jsonSchema) {
        const result = await generateText({
          model: provider(model),
          system: req.system,
          messages,
          maxOutputTokens: req.maxTokens,
          output: Output.object({ schema: jsonSchema<Record<string, unknown>>(req.jsonSchema) }),
        })
        return {
          ok: true,
          text: JSON.stringify(result.output),
          model,
          usage: usageOf(result),
          ...(built.pagesRasterized ? { pagesRasterized: built.pagesRasterized } : {}),
          ...(result.finishReason === 'length' ? { truncated: true } : {}),
        }
      }
      const result = await generateText({
        model: provider(model),
        system: req.system,
        messages,
        maxOutputTokens: req.maxTokens,
      })
      return {
        ok: true,
        text: result.text.trim(),
        model,
        usage: usageOf(result),
        ...(built.pagesRasterized ? { pagesRasterized: built.pagesRasterized } : {}),
        ...(result.finishReason === 'length' ? { truncated: true } : {}),
      }
    },
  }
}
