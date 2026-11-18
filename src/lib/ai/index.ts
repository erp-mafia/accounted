import { readAiConfig, type ResolvedAiConfig } from './config'
import { createAnthropicFamilyService } from './services/anthropic-family'
import { createOpenAICompatibleService } from './services/openai-compatible'
import type { AiService } from './types'
import { withMetering } from './meter'
import { withCallLimit } from './call-limit'

export type {
  AiChatTurn,
  AiDocumentInput,
  AiEffort,
  AiImageMediaType,
  AiProgressEvent,
  AiService,
  AiToolDef,
  AiTier,
  ExtractionSkipReason,
} from './types'
export { getAiStatus, readAiConfig } from './config'
export { extractJsonObject } from './json'
export type { AiMeter } from './meter'
export { withAiMeter, AiSwitchedOffError, isAiSwitchedOffError } from './meter'
export { withAiDeadline, AiCallTimeoutError, AI_CALL_LIMIT_MS } from './call-limit'

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
    callLimitMs: cfg.callLimitMs,
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
  // Every call records its tokens (ai_usage_events) and has a time limit
  // (call-limit.ts), whichever feature made it.
  const service = withMetering(
    withCallLimit(
      cfg.provider === 'openai-compatible'
        ? createOpenAICompatibleService(cfg)
        : createAnthropicFamilyService(cfg),
      cfg.callLimitMs,
    ),
  )
  cached = { key, service }
  return service
}
