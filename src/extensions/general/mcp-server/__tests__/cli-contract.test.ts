/**
 * Contract between this server and the `accounted` CLI (packages/accounted-cli).
 *
 * The CLI ships no tool list and no copy of this protocol: it builds requests
 * with its own envelope() and reads answers with its own unwrapRpc() and
 * classifyToolResult(). These tests push exactly those requests through
 * handleMcpRequest, so a server change that would break published CLIs fails
 * here instead of on a customer's machine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { mcpUrl } from '../../../../../packages/accounted-cli/lib/config.mjs'
import { UsageError } from '../../../../../packages/accounted-cli/lib/errors.mjs'
import { classifyToolResult, envelope, unwrapRpc } from '../../../../../packages/accounted-cli/lib/mcp.mjs'
import { CLIENT_NAME } from '../../../../../packages/accounted-cli/lib/version.mjs'

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: [...actual.ALL_SCOPES],
      apiKeyId: 'key-1',
      apiKeyName: 'Test key',
      mode: 'live',
    }),
    // An empty client: any tool that reaches the database fails during
    // execution, which yields an isError tool result.
    createServiceClientNoCookies: vi.fn(() => ({})),
  }
})

import { handleMcpRequest } from '../server'

/** One request exactly as the CLI sends it (session.mjs), answer as it reads it. */
async function cli(method: string, params: Record<string, unknown> = {}, options: { tasks?: boolean } = {}) {
  const request = new Request(mcpUrl('http://localhost:3000', undefined), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': `${CLIENT_NAME} node/test`,
      'X-Accounted-Client': CLIENT_NAME,
      Authorization: 'Bearer test-token',
    },
    body: JSON.stringify(envelope(method, params, options)),
  })
  const response = await handleMcpRequest(request)
  return unwrapRpc({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    text: await response.text(),
  })
}

describe('accounted CLI contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('guide: server/discover answers with instructions in the accounted_ namespace', async () => {
    const result = await cli('server/discover')
    expect(typeof result.instructions).toBe('string')
    expect(result.instructions).toContain('accounted_search_tools')
  })

  it('tools: tools/list answers with accounted_* tools', async () => {
    const result = await cli('tools/list')
    const tools = result.tools as { name: string; description?: string }[]
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every((t) => t.name.startsWith('accounted_'))).toBe(true)
  })

  it('tools <words> and describe: search_tools answers with a tools array the CLI can read', async () => {
    const outcome = classifyToolResult(
      await cli(
        'tools/call',
        { name: 'accounted_search_tools', arguments: { query: 'list invoices', detail: 'full', limit: 50 } },
        { tasks: true }
      )
    )
    expect(outcome.kind).toBe('ok')
    const data = (outcome as { data: { tools: { name: string; inputSchema?: unknown }[] } }).data
    const hit = data.tools.find((t) => t.name === 'accounted_list_invoices')
    expect(hit?.inputSchema).toBeDefined()
  })

  it('call: a failing tool reaches the CLI as an error object, not a protocol error', async () => {
    const outcome = classifyToolResult(
      await cli('tools/call', { name: 'accounted_get_trial_balance', arguments: {} }, { tasks: true })
    )
    expect(outcome.kind).toBe('error')
    expect(typeof (outcome as { error: { code?: unknown } }).error.code).toBe('string')
  })

  it('call: a search-only tool is callable by name, without the call_tool bridge', async () => {
    const listed = (await cli('tools/list')).tools as { name: string }[]
    expect(listed.map((t) => t.name)).not.toContain('accounted_list_transactions_without_documents')
    const result = await cli(
      'tools/call',
      { name: 'accounted_list_transactions_without_documents', arguments: {} },
      { tasks: true }
    )
    // Resolved and executed (it fails on the empty database mock), not refused as unknown.
    expect(['ok', 'error']).toContain(classifyToolResult(result).kind)
  })

  it('call: an unknown tool reaches the CLI as a usage error with suggestions', async () => {
    await expect(
      cli('tools/call', { name: 'accounted_list_invoicez', arguments: {} }, { tasks: true })
    ).rejects.toThrow(UsageError)
    await expect(
      cli('tools/call', { name: 'accounted_list_invoicez', arguments: {} }, { tasks: true })
    ).rejects.toThrow(/Unknown tool/)
  })
})
