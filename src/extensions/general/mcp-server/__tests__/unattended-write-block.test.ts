/**
 * Tests for the unattended-session guard in the MCP dispatcher (unattended.ts):
 * a scheduled routine calls get_task with unattended: true, and from then on
 * its session may read and stage but never approve or commit directly. The
 * refusal happens before execute(), whatever the AI was told by what it read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
        }
        return () => chain
      },
    },
  )
  const membershipChain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve({
              data: {
                company_id: '11111111-1111-4111-8111-111111111111',
                role: 'owner',
              },
              error: null,
            })
        }
        return () => membershipChain
      },
    }
  )
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    // A LIVE key holding the approve scope: the unattended guard is what we exercise.
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['pending_operations:approve', 'reports:read', 'transactions:write', 'agent:read'],
      apiKeyId: 'key-live-1',
      apiKeyName: 'Live Key',
      mode: 'live',
    }),
    createServiceClientNoCookies: vi.fn(() => ({
      from: (table: string) => (table === 'company_members' ? membershipChain : chain),
      rpc: () => chain,
    })),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { handleMcpRequest } from '../server'
import { resetUnattendedForTests } from '../unattended'

function mcpToolCall(name: string, args: Record<string, unknown> = {}, sessionId?: string): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token', ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
}

interface ToolCalledEvent {
  tool: string
  success: boolean
  isError: boolean
  errorKind: string | null
  latencyMs: number
}

function captureNextToolCalled(): Promise<ToolCalledEvent> {
  return new Promise((resolve) => {
    const off = eventBus.on('mcp.tool_called', (payload) => {
      off()
      resolve(payload as unknown as ToolCalledEvent)
    })
  })
}

async function parsedToolResult(response: Response): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const json = await response.json()
  const result = json.result as { isError?: boolean; content: { text: string }[] }
  return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) }
}

describe('MCP unattended-session guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    resetUnattendedForTests()
  })

  async function kindOf(request: Request): Promise<{ kind: string | null; latencyMs: number; isError: boolean }> {
    const eventPromise = captureNextToolCalled()
    const response = await handleMcpRequest(request)
    const { isError } = await parsedToolResult(response)
    const event = await eventPromise
    return { kind: event.errorKind, latencyMs: event.latencyMs, isError }
  }

  it('refuses an approval in a session that started with get_task unattended: true, before execute()', async () => {
    await kindOf(mcpToolCall('gnubok_get_task', { kind: 'agent:bookkeep', client: 'claude', unattended: true }, 'routine-run-1'))
    const approve = await kindOf(mcpToolCall('gnubok_approve_pending_operation', { operation_id: '11111111-1111-4111-8111-111111111112' }, 'routine-run-1'))
    expect(approve.isError).toBe(true)
    expect(approve.kind).toBe('unattended_write_blocked')
    expect(approve.latencyMs).toBe(0)
  })

  it('leaves other sessions, and calls without a session id, alone', async () => {
    await kindOf(mcpToolCall('gnubok_get_task', { kind: 'agent:bookkeep', client: 'claude', unattended: true }, 'routine-run-2'))
    const other = await kindOf(mcpToolCall('gnubok_approve_pending_operation', { operation_id: '11111111-1111-4111-8111-111111111112' }, 'someone-at-the-desk'))
    expect(other.kind).not.toBe('unattended_write_blocked')
    const none = await kindOf(mcpToolCall('gnubok_approve_pending_operation', { operation_id: '11111111-1111-4111-8111-111111111112' }))
    expect(none.kind).not.toBe('unattended_write_blocked')
  })

  it('still lets an unattended session read and stage', async () => {
    await kindOf(mcpToolCall('gnubok_get_task', { kind: 'agent:bookkeep', client: 'claude', unattended: true }, 'routine-run-3'))
    const read = await kindOf(mcpToolCall('gnubok_list_skills', {}, 'routine-run-3'))
    expect(read.kind).not.toBe('unattended_write_blocked')
    const stage = await kindOf(mcpToolCall('gnubok_categorize_transaction', { transaction_id: '11111111-1111-4111-8111-111111111113', account: '6540' }, 'routine-run-3'))
    expect(stage.kind).not.toBe('unattended_write_blocked')
  })

  it('does not mark a session for an attended get_task', async () => {
    await kindOf(mcpToolCall('gnubok_get_task', { kind: 'agent:bookkeep', client: 'claude' }, 'desk-run'))
    const approve = await kindOf(mcpToolCall('gnubok_approve_pending_operation', { operation_id: '11111111-1111-4111-8111-111111111112' }, 'desk-run'))
    expect(approve.kind).not.toBe('unattended_write_blocked')
  })
})
