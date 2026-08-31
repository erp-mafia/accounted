/**
 * Tests for the gnubok_call_tool bridge in the MCP dispatcher.
 *
 * Server-side, every tool has always been callable: `tools/call` resolves the
 * name against the whole `tools` array, and `isDefaultCatalogTool` gates only
 * what tools/list SHOWS. The failure was purely client-side, and DECISIONS.md
 * records the consequence on 2026-08-26: `gnubok_reconcile_match` had to be
 * promoted back into the default catalog because "a search-only tool is
 * uncallable on Claude.ai".
 *
 * The bridge gives such a client one visible name to forward through. It is
 * implemented as a REWRITE ahead of tool resolution rather than as a wrapper
 * that calls the inner tool's execute(), because everything between resolution
 * and execute (scope check, unknown-argument guard, company routing, the
 * test-key write block, staging _meta, telemetry) must apply to the real
 * target. These tests exist to prove it does.
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
              data: { company_id: '11111111-1111-4111-8111-111111111111', role: 'owner' },
              error: null,
            })
        }
        return () => membershipChain
      },
    },
  )
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['transactions:read', 'reports:read', 'pending_operations:approve'],
      apiKeyId: 'key-1',
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

import { handleMcpRequest, tools, isDefaultCatalogTool } from '../server'
import { validateApiKey, extractBearerToken } from '@/lib/auth/api-keys'

function mcpToolCall(name: string, args: Record<string, unknown> = {}): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
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

async function parsedToolResult(
  response: Response,
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const json = await response.json()
  const result = json.result as { isError?: boolean; content: { text: string }[] }
  return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) }
}

const bridgeTool = tools.find((t) => t.name === 'gnubok_call_tool')!

describe('gnubok_call_tool registration', () => {
  it('is in the default catalog and read-only', () => {
    expect(bridgeTool).toBeDefined()
    expect(isDefaultCatalogTool(bridgeTool)).toBe(true)
    expect(bridgeTool.annotations.readOnlyHint).toBe(true)
  })

  it('has no direct implementation: the dispatcher rewrite is load-bearing', async () => {
    // If this ever resolves instead of throwing, the rewrite was removed and
    // every bridged call would have skipped the read-only check above it.
    await expect(
      bridgeTool.execute({}, 'company-id', 'user-id', {} as never, { type: 'api_key' }),
    ).rejects.toThrow(/no direct implementation/i)
  })
})

describe('gnubok_call_tool bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('forwards to the inner tool and attributes telemetry to it, not to the wrapper', async () => {
    const eventPromise = captureNextToolCalled()

    await handleMcpRequest(mcpToolCall('gnubok_call_tool', { tool: 'gnubok_list_skills' }))

    const event = await eventPromise
    expect(event.tool).toBe('gnubok_list_skills')
    expect(event.errorKind).not.toBe('bridge_refused')
  })

  it('reaches a search-only read tool, which is the whole point', async () => {
    const searchOnlyRead = tools.find(
      (t) => !isDefaultCatalogTool(t) && t.annotations.readOnlyHint === true,
    )!
    expect(searchOnlyRead).toBeDefined()
    const eventPromise = captureNextToolCalled()

    await handleMcpRequest(mcpToolCall('gnubok_call_tool', { tool: searchOnlyRead.name }))

    const event = await eventPromise
    expect(event.tool).toBe(searchOnlyRead.name)
    expect(event.errorKind).not.toBe('bridge_refused')
  })

  it('refuses a write target so the staging and approval contract stays visible', async () => {
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_call_tool', {
        tool: 'gnubok_approve_pending_operation',
        arguments: { operation_id: 'op-1' },
      }),
    )
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(true)
    expect(JSON.stringify(payload)).toContain('gnubok_approve_pending_operation')
    const event = await eventPromise
    expect(event.errorKind).toBe('bridge_refused')
    // Refused before execute(): nothing is staged, nothing is approved.
    expect(event.latencyMs).toBe(0)
  })

  it('refuses a call with no tool name', async () => {
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(mcpToolCall('gnubok_call_tool', {}))
    const { isError } = await parsedToolResult(response)

    expect(isError).toBe(true)
    const event = await eventPromise
    expect(event.errorKind).toBe('bridge_refused')
  })

  it('enforces the INNER tool scope, not the wrapper (which has none)', async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      // Deliberately omits transactions:read, which the inner tool requires.
      scopes: ['reports:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Narrow Key',
      mode: 'live',
    } as Awaited<ReturnType<typeof validateApiKey>>)
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_call_tool', { tool: 'gnubok_list_cash_accounts' }),
    )
    const { isError } = await parsedToolResult(response)

    expect(isError).toBe(true)
    const event = await eventPromise
    expect(event.errorKind).toBe('scope_denied')
    expect(event.tool).toBe('gnubok_list_cash_accounts')
  })

  it('applies the unknown-argument guard to the inner tool', async () => {
    const response = await handleMcpRequest(
      mcpToolCall('gnubok_call_tool', {
        tool: 'gnubok_list_skills',
        arguments: { nonexistent_parameter: 1 },
      }),
    )
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(true)
    expect(JSON.stringify(payload)).toContain('nonexistent_parameter')
  })

  it('is closed to anonymous callers: the pre-auth gate keys on the outer name', async () => {
    // gnubok_call_tool is deliberately absent from PUBLIC_TOOLS, so an
    // unauthenticated client cannot use it as a lever at all. Nothing is lost:
    // all three public tools are in the default catalog already.
    vi.mocked(extractBearerToken).mockReturnValueOnce(null)

    const response = await handleMcpRequest(
      mcpToolCall('gnubok_call_tool', { tool: 'gnubok_list_skills' }),
    )
    expect(response.status).toBe(401)
  })

  it('reports an unknown inner tool through the normal unknown-tool path', async () => {
    const response = await handleMcpRequest(
      mcpToolCall('gnubok_call_tool', { tool: 'gnubok_not_a_real_tool' }),
    )
    const json = (await response.json()) as { error?: { message?: string } }
    expect(json.error?.message).toContain('gnubok_not_a_real_tool')
  })
})
