import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentIntent } from '@/lib/agent/intents/types'

// Verifies the extended-thinking ("tänka längre") wiring: an opted-in intent
// gets a thinking config + bumped max_tokens on the model call, an intent
// without it gets neither; and thinking blocks are stripped before persistence.
//
// The Anthropic client mock mirrors run-turn-memory.test.ts: stream().on() is a
// chainable no-op and finalMessage() delegates to a queued mock that records
// the args the stream was called with.
const messagesCreate = vi.fn()
vi.mock('@/lib/agent/composer/client', () => ({
  getAnthropic: () => ({
    messages: {
      stream: (args: unknown) => {
        const stream = { on: () => stream, finalMessage: () => messagesCreate(args) }
        return stream
      },
    },
  }),
  SONNET_MODEL: 'claude-sonnet-4-6',
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

import { runChatTurn, stripThinking } from '../run-turn'

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

async function runWith(intent: AgentIntent) {
  messagesCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
  })
  getManyMock.mockResolvedValue([])
  await runChatTurn({
    supabase: fakeSupabase(),
    userId: 'u',
    companyId: 'c',
    companyName: 'X',
    firstName: 'A',
    intent,
    conversationId: 'conv',
    userMessage: 'hej',
    persist: false,
    emit: () => true,
  })
  // The args object the stream was invoked with.
  return messagesCreate.mock.calls[0][0] as { thinking?: unknown; max_tokens?: number }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runChatTurn — extended thinking wiring', () => {
  it('passes a thinking config and bumps max_tokens when the intent opts in', async () => {
    const args = await runWith({ ...baseIntent(), thinking: { budgetTokens: 2000 } })
    expect(args.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 })
    // budget must be strictly below max_tokens — we add the normal output budget.
    expect(args.max_tokens).toBe(2000 + 4096)
  })

  it('omits thinking and keeps the default budget when the intent does not opt in', async () => {
    const args = await runWith(baseIntent())
    expect(args.thinking).toBeUndefined()
    expect(args.max_tokens).toBe(4096)
  })
})

describe('stripThinking', () => {
  it('drops thinking and redacted_thinking blocks but keeps text and tool_use', () => {
    const blocks = [
      { type: 'thinking', thinking: 'raw chain of thought', signature: 'sig' },
      { type: 'redacted_thinking', data: 'xxx' },
      { type: 'text', text: 'svar' },
      { type: 'tool_use', id: 't1', name: 'gnubok_load_skill', input: {} },
    ]
    expect(stripThinking(blocks)).toEqual([
      { type: 'text', text: 'svar' },
      { type: 'tool_use', id: 't1', name: 'gnubok_load_skill', input: {} },
    ])
  })

  it('is a no-op when there are no thinking blocks', () => {
    const blocks = [{ type: 'text', text: 'x' }]
    expect(stripThinking(blocks)).toEqual(blocks)
  })
})
