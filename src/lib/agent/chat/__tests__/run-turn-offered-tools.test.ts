import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentIntent } from '@/lib/agent/intents/types'
import type { AgentTool } from '@/lib/agent/tools/types'
import type { StreamEvent } from '../run-turn'
import { createQueuedMockSupabase } from '@/tests/helpers'

// Only a tool offered for the turn may run. A viewer's turn is offered read
// tools only, so a write tool the model names anyway (steered, for example,
// by text planted in a document) is answered with an error and never runs.

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

function makeTool(name: string): AgentTool {
  return {
    name,
    description: '',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    execute: vi.fn().mockResolvedValue({ ok: true }),
  }
}

const readTool = makeTool('gnubok_query_journal')
const writeTool = makeTool('gnubok_categorize_transaction')
const allTools = [readTool, writeTool]

// The registry knows both tools: the refusal must come from the turn's
// offered set, not from the tool being unknown.
vi.mock('@/lib/agent/tools/registry', () => ({
  agentToolRegistry: {
    get: async (name: string) => allTools.find((t) => t.name === name),
    getMany: async (names: string[]) => allTools.filter((t) => names.includes(t.name)),
  },
}))

import { runChatTurn } from '../run-turn'

// Every read resolves empty: no profile, memory or history for the turn.
const fakeSupabase = () =>
  createQueuedMockSupabase().supabase as unknown as Parameters<typeof runChatTurn>[0]['supabase']

function makeIntent(): AgentIntent {
  return {
    id: 'transaction.categorization',
    buttonLabel: 'x',
    sheetTitle: 'x',
    atoms: { mode: 'progressive', horizontal: [], includeCompanyVertical: false, includeCompanyModifiers: false },
    tools: ['gnubok_query_journal', 'gnubok_categorize_transaction'],
    model: 'claude-sonnet-5',
    capture: async () => ({}),
    promptTemplate: () => '',
  }
}

async function runTurn(readOnly: boolean) {
  const events: StreamEvent[] = []
  await runChatTurn({
    supabase: fakeSupabase(),
    userId: 'user-1',
    companyId: 'company-1',
    companyName: 'Acme AB',
    firstName: 'Anna',
    intent: makeIntent(),
    conversationId: 'conv-1',
    userMessage: 'bokför den här',
    persist: false,
    readOnly,
    emit: (e) => {
      events.push(e)
      return true
    },
  })
  return events
}

function modelNames(name: string) {
  messagesCreate
    .mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'tu_1', name, input: { transaction_id: 'tx-1' } }],
      stop_reason: 'tool_use',
    })
    .mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Klart.' }],
      stop_reason: 'end_turn',
    })
}

type ToolResult = { type: string; tool_use_id: string; is_error?: boolean; content: string }

/** The tool_result blocks sent back to the model on its second call. */
function toolResultsSentBack(): ToolResult[] {
  // The turn keeps appending to the array it passed, so find the message.
  const second = messagesCreate.mock.calls[1]?.[0] as { messages: { role: string; content: unknown }[] }
  const message = second.messages.find(
    (m) => m.role === 'user' && Array.isArray(m.content) && (m.content as ToolResult[]).some((b) => b.type === 'tool_result'),
  )
  return (message?.content ?? []) as ToolResult[]
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runChatTurn: only offered tools run', () => {
  it('offers a read-only turn the read tools only', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Hej.' }], stop_reason: 'end_turn' })
    await runTurn(true)
    const offered = (messagesCreate.mock.calls[0][0] as { tools?: { name: string }[] }).tools?.map((t) => t.name)
    expect(offered).toEqual(['gnubok_query_journal'])
  })

  it('refuses a write tool the model names in a read-only turn, and does not run it', async () => {
    modelNames('gnubok_categorize_transaction')

    await runTurn(true)

    expect(writeTool.execute).not.toHaveBeenCalled()
    expect(toolResultsSentBack()).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        is_error: true,
        content: 'Verktyget gnubok_categorize_transaction är inte tillgängligt i den här konversationen.',
      },
    ])
  })

  it('runs an offered read tool in a read-only turn', async () => {
    modelNames('gnubok_query_journal')

    await runTurn(true)

    expect(readTool.execute).toHaveBeenCalledTimes(1)
    expect(toolResultsSentBack()[0].is_error).toBeUndefined()
  })

  it('runs the write tool in a turn that offers it', async () => {
    modelNames('gnubok_categorize_transaction')

    await runTurn(false)

    expect(writeTool.execute).toHaveBeenCalledTimes(1)
  })
})
