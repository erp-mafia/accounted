import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The opt-in parts of generateText (types.ts: effort, cachePrompt,
// onProgress), against a fake Bedrock client. The other suite in this folder
// pins that a caller who sets none of them sends the request it always sent;
// this one pins what each of them adds, and nothing else.
const mockCreate = vi.fn()
const mockStream = vi.fn()
vi.mock('@anthropic-ai/bedrock-sdk', () => {
  class FakeBedrock {
    messages = { create: mockCreate, stream: mockStream }
  }
  return { default: FakeBedrock }
})

import { readAiConfig } from '../config'
import { createAnthropicFamilyService } from '../services/anthropic-family'
import type { AiProgressEvent, AiToolDef } from '../types'

const ENV = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_ASSISTANT_MODEL', 'BEDROCK_SONNET_MODEL_ID'] as const
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
})
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const textTurn = (text: string) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: USAGE })
const toolTurn = (preamble: string, name: string) => ({
  content: [
    { type: 'text', text: preamble },
    { type: 'tool_use', id: 'toolu_1', name, input: { path: '/invoices' } },
  ],
  stop_reason: 'tool_use',
  usage: USAGE,
})

/** A fake MessageStream: hands its text to the listener in pieces, then resolves the assembled message. */
function streamOf(message: { content: Array<{ type: string; text?: string }> }) {
  let onText: ((delta: string) => void) | undefined
  return {
    on(event: string, handler: (delta: string) => void) {
      if (event === 'text') onText = handler
      return this
    },
    async finalMessage() {
      for (const block of message.content) {
        if (block.type !== 'text' || !block.text) continue
        const half = Math.ceil(block.text.length / 2)
        onText?.(block.text.slice(0, half))
        onText?.(block.text.slice(half))
      }
      return message
    },
  }
}

const readPage: AiToolDef = {
  name: 'read_page',
  description: 'Read a page',
  jsonSchema: { type: 'object', properties: { path: { type: 'string' } } },
  execute: async () => ({ texts: '[page] Ny faktura' }),
}

const service = () => createAnthropicFamilyService(readAiConfig())

describe('generateText without the opt-in parts', () => {
  it('sends the plain request through messages.create, never the stream', async () => {
    mockCreate.mockResolvedValue(textTurn('Svar'))
    await service().generateText({ tier: 'assistant', system: 'S', prompt: 'P', maxTokens: 100 })
    expect(mockStream).not.toHaveBeenCalled()
    expect(mockCreate.mock.calls[0][0]).toEqual({
      model: 'eu.anthropic.claude-sonnet-5',
      max_tokens: 100,
      system: 'S',
      messages: [{ role: 'user', content: 'P' }],
    })
  })
})

describe('effort', () => {
  it('adds output_config.effort to every turn of a tool loop', async () => {
    mockCreate.mockResolvedValueOnce(toolTurn('', 'read_page')).mockResolvedValueOnce(textTurn('Svar'))
    await service().generateText({ tier: 'assistant', prompt: 'P', maxTokens: 100, tools: [readPage], effort: 'medium' })
    expect(mockCreate).toHaveBeenCalledTimes(2)
    for (const call of mockCreate.mock.calls) expect(call[0].output_config).toEqual({ effort: 'medium' })
  })

  it('adds it to a call without tools too', async () => {
    mockCreate.mockResolvedValue(textTurn('Svar'))
    await service().generateText({ tier: 'assistant', prompt: 'P', maxTokens: 100, effort: 'low' })
    expect(mockCreate.mock.calls[0][0].output_config).toEqual({ effort: 'low' })
  })
})

