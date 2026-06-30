/**
 * Tests for the capability paywall gate in the MCP dispatcher.
 *
 * The paid external-service tools (send_invoice → email_send, the two
 * Skatteverket submissions → skatteverket) must be blocked server-side when the
 * company isn't entitled — BEFORE tool.execute() runs, so no pending op is
 * staged. The gate sits right after the API-key scope check and mirrors its
 * shape, so the test key holds the required SCOPE but the company may lack the
 * CAPABILITY. Self-hosted short-circuits hasCapability to all-on (covered in
 * lib/entitlements/__tests__/has-capability.test.ts), so here we drive the
 * gate directly via a mocked hasCapability.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  // A minimal chainable Supabase stub — only reached if the gate lets a call
  // through to execute(); resolves everything to null so execute fails with a
  // plain execution error (never capability_blocked).
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
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      // Holds the SCOPES for all three paid tools so the scope gate passes and
      // the CAPABILITY gate is what we exercise.
      scopes: ['invoices:write', 'skatteverket:write', 'reports:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Test Key',
    }),
    createServiceClientNoCookies: vi.fn(() => ({ from: () => chain, rpc: () => chain })),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn() }
})

import { handleMcpRequest } from '../server'
import { hasCapability } from '@/lib/entitlements/has-capability'

const mockHasCapability = vi.mocked(hasCapability)

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
  errorCode: string | null
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

describe('MCP capability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('blocks gnubok_send_invoice when email_send is not entitled — before execute()', async () => {
    mockHasCapability.mockResolvedValue(false)
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(mcpToolCall('gnubok_send_invoice', { invoice_id: 'inv-1' }))
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(true)
    expect((payload.error as Record<string, unknown>).capability_blocked).toBe(true)
    expect((payload.error as Record<string, unknown>).capability).toBe('email_send')
    expect(mockHasCapability).toHaveBeenCalledWith(expect.anything(), '11111111-1111-4111-8111-111111111111', 'email_send')

    const event = await eventPromise
    expect(event.errorKind).toBe('capability_denied')
    expect(event.errorCode).toBe('capability_blocked')
    expect(event.success).toBe(false)
    // The gate exits before tool.execute(), exactly like scope denial.
    expect(event.latencyMs).toBe(0)
  })

  it('blocks gnubok_agi_submit when skatteverket is not entitled', async () => {
    mockHasCapability.mockResolvedValue(false)

    const response = await handleMcpRequest(mcpToolCall('gnubok_agi_submit', { salary_run_id: 'sr-1' }))
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(true)
    expect((payload.error as Record<string, unknown>).capability).toBe('skatteverket')
    expect(mockHasCapability).toHaveBeenCalledWith(expect.anything(), '11111111-1111-4111-8111-111111111111', 'skatteverket')
  })

  it('lets a free tool through without consulting the capability gate', async () => {
    mockHasCapability.mockResolvedValue(false)

    await handleMcpRequest(mcpToolCall('gnubok_list_skills', {}))

    // gnubok_list_skills has no MCP_TOOL_CAPABILITY_MAP entry — the gate is skipped entirely.
    expect(mockHasCapability).not.toHaveBeenCalled()
  })

  it('proceeds to execute() when the company IS entitled (no capability_blocked)', async () => {
    mockHasCapability.mockResolvedValue(true)
    const eventPromise = captureNextToolCalled()

    const response = await handleMcpRequest(mcpToolCall('gnubok_send_invoice', { invoice_id: 'inv-1' }))
    const { payload } = await parsedToolResult(response)

    // Gate passed → execute() runs (and fails for an unrelated reason: email not
    // configured / invoice not found). The point is it is NOT capability_blocked.
    expect((payload.error as Record<string, unknown> | undefined)?.capability_blocked).toBeUndefined()
    expect(mockHasCapability).toHaveBeenCalledWith(expect.anything(), '11111111-1111-4111-8111-111111111111', 'email_send')

    const event = await eventPromise
    expect(event.errorKind).not.toBe('capability_denied')
  })
})
