import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Drive the service against a fake Bedrock client: the point of these tests
// is the REQUEST SHAPE. Hosted stays byte-identical only if the service sends
// exactly the literals the call sites sent before the abstraction existed.
const mockCreate = vi.fn()
vi.mock('@anthropic-ai/bedrock-sdk', () => {
  class FakeBedrock {
    messages = { create: mockCreate }
  }
  return { default: FakeBedrock }
})

import { readAiConfig } from '../config'
import { createAnthropicFamilyService, buildAnthropicDocumentContent } from '../services/anthropic-family'

const ENV = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'BEDROCK_MODEL_ID', 'AI_EXTRACTION_MODEL', 'AI_MODEL'] as const
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  vi.clearAllMocks()
  saved = {}
  for (const k of ENV) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE'
  process.env.AWS_SECRET_ACCESS_KEY = 'secret'
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: '{"ok":true}' }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 },
  })
})
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const SYSTEM = 'You extract fields.'
const INSTRUCTION = 'Extract the fields per the schema. JSON only.'

describe('extractFromDocument request shape (hosted regression net)', () => {
  it('sends a PDF exactly as the inbox extractor did: cached system block, document part, instruction', async () => {
    const svc = createAnthropicFamilyService(readAiConfig())
    const pdf = Buffer.from('%PDF-1.4')
    const result = await svc.extractFromDocument({
      document: { kind: 'pdf', data: pdf, fileName: 'faktura.pdf' },
      system: SYSTEM,
      instruction: INSTRUCTION,
      maxTokens: 8192,
    })
    expect(result.ok).toBe(true)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockCreate.mock.calls[0][0]).toEqual({
      model: 'eu.anthropic.claude-sonnet-5',
      max_tokens: 8192,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
            },
            { type: 'text', text: INSTRUCTION },
          ],
        },
      ],
    })
  })

  it('sends an image as a base64 image block with its media type', async () => {
    const svc = createAnthropicFamilyService(readAiConfig())
    const jpeg = Buffer.from('JPEG')
    await svc.extractFromDocument({
      document: { kind: 'image', data: jpeg, mediaType: 'image/jpeg' },
      system: SYSTEM,
      instruction: INSTRUCTION,
      maxTokens: 8192,
    })
    expect(mockCreate.mock.calls[0][0].messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
      { type: 'text', text: INSTRUCTION },
    ])
  })

  it('sends converted HTML as two text blocks', async () => {
    const svc = createAnthropicFamilyService(readAiConfig())
    await svc.extractFromDocument({
      document: { kind: 'text', text: 'The document is an HTML email invoice, converted to plain text:\n\nTotal 100' },
      system: SYSTEM,
      instruction: INSTRUCTION,
      maxTokens: 8192,
    })
    expect(mockCreate.mock.calls[0][0].messages[0].content).toEqual([
      { type: 'text', text: 'The document is an HTML email invoice, converted to plain text:\n\nTotal 100' },
      { type: 'text', text: INSTRUCTION },
    ])
  })

  it('returns the text, model and usage', async () => {
    const svc = createAnthropicFamilyService(readAiConfig())
    const result = await svc.extractFromDocument({
      document: { kind: 'text', text: 'x' },
      system: SYSTEM,
      instruction: INSTRUCTION,
      maxTokens: 100,
    })
    expect(result).toEqual({
      ok: true,
      text: '{"ok":true}',
      model: 'eu.anthropic.claude-sonnet-5',
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 7 },
    })
  })

  it('honours the extraction tier override (legacy BEDROCK_MODEL_ID)', async () => {
    process.env.BEDROCK_MODEL_ID = 'claude-sonnet-4-6'
    const svc = createAnthropicFamilyService(readAiConfig())
    await svc.extractFromDocument({ document: { kind: 'text', text: 'x' }, system: SYSTEM, instruction: INSTRUCTION, maxTokens: 1 })
    expect(mockCreate.mock.calls[0][0].model).toBe('eu.anthropic.claude-sonnet-4-6')
  })

  it('skips without a call when the deployment has no credentials', async () => {
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
    const svc = createAnthropicFamilyService(readAiConfig())
    const result = await svc.extractFromDocument({ document: { kind: 'text', text: 'x' }, system: SYSTEM, instruction: INSTRUCTION, maxTokens: 1 })
    expect(result).toEqual({ ok: false, skipped: 'ai_unconfigured' })
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe('generateText / generateStructured', () => {
  it('generateText sends a plain user message with an optional system string', async () => {
    const svc = createAnthropicFamilyService(readAiConfig())
    const result = await svc.generateText({ tier: 'assistant', system: 'S', prompt: 'Hej', maxTokens: 50 })
    expect(mockCreate.mock.calls[0][0]).toEqual({
      model: 'eu.anthropic.claude-sonnet-5',
      max_tokens: 50,
      system: 'S',
      messages: [{ role: 'user', content: 'Hej' }],
    })
    expect(result.text).toBe('{"ok":true}')
  })

  it('generateStructured forces one named tool and returns its input', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 't1', name: 'verdict', input: { paired: true } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const svc = createAnthropicFamilyService(readAiConfig())
    const schema = { type: 'object', properties: { paired: { type: 'boolean' } }, required: ['paired'] }
    const result = await svc.generateStructured({
      tier: 'heavy',
      prompt: 'Decide',
      maxTokens: 200,
      schema: { name: 'verdict', description: 'd', jsonSchema: schema },
    })
    expect(mockCreate.mock.calls[0][0]).toEqual({
      model: 'eu.anthropic.claude-sonnet-5',
      max_tokens: 200,
      tools: [{ name: 'verdict', description: 'd', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'verdict' },
      messages: [{ role: 'user', content: 'Decide' }],
    })
    expect(result.value).toEqual({ paired: true })
  })

  it('generateStructured throws when the model ignored the forced tool', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'nope' }], usage: {} })
    const svc = createAnthropicFamilyService(readAiConfig())
    await expect(
      svc.generateStructured({ tier: 'assistant', prompt: 'x', maxTokens: 10, schema: { name: 'v', jsonSchema: {} } })
    ).rejects.toThrow(/forced tool/)
  })
})

describe('buildAnthropicDocumentContent', () => {
  it('is a pure function of the document and instruction', () => {
    expect(buildAnthropicDocumentContent({ kind: 'text', text: 'a' }, 'b')).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])
  })
})
