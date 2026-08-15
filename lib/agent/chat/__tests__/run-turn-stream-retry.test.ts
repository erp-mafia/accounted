import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentIntent } from '@/lib/agent/intents/types'
import type { StreamEvent } from '../run-turn'

// Anthropic client mock: `finalMessage()` delegates to a queued mock so tests
// can make the first stream attempt fail and the retry succeed. Mirrors the
// adapter in run-turn-memory.test.ts.
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

const getMock = vi.fn()
const getManyMock = vi.fn()
vi.mock('@/lib/agent/tools/registry', () => ({
  agentToolRegistry: {
    get: (...args: unknown[]) => getMock(...args),
    getMany: (...args: unknown[]) => getManyMock(...args),
  },
}))

import { runChatTurn, isTransientStreamError } from '../run-turn'

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

function makeIntent(): AgentIntent {
  return {
    id: 'general.help',
    buttonLabel: 'x',
    sheetTitle: 'x',
    atoms: { mode: 'progressive', horizontal: [], includeCompanyVertical: false, includeCompanyModifiers: false },
    tools: [],
    model: 'claude-sonnet-5',
    capture: async () => ({}),
    promptTemplate: () => '',
  }
}

async function runTurn(events: StreamEvent[]): Promise<void> {
  await runChatTurn({
    supabase: fakeSupabase(),
    userId: 'user-1',
    companyId: 'company-1',
    companyName: 'Acme AB',
    firstName: 'Anna',
    intent: makeIntent(),
    conversationId: 'conv-1',
    userMessage: 'hej',
    persist: false,
    emit: (e) => {
      events.push(e)
      return true
    },
  })
}

function transientError(message: string, status?: number): Error & { status?: number } {
  const err = new Error(message) as Error & { status?: number }
  if (status !== undefined) err.status = status
  return err
}

beforeEach(() => {
  vi.clearAllMocks()
  getManyMock.mockResolvedValue([])
})

describe('isTransientStreamError', () => {
  it('classifies the known stream-corruption signatures as transient', () => {
    expect(isTransientStreamError(new Error('Unexpected event order, got message_stop'))).toBe(true)
    expect(isTransientStreamError(new Error('request ended without sending any chunks'))).toBe(true)
  })

  it('classifies throttling, 5xx, and transport cuts as transient', () => {
    expect(isTransientStreamError(transientError('Too many requests', 429))).toBe(true)
    expect(isTransientStreamError(transientError('Internal failure', 503))).toBe(true)
    expect(isTransientStreamError(new Error('read ECONNRESET'))).toBe(true)
    expect(isTransientStreamError(new Error('Request timed out'))).toBe(true)
  })

  it('classifies auth and validation failures as permanent', () => {
    expect(isTransientStreamError(transientError('Forbidden', 403))).toBe(false)
    expect(isTransientStreamError(transientError('Invalid model', 400))).toBe(false)
    // A 4xx stays permanent even when the message contains a transient token.
    expect(isTransientStreamError(transientError('socket auth rejected', 403))).toBe(false)
    expect(isTransientStreamError(new Error('validation failed: max_tokens'))).toBe(false)
  })
})

describe('runChatTurn: transient stream retry', () => {
  it('retries once on a transient failure and completes the turn', async () => {
    messagesCreate
      .mockRejectedValueOnce(new Error('Unexpected event order, got message_stop'))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Hej igen.' }],
        stop_reason: 'end_turn',
      })

    const events: StreamEvent[] = []
    await runTurn(events)

    const restarts = events.filter((e) => e.kind === 'stream_restart')
    expect(restarts).toHaveLength(1)
    expect(restarts[0]).toMatchObject({ kind: 'stream_restart', assistant_text: '' })
    expect(events.find((e) => e.kind === 'error')).toBeUndefined()
    expect(events.find((e) => e.kind === 'turn_complete')).toBeDefined()
    expect(messagesCreate).toHaveBeenCalledTimes(2)
  }, 15_000)

  it('does not retry a non-transient failure (403): error emitted, turn thrown', async () => {
    messagesCreate.mockRejectedValueOnce(transientError('Forbidden', 403))

    const events: StreamEvent[] = []
    await expect(runTurn(events)).rejects.toThrow('Forbidden')

    expect(events.filter((e) => e.kind === 'stream_restart')).toHaveLength(0)
    expect(events.find((e) => e.kind === 'error')).toBeDefined()
    expect(messagesCreate).toHaveBeenCalledTimes(1)
  })

  it('retries at most once per turn: a second transient failure surfaces as an error', async () => {
    messagesCreate
      .mockRejectedValueOnce(transientError('Service unavailable', 503))
      .mockRejectedValueOnce(transientError('Service unavailable', 503))

    const events: StreamEvent[] = []
    await expect(runTurn(events)).rejects.toThrow('Service unavailable')

    expect(events.filter((e) => e.kind === 'stream_restart')).toHaveLength(1)
    expect(events.find((e) => e.kind === 'error')).toBeDefined()
    expect(messagesCreate).toHaveBeenCalledTimes(2)
  }, 15_000)
})
