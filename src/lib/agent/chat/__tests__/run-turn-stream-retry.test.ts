import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentIntent } from '@/lib/agent/intents/types'
import type { StreamEvent } from '../run-turn'

// Anthropic client mock: `finalMessage()` delegates to a queued mock so tests
// can make the first stream attempt fail and the retry succeed. Mirrors the
// adapter in run-turn-memory.test.ts. The stream's listeners ride along as the
// second argument, so an implementation can stream text before it fails.
type StreamListeners = Record<string, (payload: unknown) => void>
const messagesCreate = vi.fn()
vi.mock('@/lib/agent/composer/client', () => ({
  getAnthropic: () => ({
    messages: {
      create: messagesCreate,
      stream: (args: unknown) => {
        const listeners: StreamListeners = {}
        const stream = {
          on: (event: string, listener: (payload: unknown) => void) => {
            listeners[event] = listener
            return stream
          },
          finalMessage: () => messagesCreate(args, listeners),
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

import { runChatTurn, isTransientStreamError, isProviderOverload, PRE_OUTPUT_RETRY_DELAYS_MS } from '../run-turn'

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

// The SSE `error` event Anthropic sends inside a stream that already answered
// 200: the SDK throws it with no status and the event's JSON as the message
// (what prod logged on 2026-10-26).
function overloadedStreamError(): Error {
  return new Error(
    '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_test"}',
  )
}

const OVERLOAD_MESSAGE = 'Assistenten är överbelastad just nu, försök igen om en minut.'
const ANSWER = { content: [{ type: 'text', text: 'Hej igen.' }], stop_reason: 'end_turn' }

// The backoff waits, recorded and skipped: the turn's own setTimeout calls are
// the only ones at or above the restart backoff.
let backoffs: number[] = []

beforeEach(() => {
  vi.clearAllMocks()
  getManyMock.mockResolvedValue([])
  backoffs = []
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if ((ms ?? 0) >= 500) backoffs.push(ms ?? 0)
    fn()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout)
})

afterEach(() => {
  vi.restoreAllMocks()
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

  it('classifies the provider\'s overloaded_error and api_error stream events as transient', () => {
    expect(isTransientStreamError(overloadedStreamError())).toBe(true)
    expect(
      isTransientStreamError(new Error('{"type":"error","error":{"type":"api_error","message":"Internal server error"}}')),
    ).toBe(true)
    expect(isTransientStreamError(transientError('Overloaded', 529))).toBe(true)
  })

  it('classifies auth and validation failures as permanent', () => {
    expect(isTransientStreamError(transientError('Forbidden', 403))).toBe(false)
    expect(isTransientStreamError(transientError('Invalid model', 400))).toBe(false)
    // A 4xx stays permanent even when the message contains a transient token.
    expect(isTransientStreamError(transientError('socket auth rejected', 403))).toBe(false)
    expect(isTransientStreamError(new Error('validation failed: max_tokens'))).toBe(false)
  })
})

describe('isProviderOverload', () => {
  it('names an overloaded_error, a 529 and Bedrock\'s 503 as overload', () => {
    expect(isProviderOverload(overloadedStreamError())).toBe(true)
    expect(isProviderOverload(transientError('Overloaded', 529))).toBe(true)
    expect(isProviderOverload(transientError('Bedrock is unable to process your request.', 503))).toBe(true)
  })

  it('keeps other failures apart', () => {
    expect(isProviderOverload(transientError('Internal failure', 500))).toBe(false)
    expect(isProviderOverload(transientError('Too many requests', 429))).toBe(false)
    expect(isProviderOverload(new Error('read ECONNRESET'))).toBe(false)
  })
})

describe('runChatTurn: transient stream retry', () => {
  it('retries a transient failure and completes the turn', async () => {
    messagesCreate
      .mockRejectedValueOnce(new Error('Unexpected event order, got message_stop'))
      .mockResolvedValueOnce(ANSWER)

    const events: StreamEvent[] = []
    await runTurn(events)

    const restarts = events.filter((e) => e.kind === 'stream_restart')
    expect(restarts).toHaveLength(1)
    expect(restarts[0]).toMatchObject({ kind: 'stream_restart', assistant_text: '' })
    expect(events.find((e) => e.kind === 'error')).toBeUndefined()
    expect(events.find((e) => e.kind === 'turn_complete')).toBeDefined()
    expect(messagesCreate).toHaveBeenCalledTimes(2)
  })

  it('rides out an overload before the first token with growing backoff', async () => {
    messagesCreate
      .mockRejectedValueOnce(overloadedStreamError())
      .mockRejectedValueOnce(transientError('Bedrock is unable to process your request.', 503))
      .mockResolvedValueOnce(ANSWER)

    const events: StreamEvent[] = []
    await runTurn(events)

    expect(messagesCreate).toHaveBeenCalledTimes(3)
    expect(backoffs).toEqual([PRE_OUTPUT_RETRY_DELAYS_MS[0], PRE_OUTPUT_RETRY_DELAYS_MS[1]])
    expect(PRE_OUTPUT_RETRY_DELAYS_MS[1]!).toBeGreaterThan(PRE_OUTPUT_RETRY_DELAYS_MS[0]!)
    expect(events.find((e) => e.kind === 'error')).toBeUndefined()
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ assistant_text: '' })
  })

  it('tells the user the assistant is overloaded once the pre-output retries are spent', async () => {
    messagesCreate.mockRejectedValue(overloadedStreamError())

    const events: StreamEvent[] = []
    await expect(runTurn(events)).rejects.toThrow('overloaded_error')

    expect(messagesCreate).toHaveBeenCalledTimes(PRE_OUTPUT_RETRY_DELAYS_MS.length + 1)
    expect(backoffs).toEqual([...PRE_OUTPUT_RETRY_DELAYS_MS])
    expect(events.filter((e) => e.kind === 'error')).toEqual([{ kind: 'error', message: OVERLOAD_MESSAGE }])
  })

  it('restarts an attempt that already streamed text only once per turn', async () => {
    const failAfterText = async (_args: unknown, listeners: StreamListeners) => {
      listeners.text?.('Hej')
      throw transientError('Service unavailable', 503)
    }
    messagesCreate.mockImplementationOnce(failAfterText).mockImplementationOnce(failAfterText)

    const events: StreamEvent[] = []
    await expect(runTurn(events)).rejects.toThrow('Service unavailable')

    expect(messagesCreate).toHaveBeenCalledTimes(2)
    expect(events.filter((e) => e.kind === 'stream_restart')).toEqual([{ kind: 'stream_restart', assistant_text: '' }])
    expect(events.find((e) => e.kind === 'error')).toEqual({ kind: 'error', message: OVERLOAD_MESSAGE })
  })

  it('starts no retry once the turn has spent the retry window', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    messagesCreate
      .mockImplementationOnce(async () => {
        throw overloadedStreamError()
      })
      .mockImplementationOnce(async () => {
        now += 60_000
        throw overloadedStreamError()
      })

    const events: StreamEvent[] = []
    await expect(runTurn(events)).rejects.toThrow('overloaded_error')

    expect(messagesCreate).toHaveBeenCalledTimes(2)
    expect(events.find((e) => e.kind === 'error')).toEqual({ kind: 'error', message: OVERLOAD_MESSAGE })
  })

  it('does not retry a non-transient failure (403): error emitted, turn thrown', async () => {
    messagesCreate.mockRejectedValueOnce(transientError('Forbidden', 403))

    const events: StreamEvent[] = []
    await expect(runTurn(events)).rejects.toThrow('Forbidden')

    expect(events.filter((e) => e.kind === 'stream_restart')).toHaveLength(0)
    expect(events.find((e) => e.kind === 'error')).toBeDefined()
    expect(messagesCreate).toHaveBeenCalledTimes(1)
  })

})