describe('cachePrompt', () => {
  it('marks the system prompt as one cached block and the last block of each turn, one mark at a time', async () => {
    mockCreate.mockResolvedValueOnce(toolTurn('', 'read_page')).mockResolvedValueOnce(textTurn('Svar'))
    await service().generateText({
      tier: 'assistant',
      system: 'S',
      prompt: 'P',
      maxTokens: 100,
      tools: [readPage],
      cachePrompt: true,
    })

    const first = mockCreate.mock.calls[0][0]
    expect(first.system).toEqual([{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }])
    expect(first.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'P', cache_control: { type: 'ephemeral' } }] },
    ])

    // The second turn: the question is no longer marked, the tool result is.
    const second = mockCreate.mock.calls[1][0]
    expect(second.messages[0]).toEqual({ role: 'user', content: 'P' })
    const results = second.messages[2].content
    expect(results[results.length - 1].cache_control).toEqual({ type: 'ephemeral' })
    const marks = JSON.stringify(second.messages).split('"cache_control"').length - 1
    expect(marks).toBe(1)
  })

  it('marks the final answer request when the step budget is spent', async () => {
    mockCreate
      .mockResolvedValueOnce(toolTurn('', 'read_page'))
      .mockResolvedValueOnce(textTurn('Svar efter verktygen'))
    const result = await service().generateText({
      tier: 'assistant',
      system: 'S',
      prompt: 'P',
      maxTokens: 100,
      tools: [readPage],
      maxSteps: 1,
      cachePrompt: true,
    })
    expect(result.forcedFinal).toBe('step_limit')
    const final = mockCreate.mock.calls[1][0]
    expect(final.tool_choice).toEqual({ type: 'none' })
    const lastBlocks = final.messages[final.messages.length - 1].content
    expect(lastBlocks[lastBlocks.length - 1]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } })
  })
})

describe('onProgress', () => {
  it('streams the answer text as it arrives and returns the same answer', async () => {
    mockStream.mockReturnValue(streamOf(textTurn('Under Fakturor.')))
    const events: AiProgressEvent[] = []
    const result = await service().generateText({
      tier: 'assistant',
      prompt: 'P',
      maxTokens: 100,
      onProgress: (event) => events.push(event),
    })
    expect(mockCreate).not.toHaveBeenCalled()
    expect(result.text).toBe('Under Fakturor.')
    expect(events.every((e) => e.type === 'text')).toBe(true)
    expect(events.map((e) => (e.type === 'text' ? e.delta : '')).join('')).toBe('Under Fakturor.')
  })

  it('says when a turn ended in tool calls, so a remark before them is dropped, then streams the answer', async () => {
    mockStream
      .mockReturnValueOnce(streamOf(toolTurn('Jag kollar sidan.', 'read_page')))
      .mockReturnValueOnce(streamOf(textTurn('Knappen heter Ny faktura.')))
    const events: AiProgressEvent[] = []
    const result = await service().generateText({
      tier: 'assistant',
      prompt: 'P',
      maxTokens: 100,
      tools: [readPage],
      onProgress: (event) => events.push(event),
    })
    expect(result.text).toBe('Knappen heter Ny faktura.')

    const toolsAt = events.findIndex((e) => e.type === 'tools')
    expect(events[toolsAt]).toEqual({ type: 'tools', names: ['read_page'] })
    const before = events.slice(0, toolsAt).map((e) => (e.type === 'text' ? e.delta : '')).join('')
    const after = events.slice(toolsAt + 1).map((e) => (e.type === 'text' ? e.delta : '')).join('')
    expect(before).toBe('Jag kollar sidan.')
    expect(after).toBe('Knappen heter Ny faktura.')
  })

  it('sends the streamed request with the same body a plain one has', async () => {
    mockStream.mockReturnValue(streamOf(textTurn('Svar')))
    await service().generateText({ tier: 'assistant', system: 'S', prompt: 'P', maxTokens: 100, onProgress: () => undefined })
    expect(mockStream.mock.calls[0][0]).toEqual({
      model: 'eu.anthropic.claude-sonnet-5',
      max_tokens: 100,
      system: 'S',
      messages: [{ role: 'user', content: 'P' }],
    })
  })
})
