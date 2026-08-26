// Job-shaped AI service interface.
//
// Call sites describe WHAT they need (a text answer, a schema-shaped object,
// the fields read out of a document) rather than HOW a particular backend is
// spoken to. The Anthropic-family service (Bedrock and the direct API) keeps
// hosted byte-identical by delegating to the existing client factory in
// lib/ai/provider.ts; the OpenAI-compatible service talks to any endpoint
// that implements the chat-completions API (the Swedish inference providers a
// sovereign self-host points at) through the Vercel AI SDK.
//
// Streaming members (the chat loop) are deliberately absent until the chat
// runtime decision is taken: see the Sovereign plan, alignment rule R3.

export type AiProviderKind = 'bedrock' | 'anthropic' | 'openai-compatible'

/**
 * Model tiers. `assistant` is the conversational/default tier, `heavy` the
 * deep-reasoning tier (supplier-invoice review, VAT review, bokslut), and
 * `extraction` the document-reading tier (a vision model on OpenAI-compatible
 * endpoints; Claude reads PDFs natively).
 */
export type AiTier = 'assistant' | 'heavy' | 'extraction'

export interface AiCapabilities {
  /** PDF bytes can be sent as a native document part, no rasterization. */
  pdfNative: boolean
  /** Images (and therefore scanned receipts) can be read at all. */
  imageInput: boolean
  toolUse: boolean
  /** The backend can be forced to answer with one named tool. */
  forcedToolChoice: boolean
  /** The backend enforces a JSON schema on the output (response_format). */
  strictJsonSchema: boolean
}

export type AiImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

export type AiDocumentInput =
  | { kind: 'pdf'; data: Buffer; fileName?: string }
  | { kind: 'image'; data: Buffer; mediaType: AiImageMediaType }
  /** Plain text already extracted by the caller (HTML mail invoices). Works on every model, vision or not. */
  | { kind: 'text'; text: string }

export interface AiUsage {
  inputTokens: number | null
  outputTokens: number | null
  cacheCreationInputTokens: number | null
  cacheReadInputTokens: number | null
}

/**
 * A tool the model may call during a bounded generateText loop.
 *
 * Provider-agnostic by construction: the OpenAI-compatible service maps it to
 * a Vercel AI SDK `tool()` and lets the SDK drive the loop; the Anthropic-
 * family service maps it to a Messages `tool` block and runs the loop by hand.
 * `execute` runs the tool and returns any JSON-serialisable value, which is
 * fed back to the model as the tool result. Only ever pass READ-only tools:
 * this path has no approval-card surface for staged writes.
 */
export interface AiToolDef {
  name: string
  description: string
  /** JSON Schema (draft-07 subset) for the tool's arguments. */
  jsonSchema: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

/**
 * One earlier turn of a conversation, text only. Sent to the model as a real
 * message turn (not inlined into the prompt), so the answer can refer back
 * to what was said without the caller re-describing it.
 */
export interface AiChatTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface GenerateTextRequest {
  tier: AiTier
  system?: string
  prompt: string
  maxTokens: number
  /**
   * Earlier turns of the same conversation, oldest first, placed before
   * `prompt` (which stays the final user message). Callers must hand over a
   * clean alternation that starts with a user turn (see
   * lib/agent/ask/persist.ts loadChatHistory); the services do not repair it.
   * Absent or empty leaves the request exactly as a single-turn call.
   */
  history?: AiChatTurn[]
  /**
   * Read-only tools the model may call to gather data before answering. When
   * present AND the backend supports tool use (capabilities.toolUse), the
   * service runs a bounded tool loop of up to `maxSteps` model turns; a
   * backend without tool support ignores them and answers from the prompt
   * alone (so a snapshot in the prompt is the fallback grounding).
   */
  tools?: AiToolDef[]
  /** Max model turns in the tool loop (default 4). Ignored when `tools` is absent. */
  maxSteps?: number
}

export interface GenerateTextResult {
  text: string
  model: string
  usage: AiUsage
}

export interface GenerateStructuredRequest {
  tier: AiTier
  system?: string
  prompt: string
  maxTokens: number
  schema: {
    name: string
    description?: string
    /** JSON Schema (draft-07 subset) for the expected object. Hand-maintained by the caller. */
    jsonSchema: Record<string, unknown>
  }
}

export interface GenerateStructuredResult {
  /** The model's object, NOT validated: callers run their own Zod parse. */
  value: unknown
  model: string
  usage: AiUsage
}

export interface ExtractFromDocumentRequest {
  document: AiDocumentInput
  /** Byte-stable system prompt. The Anthropic-family service marks it as a prompt-cache breakpoint. */
  system: string
  /** Trailing user instruction placed after the document part(s). */
  instruction: string
  maxTokens: number
  /**
   * Optional JSON schema for the answer. Used only when strict JSON mode is
   * on AND the backend supports it; otherwise the model answers in prose and
   * the caller's JSON extraction + Zod parse do the work (works everywhere).
   */
  jsonSchema?: Record<string, unknown>
}

export type ExtractionSkipReason =
  | 'ai_unconfigured'
  | 'ai_no_vision'
  | 'pdf_rasterizer_missing'
  | 'pdf_rasterize_failed'

export type ExtractFromDocumentResult =
  | { ok: true; text: string; model: string; usage: AiUsage; pagesRasterized?: number }
  | { ok: false; skipped: ExtractionSkipReason }

export interface AiService {
  readonly provider: AiProviderKind
  readonly capabilities: AiCapabilities
  /** Provider-form model id for a tier (Bedrock inference-profile prefix applied, etc.). */
  modelFor(tier: AiTier): string
  generateText(req: GenerateTextRequest): Promise<GenerateTextResult>
  generateStructured(req: GenerateStructuredRequest): Promise<GenerateStructuredResult>
  extractFromDocument(req: ExtractFromDocumentRequest): Promise<ExtractFromDocumentResult>
}

export type AiPdfMode = 'native' | 'rasterize'

export interface AiStatus {
  provider: AiProviderKind
  /** Credentials AND (for OpenAI-compatible) a model id are present. */
  configured: boolean
  reason: 'ok' | 'no_credentials' | 'no_model'
  capabilities: AiCapabilities
  models: Record<AiTier, string | null>
  pdfMode: AiPdfMode
  /**
   * Whether the in-app assistant (chat loop) can run. The loop still speaks
   * the Anthropic messages surface directly, so it needs the Anthropic family
   * until its streaming port lands; extraction and single-call jobs do not.
   */
  assistantAvailable: boolean
}
