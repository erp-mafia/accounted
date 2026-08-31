import { getAiStatus, readAiConfig, type ResolvedAiConfig } from './config'
import { createAnthropicFamilyService } from './services/anthropic-family'
import { createOpenAICompatibleService } from './services/openai-compatible'
import type { AiService } from './types'

export type {
  AiCapabilities,
  AiChatTurn,
  AiDocumentInput,
  AiImageMediaType,
  AiPdfMode,
  AiProviderKind,
  AiService,
  AiToolDef,
  AiStatus,
  AiTier,
  AiUsage,
  ExtractFromDocumentRequest,
  ExtractFromDocumentResult,
  ExtractionSkipReason,
  GenerateStructuredRequest,
  GenerateStructuredResult,
  GenerateTextRequest,
  GenerateTextResult,
} from './types'
export { getAiStatus, readAiConfig, resolveTierModel } from './config'
export { extractJsonObject } from './json'

// One service per resolved configuration. Keyed on the non-secret parts of
// the config plus credential presence, so a changed environment (tests, the
// smoke script) gets a fresh service while a long-lived process reuses one.
let cached: { key: string; service: AiService } | null = null

function cacheKey(cfg: ResolvedAiConfig): string {
  return JSON.stringify({
    provider: cfg.provider,
    configured: cfg.configured,
    baseUrl: cfg.baseUrl,
    hasKey: !!cfg.apiKey,
    models: cfg.models,
    vision: cfg.vision,
    strictJson: cfg.strictJson,
    pdfMode: cfg.pdfMode,
    pdfMaxPages: cfg.pdfMaxPages,
  })
}

/**
 * The AI service for this deployment. Never throws on construction: an
 * unconfigured deployment still gets a service whose extractFromDocument
 * answers `skipped: ai_unconfigured`, so upload paths degrade quietly.
 */
export function getAiService(): AiService {
  const cfg = readAiConfig()
  const key = cacheKey(cfg)
  if (cached && cached.key === key) return cached.service
  const service =
    cfg.provider === 'openai-compatible'
      ? createOpenAICompatibleService(cfg)
      : createAnthropicFamilyService(cfg)
  cached = { key, service }
  return service
}

/** Tests only: drop the cached service so the next call re-reads the environment. */
export function resetAiServiceForTests(): void {
  cached = null
}
