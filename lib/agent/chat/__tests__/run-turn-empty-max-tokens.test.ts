import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentIntent } from '@/lib/agent/intents/types'
import type { StreamEvent } from '../run-turn'

// Verifies the silent-stop guard: a turn whose last model call ended on
// stop_reason max_tokens WITHOUT any visible text must emit an error event,
// never a bare turn_complete (which the chat renders as an invisible empty
// bubble: "Tänker" collapses and nothing appears). A partial answer that hit
// the ceiling still completes: half an answer on screen is a real answer.
//
// The client mock extends run-turn-thinking.test.ts's: stream().on() records
// handlers and finalMessage() replays the queued response's text blocks
// through the 'text' handler so assistantText accumulates like production.
const messagesCreate = vi.fn()
vi.mock('@/lib/agent/composer/client', () => ({
  getAnthropic: () => ({
    messages: {
      stream: (args: unknown) => {
        const handlers: Record<string, (arg: unknown) => void> = {}
        const stream = {
          on: (name: string, fn: (arg: unknown) => void) => {
            handlers[name] = fn
            return stream
          },
          finalMessage: async () => {
            const resp = (await messagesCreate(args)) as {
              content?: { type: string; text?: string }[]
            }
            for (const block of resp.content ?? []) {
              if (block.type === 'text' && typeof block.text === 'string') {
                handlers.text?.(block.text)
              }
            }
            return resp
          },
        }
        return stream
      },
    },
  }),
  SONNET_MODEL: 'claude-sonnet-5',
  MAX_TOKENS_NO_THINKING: 5400,
  MAX_TOKENS_STANDARD: 16000,
  MAX_TOKENS_DEEP: 24000,
}))

vi.mock('../system-prompt', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue({
    blocks: [],
    promptHash: 'sha256:test',
    atomsLoaded: [],
  }),
}))

const getManyMock = vi.fn()
vi.mock('@/lib/agent/tools/registry', () => ({
  agentToolRegistry: {
    get: () => undefined,
    getMany: (...args: unknown[]) => getManyMock(...args),
  },
}))

import { runChatTurn } from '../run-turn'

function fakeSupabase() {
  const passthrough: Record<string, unknown> = {}
  const proxy: unknown = new Proxy(passthrough, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      }
      return () => proxy
    },
  })
  return proxy as unknown as Parameters<typeof runChatTurn>[0]['supabase']
}

function baseIntent(): AgentIntent {
  return {
    id: 'general.help',
    buttonLabel: 'x',
    sheetTitle: 'x',
    atoms: { mode: 'progressive', horizontal: [], includeCompanyVertical: false, includeCompanyModifiers: false },
    tools: [],
    model: 'claude-sonnet-4-6',
    capture: async () => ({}),
    promptTemplate: () => '',
  }
}

async function runAndCollect(): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  getManyMock.mockResolvedValue([])
  await runChatTurn({
    supabase: fakeSupabase(),
    userId: 'u',
    companyId: 'c',
    companyName: 'X',
    firstName: 'A',
    intent: baseIntent(),
    conversationId: 'conv',
    userMessage: 'hej',
    persist: false,
    emit: (event) => {
      events.push(event)
      return true
    },
  })
  return events
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runChatTurn: max_tokens with no visible text', () => {
  it('emits an error event instead of a bare turn_complete', async () => {
    messagesCreate.mockResolvedValueOnce({
      // Thinking spent the whole budget: no text block at all.
      content: [{ type: 'thinking', thinking: 'long reasoning', signature: 's' }],
      stop_reason: 'max_tokens',
    })
    const events = await runAndCollect()
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(false)
    const error = events.find((e) => e.kind === 'error')
    expect(error).toBeDefined()
    expect((error as { message: string }).message).toBe(
      'Assistenten fick slut på utrymme innan svaret blev klart. Försök igen.',
    )
  })

  it('still completes when max_tokens cut a PARTIAL answer', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Din moms för juli är' }],
      stop_reason: 'max_tokens',
    })
    const events = await runAndCollect()
    expect(events.some((e) => e.kind === 'error')).toBe(false)
    const complete = events.find((e) => e.kind === 'turn_complete')
    expect(complete).toBeDefined()
    expect((complete as { assistant_text: string }).assistant_text).toBe('Din moms för juli är')
  })

  it('completes normally on end_turn', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Klart svar.' }],
      stop_reason: 'end_turn',
    })
    const events = await runAndCollect()
    expect(events.some((e) => e.kind === 'error')).toBe(false)
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(true)
  })
})
