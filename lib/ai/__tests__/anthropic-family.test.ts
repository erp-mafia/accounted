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
    expect(result.ok && result.truncated).toBeFalsy()
  })

  it('flags a max_tokens stop as truncated so the caller can retry with a higher cap', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"lineItems":[{"description":"cut of' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })
    const svc = createAnthropicFamilyService(readAiConfig())
    const result = await svc.extractFromDocument({
      document: { kind: 'text', text: 'x' },
      system: SYSTEM,
      instruction: INSTRUCTION,
      maxTokens: 100,
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.truncated).toBe(true)
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

  it('generateText sends earlier turns as real message turns before the prompt', async () => {
    const svc = createAnthropicFamilyService(readAiConfig())
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
    expect(mockCreate.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'Vad är min största utgift?' },
      { role: 'assistant', content: '12 345 kr på 5010.' },
      { role: 'user', content: 'Och förra månaden?' },
    ])
  })

  it('generateText with an empty history is byte-identical to the single-turn call', async () => {
    const svc = createAnthropicFamilyService(readAiConfig())
    await svc.generateText({ tier: 'assistant', system: 'S', prompt: 'Hej', maxTokens: 50, history: [] })
    expect(mockCreate.mock.calls[0][0]).toEqual({
      model: 'eu.anthropic.claude-sonnet-5',
      max_tokens: 50,
      system: 'S',
      messages: [{ role: 'user', content: 'Hej' }],
    })
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

describe('generateText read-only tool loop', () => {
  it('calls a tool, feeds the JSON result back, and returns the final answer with summed usage', async () => {
    const execute = vi.fn().mockResolvedValue({ largest: '5010', amount: 12345 })
    const svc = createAnthropicFamilyService(readAiConfig())

    // Turn 1: the model asks for a report.
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Kollar.' },
        { type: 'tool_use', id: 'tu_1', name: 'gnubok_get_income_statement', input: { period: '2026-07' } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    // Turn 2: the model answers with the figure.
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Din största utgift är 12 345 kr (konto 5010).' }],
      usage: { input_tokens: 20, output_tokens: 8 },
    })

    const result = await svc.generateText({
      tier: 'assistant',
      system: 'S',
      prompt: 'Vad är min största utgift?',
      maxTokens: 500,
      tools: [
        { name: 'gnubok_get_income_statement', description: 'd', jsonSchema: { type: 'object' }, execute },
      ],
      maxSteps: 4,
    })

    expect(execute).toHaveBeenCalledWith({ period: '2026-07' })
    expect(result.text).toBe('Din största utgift är 12 345 kr (konto 5010).')
    expect(mockCreate).toHaveBeenCalledTimes(2)

    // First turn carries the tools; second turn carries the tool_result.
    expect(mockCreate.mock.calls[0][0].tools[0].name).toBe('gnubok_get_income_statement')
    const secondMessages = mockCreate.mock.calls[1][0].messages
    expect(secondMessages).toHaveLength(3) // user, assistant(tool_use), user(tool_result)
    const toolResult = secondMessages[2].content[0]
    expect(toolResult.type).toBe('tool_result')
    expect(toolResult.tool_use_id).toBe('tu_1')
    expect(JSON.parse(toolResult.content)).toEqual({ largest: '5010', amount: 12345 })

    // Usage summed across both turns.
    expect(result.usage.inputTokens).toBe(30)
    expect(result.usage.outputTokens).toBe(13)
  })

  it('keeps the earlier turns in front of the tool loop', async () => {
    const svc = createAnthropicFamilyService(readAiConfig())
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Svar.' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await svc.generateText({
      tier: 'assistant',
      prompt: 'Och förra månaden?',
      maxTokens: 50,
      history: [
        { role: 'user', text: 'Vad är min största utgift?' },
        { role: 'assistant', text: '12 345 kr på 5010.' },
      ],
      tools: [{ name: 't', description: 'd', jsonSchema: { type: 'object' }, execute: vi.fn() }],
    })
    const messages = mockCreate.mock.calls[0][0].messages
    expect(messages).toHaveLength(3)
    expect(messages[0]).toEqual({ role: 'user', content: 'Vad är min största utgift?' })
    expect(messages[2]).toEqual({ role: 'user', content: 'Och förra månaden?' })
  })

  it('surfaces a tool failure as an is_error result rather than throwing', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('report timeout'))
    const svc = createAnthropicFamilyService(readAiConfig())
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu', name: 'gnubok_get_vat_report', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Kunde inte hämta momsrapporten just nu.' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const result = await svc.generateText({
      tier: 'assistant',
      prompt: 'Momsen?',
      maxTokens: 100,
      tools: [{ name: 'gnubok_get_vat_report', description: 'd', jsonSchema: {}, execute }],
    })
    const toolResult = mockCreate.mock.calls[1][0].messages[2].content[0]
    expect(toolResult.is_error).toBe(true)
    expect(JSON.parse(toolResult.content).error).toContain('report timeout')
    expect(result.text).toBe('Kunde inte hämta momsrapporten just nu.')
  })

  it('forces a final no-more-tools answer when the step budget is exhausted', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true })
    const svc = createAnthropicFamilyService(readAiConfig())
    // Every turn keeps asking for the tool → never terminates on its own.
    mockCreate.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu', name: 't', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    // The forced final turn (index 2) returns real text.
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu', name: 't', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu', name: 't', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Sammanfattning utan fler verktygsanrop.' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const result = await svc.generateText({
      tier: 'assistant',
      prompt: 'x',
      maxTokens: 100,
      tools: [{ name: 't', description: 'd', jsonSchema: {}, execute }],
      maxSteps: 2,
    })
    // 2 loop turns + 1 forced final = 3 calls. Deliberate request-shape change
    // (2026-08-24): the final call KEEPS the tools declared, because the
    // transcript it replays holds tool_use/tool_result blocks the API must be
    // able to resolve (omitting tools made every step-exhausted answer a 400),
    // and forbids further calls via tool_choice none.
    expect(mockCreate).toHaveBeenCalledTimes(3)
    expect(mockCreate.mock.calls[2][0].tools).toHaveLength(1)
    expect(mockCreate.mock.calls[2][0].tools[0].name).toBe('t')
    expect(mockCreate.mock.calls[2][0].tool_choice).toEqual({ type: 'none' })
    expect(result.text).toBe('Sammanfattning utan fler verktygsanrop.')
  })

  it('bounds an oversized tool result before feeding it back to the model', async () => {
    const big = 'x'.repeat(120_000)
    const execute = vi.fn().mockResolvedValue({ text: big })
    const svc = createAnthropicFamilyService(readAiConfig())
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu', name: 'gnubok_get_document_content', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Sammanfattat.' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await svc.generateText({
      tier: 'assistant',
      prompt: 'x',
      maxTokens: 100,
      tools: [{ name: 'gnubok_get_document_content', description: 'd', jsonSchema: {}, execute }],
    })
    const toolResult = mockCreate.mock.calls[1][0].messages[2].content[0]
    // 40k cap plus the short truncation notice; nowhere near the raw 120k.
    expect(toolResult.content.length).toBeLessThan(40_400)
    expect(toolResult.content).toContain('[avkortat: resultatet var')
  })

  it('returns empty text (for the caller to guard on) when the loop ends on max_tokens with no text block', async () => {
    const svc = createAnthropicFamilyService(readAiConfig())
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'max_tokens',
      content: [],
      usage: { input_tokens: 5, output_tokens: 100 },
    })
    const result = await svc.generateText({
      tier: 'assistant',
      prompt: 'x',
      maxTokens: 100,
      tools: [{ name: 't', description: 'd', jsonSchema: {}, execute: vi.fn() }],
    })
    // The service stays a transport: it does not invent text. Callers
    // (ask-service) treat '' as a typed failure instead of a silent answer.
    expect(result.text).toBe('')
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})
