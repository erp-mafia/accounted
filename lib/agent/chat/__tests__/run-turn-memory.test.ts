import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentIntent } from '@/lib/agent/intents/types'
import type { AgentTool } from '@/lib/agent/tools/types'
import type { StreamEvent } from '../run-turn'

// Anthropic client mock — returns a single round trip: one tool_use turn,
// then a final text-only turn (so the loop terminates). run-turn now uses
// `messages.stream()` for token-level streaming, so we expose a stream
// adapter that delegates `finalMessage()` to the same queued mock.
const messagesCreate = vi.fn()
vi.mock('@/lib/agent/composer/client', () => ({
  getAnthropic: () => ({
    messages: {
      create: messagesCreate,
      stream: (args: unknown) => {
        const stream = {
          on: () => stream,
          finalMessage: () => messagesCreate(args),
        }
        return stream
      },
    },
  }),
  SONNET_MODEL: 'claude-sonnet-4-6',
}))

// system-prompt builder — return a minimal valid shape.
vi.mock('../system-prompt', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue({
    blocks: [],
    promptHash: 'sha256:test',
    atomsLoaded: [],
  }),
}))

// Tool registry — return a controllable tool list. Tests overwrite per-case.
const getMock = vi.fn()
const getManyMock = vi.fn()
vi.mock('@/lib/agent/tools/registry', () => ({
  agentToolRegistry: {
    get: (...args: unknown[]) => getMock(...args),
    getMany: (...args: unknown[]) => getManyMock(...args),
  },
}))

import { runChatTurn } from '../run-turn'

