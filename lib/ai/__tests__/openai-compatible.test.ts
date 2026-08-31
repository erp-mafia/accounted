import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'

// Replace the provider factory with one that hands out a mock model, then
// run the REAL `generateText` from the AI SDK through it: the assertions see
// the prompt the SDK would put on the wire (image parts, file parts, system),
// which is what an OpenAI-compatible endpoint receives.
const doGenerate = vi.fn()
const createdWith = vi.fn()
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: (settings: unknown) => {
    createdWith(settings)
    const factory = (modelId: string) =>
      new MockLanguageModelV3({
        modelId,
        doGenerate: async (options: unknown) => doGenerate(options),
      })
    return factory
  },
}))

const rasterizeMock = vi.fn()
vi.mock('../rasterize-pdf', () => ({
  rasterizePdf: (...args: unknown[]) => rasterizeMock(...args),
}))

import { readAiConfig } from '../config'
import { createOpenAICompatibleService } from '../services/openai-compatible'

const ENV = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_EXTRACTION_MODEL', 'AI_VISION', 'AI_STRICT_JSON', 'AI_PDF_MODE', 'AI_PDF_MAX_PAGES'] as const
let saved: Record<string, string | undefined> = {}

function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: 42, noCache: 40, cacheRead: 2, cacheWrite: undefined },
      outputTokens: { total: 7, text: 7, reasoning: undefined },
    },
    warnings: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  saved = {}
  for (const k of ENV) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  process.env.AI_BASE_URL = 'https://api.berget.ai/v1'
  process.env.AI_API_KEY = 'sk-berget-example'
  process.env.AI_MODEL = 'google/gemma-4-31B-it'
  doGenerate.mockResolvedValue(textResponse('{"supplier":"x"}'))
})
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const SYSTEM = 'You extract fields.'
const INSTRUCTION = 'Extract the fields per the schema. JSON only.'

function promptOf(call = 0) {
  return doGenerate.mock.calls[call][0].prompt as Array<{ role: string; content: unknown }>
}

