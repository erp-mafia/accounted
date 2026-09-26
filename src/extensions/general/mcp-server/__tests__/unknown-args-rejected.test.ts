/**
 * tools/call rejects unknown top-level parameters instead of dropping them.
 *
 * Feedback seq 261545: gnubok_query_journal called with {query} instead of
 * {text} silently returned the whole journal. Hosts do not reliably enforce
 * inputSchema, so the server does (arg-guard.ts), before execute() and as
 * the structured VALIDATION_ERROR envelope.
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
      scopes: ['reports:read', 'transactions:read'],
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

function mcpToolCall(name: string, args: Record<string, unknown> = {}): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
}

async function parsedToolResult(response: Response): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const json = await response.json()
  const result = json.result as { isError?: boolean; content: { text: string }[] }
  return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) }
}

describe('MCP tools/call unknown-parameter guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('rejects a misspelled parameter with a structured VALIDATION_ERROR naming the valid keys', async () => {
    const response = await handleMcpRequest(mcpToolCall('gnubok_query_journal', { searchterm: 'hyra' }))
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(true)
    const error = payload.error as { code: string; message_en: string; retryable: boolean }
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.retryable).toBe(false)
    expect(error.message_en).toContain('"searchterm"')
    expect(error.message_en).toContain('text')
  })

  // report-arg-aliases.ts: the {query} call that feedback seq 261545 saw
  // silently return the whole journal now searches, instead of failing.
  it('maps a known report-tool synonym onto the canonical parameter', async () => {
    const response = await handleMcpRequest(mcpToolCall('gnubok_query_journal', { query: 'hyra' }))
    const { payload } = await parsedToolResult(response)
    const error = payload.error as { code?: string; message_en?: string } | undefined
    expect(error?.message_en ?? '').not.toContain('Unknown parameter')
  })

  it('refuses an alias given together with its canonical parameter', async () => {
    const response = await handleMcpRequest(
      mcpToolCall('gnubok_get_kpi_report', { metric: 'cash_position', metrics: ['net_result'] }),
    )
    const { isError, payload } = await parsedToolResult(response)
    expect(isError).toBe(true)
    const error = payload.error as { code: string; message_en: string }
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_en).toContain('Conflicting parameters')
  })

  it('names the likely parameter for an unknown synonym on a non-aliased tool', async () => {
    const response = await handleMcpRequest(mcpToolCall('gnubok_get_ar_ledger', { as_of: '2026-01-01' }))
    const { isError, payload } = await parsedToolResult(response)
    expect(isError).toBe(true)
    const error = payload.error as { code: string; message_en: string }
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_en).toContain('Did you mean: "as_of" -> "as_of_date"?')
  })

  it('does not fire for a well-formed call (the tool itself runs)', async () => {
    const response = await handleMcpRequest(mcpToolCall('gnubok_list_skills', {}))
    const { payload } = await parsedToolResult(response)
    const error = payload.error as { code?: string } | undefined
    expect(error?.code).not.toBe('VALIDATION_ERROR')
  })
})
