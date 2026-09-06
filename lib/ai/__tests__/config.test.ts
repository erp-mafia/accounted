import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getAiStatus, readAiConfig, resolveTierModel } from '../config'
import { createAiClient, AiProviderUnsupportedError, hasAiCredentials, resolveAiProvider, toProviderModelId } from '../provider'

const KEYS = [
  'AI_PROVIDER',
  'AI_BASE_URL',
  'AI_API_KEY',
  'AI_MODEL',
  'AI_ASSISTANT_MODEL',
  'AI_HEAVY_MODEL',
  'AI_EXTRACTION_MODEL',
  'AI_EXTRACTION_MAX_TOKENS',
  'AI_VISION',
  'AI_STRICT_JSON',
  'AI_PDF_MODE',
  'AI_PDF_MAX_PAGES',
  'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'BEDROCK_MODEL_ID',
  'BEDROCK_SONNET_MODEL_ID',
  'BEDROCK_OPUS_MODEL_ID',
  'BEDROCK_MAX_TOKENS',
] as const

let saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {}
beforeEach(() => {
  saved = {}
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function hosted() {
  process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE'
  process.env.AWS_SECRET_ACCESS_KEY = 'secret'
}
function byo(model = 'google/gemma-4-31B-it') {
  process.env.AI_BASE_URL = 'https://api.berget.ai/v1'
  process.env.AI_API_KEY = 'sk-berget-example'
  if (model) process.env.AI_MODEL = model
}

describe('provider resolution with an OpenAI-compatible endpoint', () => {
  it('auto-detects AI_BASE_URL + AI_API_KEY when no Anthropic-family credentials exist', () => {
    byo()
    expect(resolveAiProvider()).toBe('openai-compatible')
    expect(hasAiCredentials()).toBe(true)
  })

  // Hosted stays hosted: a stray BYO pair must never move inference.
  it('keeps Bedrock ahead of a BYO endpoint when static AWS keys are present', () => {
    hosted()
    byo()
    expect(resolveAiProvider()).toBe('bedrock')
  })

  it('keeps the direct Anthropic API ahead of a BYO endpoint', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-example'
    byo()
    expect(resolveAiProvider()).toBe('anthropic')
  })

  it('honours AI_PROVIDER=openai-compatible as the explicit escape hatch', () => {
    hosted()
    byo()
    process.env.AI_PROVIDER = 'openai-compatible'
    expect(resolveAiProvider()).toBe('openai-compatible')
  })

  // AI_API_KEY is optional: a local OpenAI-compatible server usually has no
  // auth, so a base URL alone counts as configured. A key is added only when
  // the endpoint requires one.
  it('counts a base URL alone as credentials (keyless local server)', () => {
    process.env.AI_PROVIDER = 'openai-compatible'
    process.env.AI_BASE_URL = 'http://localhost:11434/v1'
    expect(hasAiCredentials()).toBe(true)
  })

  it('is not configured with no base URL at all', () => {
    process.env.AI_PROVIDER = 'openai-compatible'
    expect(hasAiCredentials()).toBe(false)
  })

  it('passes bare model ids through untouched', () => {
    expect(toProviderModelId('google/gemma-4-31B-it', 'openai-compatible')).toBe('google/gemma-4-31B-it')
  })

  // The chat loop and the other direct SDK callers cannot run here: fail
  // loudly at construction rather than with an opaque error at call time.
  it('refuses to build an Anthropic client for it', () => {
    byo()
    expect(() => createAiClient()).toThrow(AiProviderUnsupportedError)
  })
})

describe('resolveTierModel precedence', () => {
  it('defaults every tier to Claude on the Anthropic family', () => {
    hosted()
    expect(resolveTierModel('assistant')).toBe('claude-sonnet-5')
    expect(resolveTierModel('heavy')).toBe('claude-sonnet-5')
    expect(resolveTierModel('extraction')).toBe('claude-sonnet-5')
  })

  // Hosted operators set BEDROCK_* today; those must keep winning over the
  // new generic AI_MODEL so a migration to the new names is a no-op until
  // someone deliberately moves.
  it('lets the legacy Bedrock tier variables beat AI_MODEL, and AI_<TIER>_MODEL beat both', () => {
    hosted()
    process.env.AI_MODEL = 'generic'
    process.env.BEDROCK_MODEL_ID = 'legacy-extraction'
    process.env.BEDROCK_SONNET_MODEL_ID = 'legacy-assistant'
    process.env.BEDROCK_OPUS_MODEL_ID = 'legacy-heavy'
    expect(resolveTierModel('extraction')).toBe('legacy-extraction')
    expect(resolveTierModel('assistant')).toBe('legacy-assistant')
    expect(resolveTierModel('heavy')).toBe('legacy-heavy')

    process.env.AI_EXTRACTION_MODEL = 'specific-extraction'
    expect(resolveTierModel('extraction')).toBe('specific-extraction')
  })

  it('has no default on an OpenAI-compatible endpoint', () => {
    byo('')
    expect(resolveTierModel('extraction')).toBeNull()
    process.env.AI_MODEL = 'x'
    expect(resolveTierModel('extraction')).toBe('x')
    process.env.AI_EXTRACTION_MODEL = 'y'
    expect(resolveTierModel('extraction')).toBe('y')
    expect(resolveTierModel('assistant')).toBe('x')
  })
})

describe('readAiConfig', () => {
  it('reads the extraction output cap from the new name, then the legacy name, then 8192', () => {
    hosted()
    expect(readAiConfig().extractionMaxTokens).toBe(8192)
    process.env.BEDROCK_MAX_TOKENS = '4000'
    expect(readAiConfig().extractionMaxTokens).toBe(4000)
    process.env.AI_EXTRACTION_MAX_TOKENS = '12000'
    expect(readAiConfig().extractionMaxTokens).toBe(12000)
  })

  // A deliberate `0` is an invalid configuration, not "disable": fall back.
  it('ignores non-positive or garbage token caps', () => {
    hosted()
    process.env.AI_EXTRACTION_MAX_TOKENS = '0'
    expect(readAiConfig().extractionMaxTokens).toBe(8192)
    process.env.AI_EXTRACTION_MAX_TOKENS = 'lots'
    expect(readAiConfig().extractionMaxTokens).toBe(8192)
  })

  it('rasterizes PDFs by default on OpenAI-compatible endpoints and reads them natively on Claude', () => {
    byo()
    expect(readAiConfig().pdfMode).toBe('rasterize')
    process.env.AI_PDF_MODE = 'native'
    expect(readAiConfig().pdfMode).toBe('native')
  })

  it('reads PDFs natively on the Anthropic family regardless', () => {
    hosted()
    expect(readAiConfig().pdfMode).toBe('native')
  })

  it('parses the boolean flags with sane defaults', () => {
    byo()
    expect(readAiConfig().vision).toBe(true)
    expect(readAiConfig().strictJson).toBe(false)
    process.env.AI_VISION = 'false'
    process.env.AI_STRICT_JSON = '1'
    expect(readAiConfig().vision).toBe(false)
    expect(readAiConfig().strictJson).toBe(true)
  })
})

describe('getAiStatus', () => {
  it('is unconfigured with a reason when nothing is set', () => {
    const s = getAiStatus()
    expect(s.configured).toBe(false)
    expect(s.reason).toBe('no_credentials')
    expect(s.assistantAvailable).toBe(false)
  })

  it('is configured and assistant-capable on hosted', () => {
    hosted()
    const s = getAiStatus()
    expect(s.provider).toBe('bedrock')
    expect(s.configured).toBe(true)
    expect(s.assistantAvailable).toBe(true)
    expect(s.capabilities.pdfNative).toBe(true)
    expect(s.models.extraction).toBe('eu.anthropic.claude-sonnet-5')
  })

  it('is configured and assistant-capable on a direct Anthropic key', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-example'
    const s = getAiStatus()
    expect(s.provider).toBe('anthropic')
    expect(s.configured).toBe(true)
    expect(s.assistantAvailable).toBe(true)
  })

  it('needs a model id on an OpenAI-compatible endpoint before it counts as configured', () => {
    byo('')
    const s = getAiStatus()
    expect(s.configured).toBe(false)
    expect(s.reason).toBe('no_model')
  })

  // Extraction and single-call jobs run; the chat loop does not (yet).
  it('is configured but not assistant-capable on an OpenAI-compatible endpoint', () => {
    byo()
    const s = getAiStatus()
    expect(s.provider).toBe('openai-compatible')
    expect(s.configured).toBe(true)
    expect(s.assistantAvailable).toBe(false)
    expect(s.capabilities.pdfNative).toBe(false)
    expect(s.capabilities.imageInput).toBe(true)
    expect(s.models.extraction).toBe('google/gemma-4-31B-it')
  })

  it('reports AI_VISION=false as no image input', () => {
    byo()
    process.env.AI_VISION = 'false'
    expect(getAiStatus().capabilities.imageInput).toBe(false)
  })
})
