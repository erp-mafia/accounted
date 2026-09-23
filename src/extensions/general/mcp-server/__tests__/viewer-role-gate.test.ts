/**
 * Read-only role gate on the MCP tools/call path.
 *
 * The MCP surface runs as the service role, so RLS never sees the caller's
 * company role. The dispatcher (server.ts, tools/call) therefore calls
 * assertMcpCompanyWriteAccess() right after resolveMcpCompanyContext() for
 * every company-scoped call. A `viewer` membership must be refused on every
 * tool that requires a non-:read scope, even when the KEY carries that scope
 * (effective permission = key scopes intersected with the user's role), and
 * must pass unchanged on read tools. The bridge tool (gnubok_call_tool) is
 * rewritten to the inner tool before routing, so the same gate applies there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

// Everything the hoisted vi.mock factories reference must itself be hoisted.
const mocks = vi.hoisted(() => ({
  companyId: '11111111-1111-4111-8111-111111111111',
  role: 'viewer' as string,
  /** Every table the dispatcher or a tool touched, in order. */
  tables: [] as string[],
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  // Generic query chain: every builder method returns the chain, awaiting it
  // yields an empty result. Enough for read tools that tolerate `data: null`.
  const emptyChain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
        }
        return () => emptyChain
      },
    },
  )
  const membershipChain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: { company_id: mocks.companyId, role: mocks.role }, error: null })
        }
        return () => membershipChain
      },
    },
  )
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    // A LIVE key holding both a write and a read scope, so the scope gate
    // passes and the role gate is what decides.
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-viewer',
      companyId: mocks.companyId,
      scopes: ['customers:write', 'reports:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Viewer Key',
      mode: 'live',
    }),
    createServiceClientNoCookies: vi.fn(() => ({
      from: (table: string) => {
        mocks.tables.push(table)
        return table === 'company_members' ? membershipChain : emptyChain
      },
      rpc: () => emptyChain,
    })),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

// Seat gate entitled: a viewer is a non-owner, so the gate would otherwise
// read companies + capability_grants through the empty chain above.
vi.mock('@/lib/entitlements/multi-user', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/multi-user')>()
  return {
    ...actual,
    getMultiUserState: vi.fn().mockResolvedValue({ state: 'entitled', graceEndsAt: null }),
  }
})

import { handleMcpRequest } from '../server'

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

async function parsedToolResult(
  response: Response,
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const json = await response.json()
  const result = json.result as { isError?: boolean; content: { text: string }[] }
  return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) }
}

describe('MCP read-only role gate (viewer)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mocks.role = 'viewer'
    mocks.tables.length = 0
  })

  it('refuses a viewer on a write tool before execute(), even though the key holds the scope', async () => {
    const result = await parsedToolResult(
      await handleMcpRequest(
        mcpToolCall('gnubok_create_customer', { name: 'Kund AB', customer_type: 'company' }),
      ),
    )

    expect(result.isError).toBe(true)
    const error = result.payload.error as Record<string, unknown>
    expect(error.code).toBe('FORBIDDEN')
    expect(String(error.message_en)).toMatch(/read-only \(viewer\)/)
    expect(String(error.message_en)).toContain('"customers:write"')
    // Only the membership lookup ran: nothing tenant-shaped was touched.
    expect(mocks.tables).toEqual(['company_members'])
  })

  it('routes a viewer read through the gnubok_call_tool bridge unchanged', async () => {
    // The bridge is read-only by design (call-tool-bridge.test.ts): writes
    // must be named directly, so the role gate has nothing to add there. What
    // matters is that a bridged read still resolves the company and runs.
    const result = await parsedToolResult(
      await handleMcpRequest(
        mcpToolCall('gnubok_call_tool', { tool: 'gnubok_list_fiscal_periods', arguments: {} }),
      ),
    )

    expect(result.isError).toBe(false)
    expect(result.payload).toMatchObject({ periods: [], count: 0 })
    expect(mocks.tables[0]).toBe('company_members')
    expect(mocks.tables).toContain('fiscal_periods')
  })

  it('lets a viewer run a read tool unchanged', async () => {
    const result = await parsedToolResult(
      await handleMcpRequest(mcpToolCall('gnubok_list_fiscal_periods')),
    )

    expect(result.isError).toBe(false)
    expect(result.payload).toMatchObject({ periods: [], count: 0 })
    expect(mocks.tables).toContain('fiscal_periods')
  })

  it('lets a member through the role gate on the same write tool', async () => {
    mocks.role = 'member'
    const telemetry = new Promise<{ errorKind: string | null }>((resolve) => {
      const off = eventBus.on('mcp.tool_called', (payload) => {
        off()
        resolve(payload as unknown as { errorKind: string | null })
      })
    })

    const result = await parsedToolResult(
      await handleMcpRequest(
        mcpToolCall('gnubok_create_customer', { name: 'Kund AB', customer_type: 'swedish_business' }),
      ),
    )

    // Whatever the empty-chain stub makes execute() return, the role gate did
    // not fire: the refusal kind is not an access denial and the message is
    // not the read-only one.
    expect((await telemetry).errorKind).not.toBe('company_access_denied')
    if (result.isError) {
      const error = result.payload.error as Record<string, unknown>
      expect(error.code).not.toBe('FORBIDDEN')
      expect(String(error.message_en)).not.toMatch(/read-only \(viewer\)/)
    }
  })
})
