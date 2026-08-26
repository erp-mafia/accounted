import {
  hasAiCredentials,
  resolveAiProvider,
  toProviderModelId,
  type AiProvider,
} from './provider'
import type { AiCapabilities, AiPdfMode, AiStatus, AiTier } from './types'

/**
 * Environment parsing for the AI layer. Read on every call (cheap string
 * reads) so tests and the smoke script see env changes; the service cache in
 * lib/ai/index.ts keys on the resolved config, not on this module's state.
 *
 * Variables (all optional; legacy BEDROCK_* names keep working):
 *
 *   AI_PROVIDER              bedrock | anthropic | openai-compatible (else auto-detect)
 *   AI_BASE_URL              OpenAI-compatible endpoint (Swedish provider or a local model)
 *   AI_API_KEY               optional: only when that endpoint requires auth
 *   AI_MODEL                 default model id for every tier
 *   AI_ASSISTANT_MODEL       per-tier overrides (fallbacks: BEDROCK_SONNET_MODEL_ID,
 *   AI_HEAVY_MODEL             BEDROCK_OPUS_MODEL_ID, BEDROCK_MODEL_ID respectively)
 *   AI_EXTRACTION_MODEL
 *   AI_EXTRACTION_MAX_TOKENS output cap for document extraction (fallback BEDROCK_MAX_TOKENS, then 8192)
 *   AI_VISION                OpenAI-compatible only: the configured models accept images (default true)
 *   AI_STRICT_JSON           OpenAI-compatible only: use response_format json_schema (default false)
 *   AI_PDF_MODE              auto | native | rasterize (auto = native on Claude, rasterize elsewhere)
 *   AI_PDF_MAX_PAGES         pages rasterized per PDF (default 4)
 */

export interface ResolvedAiConfig {
  provider: AiProvider
  /** Credentials present (and, for OpenAI-compatible, a model id). */
  configured: boolean
  reason: AiStatus['reason']
  baseUrl: string | null
  apiKey: string | null
  /** Bare model ids per tier (null only when OpenAI-compatible has none configured). */
  models: Record<AiTier, string | null>
  extractionMaxTokens: number
  vision: boolean
  strictJson: boolean
  pdfMode: AiPdfMode
  pdfMaxPages: number
}

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5'
const DEFAULT_EXTRACTION_MAX_TOKENS = 8192
const DEFAULT_PDF_MAX_PAGES = 4

function env(name: string): string | null {
  const v = process.env[name]
  if (v === undefined) return null
  const trimmed = v.trim()
  return trimmed.length > 0 ? trimmed : null
}

function envBool(name: string, fallback: boolean): boolean {
  const v = env(name)?.toLowerCase()
  if (v === null || v === undefined) return fallback
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false
  return fallback
}

// Use the env value only if it's a positive number: `||` would also fall back
// on a deliberate `0`, masking what is really an invalid configuration rather
// than the intent to disable.
function envPositiveInt(name: string): number | null {
  const raw = env(name)
  if (raw === null) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}

const LEGACY_TIER_VARS: Record<AiTier, string> = {
  assistant: 'BEDROCK_SONNET_MODEL_ID',
  heavy: 'BEDROCK_OPUS_MODEL_ID',
  extraction: 'BEDROCK_MODEL_ID',
}

const TIER_VARS: Record<AiTier, string> = {
  assistant: 'AI_ASSISTANT_MODEL',
  heavy: 'AI_HEAVY_MODEL',
  extraction: 'AI_EXTRACTION_MODEL',
}

/**
 * Model id for a tier, most specific wins: AI_<TIER>_MODEL, then the legacy
 * Bedrock-era tier variable, then AI_MODEL, then the Claude default on the
 * Anthropic family. An OpenAI-compatible endpoint has no sane default model,
 * so the result is null there and the status reports `no_model`.
 */
export function resolveTierModel(tier: AiTier, provider: AiProvider = resolveAiProvider()): string | null {
  const specific = env(TIER_VARS[tier]) ?? env(LEGACY_TIER_VARS[tier]) ?? env('AI_MODEL')
  if (specific) return specific
  return provider === 'openai-compatible' ? null : DEFAULT_CLAUDE_MODEL
}

export function readAiConfig(): ResolvedAiConfig {
  const provider = resolveAiProvider()
  const models: Record<AiTier, string | null> = {
    assistant: resolveTierModel('assistant', provider),
    heavy: resolveTierModel('heavy', provider),
    extraction: resolveTierModel('extraction', provider),
  }
  const credentials = hasAiCredentials()
  const isOpenAiCompatible = provider === 'openai-compatible'
  const hasModels = !isOpenAiCompatible || Object.values(models).every((m) => m !== null)

  const pdfModeRaw = env('AI_PDF_MODE')?.toLowerCase()
  const pdfMode: AiPdfMode =
    pdfModeRaw === 'native' || pdfModeRaw === 'rasterize'
      ? pdfModeRaw
      : isOpenAiCompatible
        ? 'rasterize'
        : 'native'

  return {
    provider,
    configured: credentials && hasModels,
    reason: !credentials ? 'no_credentials' : !hasModels ? 'no_model' : 'ok',
    baseUrl: isOpenAiCompatible ? env('AI_BASE_URL') : null,
    apiKey: isOpenAiCompatible ? env('AI_API_KEY') : null,
    models,
    extractionMaxTokens:
      envPositiveInt('AI_EXTRACTION_MAX_TOKENS') ??
      envPositiveInt('BEDROCK_MAX_TOKENS') ??
      DEFAULT_EXTRACTION_MAX_TOKENS,
    vision: envBool('AI_VISION', true),
    strictJson: envBool('AI_STRICT_JSON', false),
    pdfMode,
    pdfMaxPages: envPositiveInt('AI_PDF_MAX_PAGES') ?? DEFAULT_PDF_MAX_PAGES,
  }
}

export function capabilitiesFor(cfg: ResolvedAiConfig): AiCapabilities {
  if (cfg.provider === 'openai-compatible') {
    return {
      pdfNative: cfg.pdfMode === 'native',
      imageInput: cfg.vision,
      toolUse: true,
      forcedToolChoice: false,
      strictJsonSchema: cfg.strictJson,
    }
  }
  return {
    pdfNative: true,
    imageInput: true,
    toolUse: true,
    forcedToolChoice: true,
    strictJsonSchema: false,
  }
}

/**
 * Single source of truth for "is AI wired up here, and for what". Cheap: env
 * reads only, no network. Drives the extraction fail-fast path (a document is
 * stamped `skipped:ai_unconfigured` instead of waiting 30 s for nothing), the
 * status route, agent routes (503 instead of a stream that dies), and the
 * smoke script.
 */
export function getAiStatus(): AiStatus {
  const cfg = readAiConfig()
  const capabilities = capabilitiesFor(cfg)
  const models: Record<AiTier, string | null> = {
    assistant: cfg.models.assistant ? toProviderModelId(cfg.models.assistant, cfg.provider) : null,
    heavy: cfg.models.heavy ? toProviderModelId(cfg.models.heavy, cfg.provider) : null,
    extraction: cfg.models.extraction ? toProviderModelId(cfg.models.extraction, cfg.provider) : null,
  }
  return {
    provider: cfg.provider,
    configured: cfg.configured,
    reason: cfg.reason,
    capabilities,
    models,
    pdfMode: cfg.pdfMode,
    // The chat loop still speaks the Anthropic messages surface directly.
    assistantAvailable: cfg.configured && cfg.provider !== 'openai-compatible',
  }
}
