import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/agent/composer/client', () => ({
  getAnthropic: vi.fn(),
  SONNET_MODEL: 'eu.anthropic.claude-sonnet-5',
}))

import { getAnthropic } from '@/lib/agent/composer/client'
import { interpretChatAnswer } from '@/extensions/general/whatsapp-inbox/lib/interpret-answer'

const createMock = vi.fn()
vi.mocked(getAnthropic).mockReturnValue({
  messages: { create: createMock },
} as never)

function toolUseResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', id: 'tu-1', name: 'record_answer', input }],
  }
}

describe('interpretChatAnswer', () => {
  beforeEach(() => {
    createMock.mockReset()
  })

  it('parses a full representation answer via the forced tool call', async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        is_denial: false,
        participants: [
          { name: 'Anna Berg', company: 'Volvo' },
          { name: 'Jakob W', company: null },
        ],
        purpose: 'uppföljning av avtal',
        event_date: null,
        note: null,
      }),
    )

    const result = await interpretChatAnswer({
      text: 'Lunch med Anna Berg (Volvo) och mig, uppföljning av avtal',
      questionType: 'representation',
    })

    expect(result).toEqual({
      ok: true,
      data: {
        is_denial: false,
        participants: [
          { name: 'Anna Berg', company: 'Volvo' },
          { name: 'Jakob W', company: null },
        ],
        purpose: 'uppföljning av avtal',
        event_date: null,
        note: null,
      },
    })

    // Call contract: Sonnet, capped output, forced tool, NO thinking.
    const call = createMock.mock.calls[0][0]
    expect(call.model).toBe('eu.anthropic.claude-sonnet-5')
    expect(call.max_tokens).toBe(600)
    expect(call.thinking).toBeUndefined()
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'record_answer' })
    // The reply is framed as untrusted data, fenced in <reply> tags.
    expect(call.system).toContain('UNTRUSTED')
    expect(call.messages[0].content).toContain('<reply>')
  })

  it('reads a denial', async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        is_denial: true,
        participants: null,
        purpose: null,
        event_date: null,
        note: null,
      }),
    )
    const result = await interpretChatAnswer({ text: 'det var privat', questionType: 'representation' })
    expect(result.ok && result.data.is_denial).toBe(true)
  })

  it('degrades on schema-invalid output (never throws, never retries)', async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        is_denial: 'yes', // wrong type
        participants: 'Anna',
        purpose: 42,
        event_date: 'igår',
        note: null,
      }),
    )
    const result = await interpretChatAnswer({ text: 'hej', questionType: 'context' })
    expect(result).toEqual({ ok: false })
    expect(createMock).toHaveBeenCalledTimes(1) // exactly one attempt
  })

  it('degrades when the output exceeds the hard caps (16 participants)', async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        is_denial: false,
        participants: Array.from({ length: 16 }, (_, i) => ({ name: `P${i}`, company: null })),
        purpose: null,
        event_date: null,
        note: null,
      }),
    )
    const result = await interpretChatAnswer({ text: 'hela kontoret', questionType: 'representation' })
    expect(result).toEqual({ ok: false })
  })

  it('degrades on API failure', async () => {
    createMock.mockRejectedValue(new Error('bedrock down'))
    const result = await interpretChatAnswer({ text: 'taxi', questionType: 'context' })
    expect(result).toEqual({ ok: false })
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('degrades when no tool_use block comes back', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'I refuse to use tools' }] })
    const result = await interpretChatAnswer({ text: 'x', questionType: 'context' })
    expect(result).toEqual({ ok: false })
  })
})
