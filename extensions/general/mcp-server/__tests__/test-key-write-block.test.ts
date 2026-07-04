/**
 * Tests for the test-mode API-key write guard in the MCP dispatcher.
 *
 * A `gnubok_sk_test_` key is bound to the REAL active company. On the v1 REST
 * surface every write is forced to dry-run (or blocked when it can't be
 * simulated). The MCP tools/call path must mirror that: a write tool that
 * cannot be simulated is refused BEFORE execute() so a test key can never stage
 * a real pending_operation (and, with the approve scope, commit it). Read tools
 * pass through unchanged.
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
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    // A TEST-mode key holding the approve scope, so the scope gate passes and
    // the test-key write guard is what we exercise.
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['pending_operations:approve', 'reports:read'],
      apiKeyId: 'key-test-1',
      apiKeyName: 'Test Key',
      mode: 'test',
    }),
    createServiceClientNoCookies: vi.fn(() => ({ from: () => chain, rpc: () => chain })),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { handleMcpRequest } from '../server'

function mcpToolCall(name: string, args: Record<string, unknown> = {}): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
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

describe('MCP test-key write guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('blocks a non-simulatable write tool for a test-mode key: before execute()', async () => {
    const eventPromise = captureNextToolCalled()

    // approve has readOnlyHint:false and no dry_run param → cannot be simulated.
    const response = await handleMcpRequest(
      mcpToolCall('gnubok_approve_pending_operation', { operation_id: 'op-1' }),
    )
    const { isError } = await parsedToolResult(response)

    expect(isError).toBe(true)
    const event = await eventPromise
    expect(event.errorKind).toBe('test_key_write_blocked')
    expect(event.success).toBe(false)
    // Exits before tool.execute(): no pending op is ever committed.
    expect(event.latencyMs).toBe(0)
  })

  it('lets a read-only tool through for a test-mode key', async () => {
    const eventPromise = captureNextToolCalled()

    await handleMcpRequest(mcpToolCall('gnubok_list_skills', {}))

    const event = await eventPromise
    // Whatever happens inside execute(), the test-key guard must NOT fire on a
    // read tool.
    expect(event.errorKind).not.toBe('test_key_write_blocked')
  })
})
