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
import { extractJsonObject } from '../json'
import { rasterizePdf } from '../rasterize-pdf'
import type {
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
 */

export function createOpenAICompatibleService(cfg: ResolvedAiConfig): AiService {
  const provider = createOpenAICompatible({
    name: 'accounted-byo',
    baseURL: cfg.baseUrl ?? '',
    // Only send a key when one is configured: a keyless local server would
    // reject or ignore an empty Bearer, and omitting it means no auth header.
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    supportsStructuredOutputs: cfg.strictJson,
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
      const result = await generateText({
        model: provider(model),
        ...(req.system ? { system: req.system } : {}),
        prompt: req.prompt,
        maxOutputTokens: req.maxTokens,
        ...(tools ? { tools, stopWhen: stepCountIs(req.maxSteps ?? DEFAULT_MAX_STEPS) } : {}),
      })
      return { text: result.text.trim(), model, usage: usageOf(result) }
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
      }
    },
  }
}
