/**
 * The permission shadow at the in-app assistant: each tool call is reported
 * as what it did (staged, acted, refused), the turn's events are identical
 * with the shadow on and off, and a disagreement schedules exactly one log
 * write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentIntent } from '@/lib/agent/intents/types'
import type { AgentTool } from '@/lib/agent/tools/types'
import { DOOR_SPECS, type DoorRule } from '@/lib/permissions/doors'
import type { StreamEvent } from '../run-turn'

const messagesCreate = vi.fn()
vi.mock('@/lib/agent/composer/client', () => ({
  getAnthropic: () => ({
    messages: {
      create: messagesCreate,
      stream: (args: unknown) => {
        const stream = { on: () => stream, finalMessage: () => messagesCreate(args) }
        return stream
      },
    },
  }),
  SONNET_MODEL: 'claude-sonnet-5',
  MAX_TOKENS_STANDARD: 16000,
  MAX_TOKENS_DEEP: 24000,
}))

vi.mock('../system-prompt', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue({ blocks: [], promptHash: 'sha256:test', atomsLoaded: [] }),
}))

const registry = vi.hoisted(() => ({ tool: null as unknown, door: null as unknown }))
vi.mock('@/lib/agent/tools/registry', () => ({
  agentToolRegistry: {
    get: async () => registry.tool,
    getMany: async () => [registry.tool],
    doorOf: () => registry.door,
  },
}))

import { insertShadowRow } from '@/lib/permissions/shadow-writer'
import { resetPermissionShadowForTests } from '@/lib/permissions/shadow'
import { runChatTurn } from '../run-turn'
import { createMockSupabase } from '@/tests/helpers'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeSupabase() {
  return createMockSupabase().supabase as unknown as Parameters<typeof runChatTurn>[0]['supabase']
}

function intent(toolName: string): AgentIntent {
  return {
    id: 'general.help',
    buttonLabel: 'x',
    sheetTitle: 'x',
    atoms: { mode: 'progressive', horizontal: [], includeCompanyVertical: false, includeCompanyModifiers: false },
    tools: [toolName],
    model: 'claude-sonnet-5',
    capture: async () => ({}),
    promptTemplate: () => '',
  }
}

function tool(name: string, result: unknown): AgentTool {
  return {
    name,
    description: '',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    execute: vi.fn().mockResolvedValue(result),
  }
}

async function turn(toolName: string, role: string): Promise<StreamEvent[]> {
  messagesCreate
    .mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'tu_1', name: toolName, input: {} }],
      stop_reason: 'tool_use',
    })
    .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Klart.' }], stop_reason: 'end_turn' })
  const events: StreamEvent[] = []
  await runChatTurn({
    supabase: fakeSupabase(),
    userId: 'user-1',
    companyId: 'company-1',
    companyName: 'Acme AB',
    firstName: 'Anna',
    intent: intent(toolName),
    conversationId: 'conv-1',
    userMessage: 'hej',
    persist: false,
    role,
    emit: (e) => {
      events.push(e)
      return true
    },
  })
  return events
}

async function turnTwice(toolName: string, role: string) {
  process.env.PERMISSIONS_SHADOW = 'off'
  const off = await turn(toolName, role)
  await flush()
  expect(insertShadowRow).not.toHaveBeenCalled()
  delete process.env.PERMISSIONS_SHADOW
  const on = await turn(toolName, role)
  await flush()
  return { off, on }
}

describe('runChatTurn: permission shadow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPermissionShadowForTests()
    delete process.env.PERMISSIONS_SHADOW
  })
  afterEach(() => {
    delete process.env.PERMISSIONS_SHADOW
  })

  it("logs nothing when the assistant stages a member's write, and the turn is the same", async () => {
    registry.tool = tool('gnubok_create_voucher', { staged: true, operation_id: 'op-1', risk_level: 'medium' })
    registry.door = { ...DOOR_SPECS.BOOK, stageable: true } satisfies DoorRule
    const { off, on } = await turnTwice('gnubok_create_voucher', 'member')
    expect(on).toEqual(off)
    expect(insertShadowRow).not.toHaveBeenCalled()
  })

  it("logs one row when a viewer's turn runs a write, and the turn is the same", async () => {
    registry.tool = tool('gnubok_sync_bank', { synced: 0 })
    registry.door = { ...DOOR_SPECS.BOOK_HOUSE, stageable: false } satisfies DoorRule
    const { off, on } = await turnTwice('gnubok_sync_bank', 'viewer')
    expect(on).toEqual(off)
    expect(insertShadowRow).toHaveBeenCalledTimes(1)
    expect(insertShadowRow).toHaveBeenCalledWith(
      expect.objectContaining({
        door: 'assistant:gnubok_sync_bank',
        method: null,
        principal_kind: 'assistant',
        user_id: 'user-1',
        company_id: 'company-1',
        today_outcome: 'allow',
        decide_outcome: 'deny',
        decide_reason: 'SPONSOR_LACKS_PERMISSION',
        expected: false,
      }),
    )
  })

  it('logs a direct ledger write the assistant could only have staged', async () => {
    registry.tool = tool('gnubok_create_transactions', { created: 1 })
    registry.door = { ...DOOR_SPECS.BOOK, stageable: false } satisfies DoorRule
    const { off, on } = await turnTwice('gnubok_create_transactions', 'owner')
    expect(on).toEqual(off)
    expect(insertShadowRow).toHaveBeenCalledWith(
      expect.objectContaining({ today_outcome: 'allow', decide_outcome: 'deny', decide_reason: 'STAGE_REQUIRED' }),
    )
  })
})