describe('createOpenAICompatibleService', () => {
  it('builds the provider from AI_BASE_URL / AI_API_KEY', () => {
    createOpenAICompatibleService(readAiConfig())
    expect(createdWith).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://api.berget.ai/v1', apiKey: 'sk-berget-example', supportsStructuredOutputs: false })
    )
  })

  it('reports capabilities from the config: rasterized PDFs, vision on, no strict JSON by default', () => {
    const svc = createOpenAICompatibleService(readAiConfig())
    expect(svc.capabilities).toEqual({
      pdfNative: false,
      imageInput: true,
      toolUse: true,
      forcedToolChoice: false,
      strictJsonSchema: false,
    })
    expect(svc.modelFor('extraction')).toBe('google/gemma-4-31B-it')
  })

  it('generateText sends system + prompt and maps usage', async () => {
    const svc = createOpenAICompatibleService(readAiConfig())
    const result = await svc.generateText({ tier: 'assistant', system: 'S', prompt: 'Hej', maxTokens: 50 })
    const prompt = promptOf()
    expect(prompt[0]).toEqual({ role: 'system', content: 'S' })
    expect(prompt[1].role).toBe('user')
    expect(doGenerate.mock.calls[0][0].maxOutputTokens).toBe(50)
    expect(result).toEqual({
      text: '{"supplier":"x"}',
      model: 'google/gemma-4-31B-it',
      usage: { inputTokens: 42, outputTokens: 7, cacheCreationInputTokens: null, cacheReadInputTokens: 2 },
    })
  })

  it('generateText sends earlier turns as message turns before the prompt', async () => {
    const svc = createOpenAICompatibleService(readAiConfig())
    await svc.generateText({
      tier: 'assistant',
      system: 'S',
      prompt: 'Och förra månaden?',
      maxTokens: 50,
      history: [
        { role: 'user', text: 'Vad är min största utgift?' },
        { role: 'assistant', text: '12 345 kr på 5010.' },
      ],
    })
    const prompt = promptOf()
    expect(prompt.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(prompt[1].content).toEqual([{ type: 'text', text: 'Vad är min största utgift?' }])
    expect(prompt[2].content).toEqual([{ type: 'text', text: '12 345 kr på 5010.' }])
    expect(prompt[3].content).toEqual([{ type: 'text', text: 'Och förra månaden?' }])
  })

  it('generateText forwards read-only tools to the model when provided', async () => {
    const svc = createOpenAICompatibleService(readAiConfig())
    const execute = vi.fn().mockResolvedValue({ ok: true })
    await svc.generateText({
      tier: 'assistant',
      prompt: 'Vad är min största utgift?',
      maxTokens: 50,
      tools: [
        { name: 'gnubok_get_income_statement', description: 'd', jsonSchema: { type: 'object' }, execute },
      ],
      maxSteps: 4,
    })
    // The AI SDK converts our defs and hands them to the model on the wire.
    const passedTools = doGenerate.mock.calls[0][0].tools as Array<{ name: string }>
    expect(Array.isArray(passedTools)).toBe(true)
    expect(passedTools.some((t) => t.name === 'gnubok_get_income_statement')).toBe(true)
  })

  it('generateText attaches no tools when none are provided (plain single call)', async () => {
    const svc = createOpenAICompatibleService(readAiConfig())
    await svc.generateText({ tier: 'assistant', prompt: 'Hej', maxTokens: 50 })
    const passedTools = doGenerate.mock.calls[0][0].tools
    expect(passedTools == null || (Array.isArray(passedTools) && passedTools.length === 0)).toBe(true)
  })

  it('extractFromDocument sends an image as an image part followed by the instruction', async () => {
    const svc = createOpenAICompatibleService(readAiConfig())
    const jpeg = Buffer.from('JPEG')
    const result = await svc.extractFromDocument({
      document: { kind: 'image', data: jpeg, mediaType: 'image/jpeg' },
      system: SYSTEM,
      instruction: INSTRUCTION,
      maxTokens: 8192,
    })
    expect(result.ok).toBe(true)
    const prompt = promptOf()
    expect(prompt[0]).toEqual({ role: 'system', content: SYSTEM })
    const user = prompt[1].content as Array<{ type: string; mediaType?: string; text?: string }>
    expect(user[0].type).toBe('file')
    expect(user[0].mediaType).toBe('image/jpeg')
    expect(user[1]).toEqual({ type: 'text', text: INSTRUCTION })
  })

  it('extractFromDocument sends plain text as two text parts (works on text-only models)', async () => {
    process.env.AI_VISION = 'false'
    const svc = createOpenAICompatibleService(readAiConfig())
    const result = await svc.extractFromDocument({
      document: { kind: 'text', text: 'Total 100' },
      system: SYSTEM,
      instruction: INSTRUCTION,
      maxTokens: 100,
    })
    expect(result.ok).toBe(true)
    const user = promptOf()[1].content as Array<{ type: string; text?: string }>
    expect(user).toEqual([
      { type: 'text', text: 'Total 100' },
      { type: 'text', text: INSTRUCTION },
    ])
  })

  it('rasterizes PDFs by default and sends one image part per page', async () => {
    rasterizeMock.mockResolvedValue({
      ok: true,
      pages: [Buffer.from('p1'), Buffer.from('p2')],
      mediaType: 'image/png',
      pageCount: 2,
    })
    const svc = createOpenAICompatibleService(readAiConfig())
    const result = await svc.extractFromDocument({
      document: { kind: 'pdf', data: Buffer.from('%PDF'), fileName: 'f.pdf' },
      system: SYSTEM,
      instruction: INSTRUCTION,
      maxTokens: 100,
    })
    expect(rasterizeMock).toHaveBeenCalledWith(expect.any(Buffer), { maxPages: 4 })
    expect(result).toMatchObject({ ok: true, pagesRasterized: 2 })
    const user = promptOf()[1].content as Array<{ type: string; mediaType?: string }>
    expect(user.map((p) => p.type)).toEqual(['file', 'file', 'text'])
    expect(user[0].mediaType).toBe('image/png')
  })

  it('sends the PDF as a native file part when AI_PDF_MODE=native', async () => {
    process.env.AI_PDF_MODE = 'native'
    const svc = createOpenAICompatibleService(readAiConfig())
    await svc.extractFromDocument({
      document: { kind: 'pdf', data: Buffer.from('%PDF'), fileName: 'f.pdf' },
      system: SYSTEM,
      instruction: INSTRUCTION,
      maxTokens: 100,
    })
    expect(rasterizeMock).not.toHaveBeenCalled()
    const user = promptOf()[1].content as Array<{ type: string; mediaType?: string; filename?: string }>
    expect(user[0]).toMatchObject({ type: 'file', mediaType: 'application/pdf', filename: 'f.pdf' })
  })

  // Honest skips, never fake failures: the caller stamps the reason.
  it('skips images and PDFs when AI_VISION=false', async () => {
    process.env.AI_VISION = 'false'
    const svc = createOpenAICompatibleService(readAiConfig())
    const image = await svc.extractFromDocument({
      document: { kind: 'image', data: Buffer.from('x'), mediaType: 'image/png' },
      system: SYSTEM,
      instruction: INSTRUCTION,
      maxTokens: 1,
    })
    const pdf = await svc.extractFromDocument({
      document: { kind: 'pdf', data: Buffer.from('%PDF') },
      system: SYSTEM,
      instruction: INSTRUCTION,
      maxTokens: 1,
    })
    expect(image).toEqual({ ok: false, skipped: 'ai_no_vision' })
    expect(pdf).toEqual({ ok: false, skipped: 'ai_no_vision' })
    expect(doGenerate).not.toHaveBeenCalled()
  })

  it('skips with pdf_rasterizer_missing when poppler is not installed', async () => {
    rasterizeMock.mockResolvedValue({ ok: false, reason: 'rasterizer_missing' })
    const svc = createOpenAICompatibleService(readAiConfig())
    const result = await svc.extractFromDocument({
      document: { kind: 'pdf', data: Buffer.from('%PDF') },
      system: SYSTEM,
      instruction: INSTRUCTION,
      maxTokens: 1,
    })
    expect(result).toEqual({ ok: false, skipped: 'pdf_rasterizer_missing' })
    expect(doGenerate).not.toHaveBeenCalled()
  })

  it('skips with ai_unconfigured when the model is missing', async () => {
    delete process.env.AI_MODEL
    const svc = createOpenAICompatibleService(readAiConfig())
    const result = await svc.extractFromDocument({
      document: { kind: 'text', text: 'x' },
      system: SYSTEM,
      instruction: INSTRUCTION,
      maxTokens: 1,
    })
    expect(result).toEqual({ ok: false, skipped: 'ai_unconfigured' })
  })

  it('generateStructured without strict JSON embeds the schema and parses the first JSON object', async () => {
    doGenerate.mockResolvedValueOnce(textResponse('Here you go:\n```json\n{"paired": true}\n```'))
    const svc = createOpenAICompatibleService(readAiConfig())
    const result = await svc.generateStructured({
      tier: 'heavy',
      prompt: 'Decide',
      maxTokens: 100,
      schema: { name: 'verdict', description: 'pairing verdict', jsonSchema: { type: 'object' } },
    })
    expect(result.value).toEqual({ paired: true })
    const system = promptOf()[0].content as string
    expect(system).toContain('JSON Schema')
    expect(system).toContain('pairing verdict')
  })

  it('turns on structured outputs at the provider when AI_STRICT_JSON=true', () => {
    process.env.AI_STRICT_JSON = 'true'
    const svc = createOpenAICompatibleService(readAiConfig())
    expect(createdWith).toHaveBeenLastCalledWith(expect.objectContaining({ supportsStructuredOutputs: true }))
    expect(svc.capabilities.strictJsonSchema).toBe(true)
  })
})