function fakeSupabase() {
  // Every chain method is a no-op that resolves to empty.
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

function makeIntent(): AgentIntent {
  return {
    id: 'general.help',
    buttonLabel: 'x',
    sheetTitle: 'x',
    atoms: { mode: 'progressive', horizontal: [], includeCompanyVertical: false, includeCompanyModifiers: false },
    tools: ['gnubok_remember_fact'],
    model: 'claude-sonnet-4-6',
    capture: async () => ({}),
    promptTemplate: () => '',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runChatTurn — memory_captured emission', () => {
  it('emits memory_captured after a successful remember_fact tool call', async () => {
    // First response: model issues a remember_fact tool_use.
    // Second response: model finishes with text (no more tools → loop ends).
    messagesCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'gnubok_remember_fact',
            input: { content: 'Hyresfaktura kommer 25:e varje månad', kind: 'pattern' },
          },
        ],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Klart.' }],
        stop_reason: 'end_turn',
      })

    const rememberTool: AgentTool = {
      name: 'gnubok_remember_fact',
      description: '',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      execute: vi.fn().mockResolvedValue({
        id: 'mem-abc',
        kind: 'pattern',
        content: 'Hyresfaktura kommer 25:e varje månad',
        created_at: '2026-05-18T10:00:00Z',
      }),
    }
    getMock.mockReturnValue(rememberTool)
    getManyMock.mockResolvedValue([rememberTool])

    const events: StreamEvent[] = []
    await runChatTurn({
      supabase: fakeSupabase(),
      userId: 'user-1',
      companyId: 'company-1',
      companyName: 'Acme AB',
      firstName: 'Anna',
      intent: makeIntent(),
      conversationId: 'conv-1',
      userMessage: 'kom ihåg det här',
      persist: false,
      emit: (e) => {
        events.push(e)
        return true
      },
    })

    const memEvent = events.find((e) => e.kind === 'memory_captured')
    expect(memEvent).toBeDefined()
    expect(memEvent).toMatchObject({
      kind: 'memory_captured',
      tool_use_id: 'tu_1',
      action: 'remembered',
      memory_id: 'mem-abc',
      memory_kind: 'pattern',
      content: 'Hyresfaktura kommer 25:e varje månad',
    })
  })

  it('emits memory_captured with action=forgotten for forget_fact', async () => {
    messagesCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tu_2',
            name: 'gnubok_forget_fact',
            input: { id: 'mem-old', is_active: false },
          },
        ],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Glömt.' }],
        stop_reason: 'end_turn',
      })

    const forgetTool: AgentTool = {
      name: 'gnubok_forget_fact',
      description: '',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      execute: vi.fn().mockResolvedValue({ id: 'mem-old', is_active: false }),
    }
    getMock.mockReturnValue(forgetTool)
    getManyMock.mockResolvedValue([forgetTool])

    const events: StreamEvent[] = []
    await runChatTurn({
      supabase: fakeSupabase(),
      userId: 'user-1',
      companyId: 'company-1',
      companyName: 'Acme AB',
      firstName: 'Anna',
      intent: { ...makeIntent(), tools: ['gnubok_forget_fact'] },
      conversationId: 'conv-1',
      userMessage: 'glöm det där',
      persist: false,
      emit: (e) => {
        events.push(e)
        return true
      },
    })

    const memEvent = events.find((e) => e.kind === 'memory_captured')
    expect(memEvent).toMatchObject({
      kind: 'memory_captured',
      action: 'forgotten',
      memory_id: 'mem-old',
    })
  })

  it('bumps last_accessed_at for the memories included in the turn', async () => {
    // Single-shot text response — no tool use, simplest path.
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'OK.' }],
      stop_reason: 'end_turn',
    })
    getManyMock.mockResolvedValue([])

    // Intercept supabase to capture the .in() call on agent_memory.
    const inSpy = vi.fn().mockResolvedValue({ data: null, error: null })
    const updateChain = { eq: vi.fn().mockResolvedValue({ data: null, error: null }), in: inSpy }
    const memoryRows = [
      { id: 'mem-A', content: 'X', kind: 'fact', relevance_score: 1, last_accessed_at: null, is_pinned: false },
      { id: 'mem-B', content: 'Y', kind: 'preference', relevance_score: 0.8, last_accessed_at: null, is_pinned: false },
    ]
    const memoryQueryChain = {
      select: () => memoryQueryChain,
      eq: () => memoryQueryChain,
      order: () => memoryQueryChain,
      limit: () => Promise.resolve({ data: memoryRows, error: null }),
    }
    const messagesQueryChain = {
      select: () => messagesQueryChain,
      eq: () => messagesQueryChain,
      order: () => Promise.resolve({ data: [], error: null }),
    }
    const profileChain = {
      select: () => profileChain,
      eq: () => profileChain,
      maybeSingle: () => Promise.resolve({ data: null }),
    }

    let bumpCalled: string[] | null = null
    const supabase = {
      auth: { getUser: vi.fn() },
      from: vi.fn((table: string) => {
        if (table === 'agent_profiles') return profileChain
        if (table === 'agent_memory') {
          return {
            ...memoryQueryChain,
            update: () => ({
              in: (_col: string, ids: string[]) => {
                bumpCalled = ids
                return Promise.resolve({ data: null, error: null })
              },
            }),
          }
        }
        if (table === 'agent_messages') {
          return {
            ...messagesQueryChain,
            insert: () => Promise.resolve({ data: null, error: null }),
          }
        }
        if (table === 'agent_conversations') {
          return {
            update: () => updateChain,
            insert: () => Promise.resolve({ data: null, error: null }),
          }
        }
        return memoryQueryChain
      }),
    }

    await runChatTurn({
      supabase: supabase as unknown as Parameters<typeof runChatTurn>[0]['supabase'],
      userId: 'user-1',
      companyId: 'company-1',
      companyName: 'Acme AB',
      firstName: 'Anna',
      intent: makeIntent(),
      conversationId: 'conv-1',
      userMessage: 'hej',
      persist: true,
      emit: () => true,
    })

    expect(bumpCalled).not.toBeNull()
    expect(bumpCalled).toEqual(expect.arrayContaining(['mem-A', 'mem-B']))
  })

  it('does NOT emit memory_captured for unrelated tools', async () => {
    messagesCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tu_3',
            name: 'gnubok_list_uncategorized_transactions',
            input: {},
          },
        ],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
      })

    const listTool: AgentTool = {
      name: 'gnubok_list_uncategorized_transactions',
      description: '',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      execute: vi.fn().mockResolvedValue({ data: [] }),
    }
    getMock.mockReturnValue(listTool)
    getManyMock.mockResolvedValue([listTool])

    const events: StreamEvent[] = []
    await runChatTurn({
      supabase: fakeSupabase(),
      userId: 'user-1',
      companyId: 'company-1',
      companyName: 'Acme AB',
      firstName: 'Anna',
      intent: { ...makeIntent(), tools: ['gnubok_list_uncategorized_transactions'] },
      conversationId: 'conv-1',
      userMessage: 'hi',
      persist: false,
      emit: (e) => {
        events.push(e)
        return true
      },
    })

    expect(events.find((e) => e.kind === 'memory_captured')).toBeUndefined()
  })
})
