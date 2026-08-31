import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  mocks.scopes = [...actual.ALL_SCOPES]
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: mocks.scopes,
      apiKeyId: 'key-1',
      apiKeyName: 'Test key',
      mode: 'live',
    }),
    createServiceClientNoCookies: vi.fn(() => ({})),
  }
})

import { handleMcpRequest, tools as canonicalTools } from '../server'
import { toPublicToolName } from '../tool-namespace'

function mcpRequest(
  method: string,
  params?: Record<string, unknown>,
  namespace?: 'accounted'
): Request {
  const url = new URL('http://localhost:3000/api/extensions/ext/mcp-server/mcp')
  if (namespace) url.searchParams.set('tool_namespace', namespace)

  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
  })
}

async function readResult(request: Request): Promise<Record<string, unknown>> {
  const response = await handleMcpRequest(request)
  const body = await response.json()
  return body.result as Record<string, unknown>
}

describe('MCP namespace compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('maps every canonical tool to one valid, unique Accounted name', () => {
    const accountedNames = canonicalTools.map((tool) =>
      toPublicToolName(tool.name, 'accounted')
    )

    expect(new Set(accountedNames).size).toBe(canonicalTools.length)
    for (const name of accountedNames) {
      expect(name).toMatch(/^[A-Za-z0-9_.\-/]{1,64}$/)
      expect(name).toMatch(/^accounted_/)
    }
  })

  it('keeps the legacy server identity and tool catalog by default', async () => {
    const initialized = await readResult(
      mcpRequest('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      })
    )
    const serverInfo = initialized.serverInfo as Record<string, unknown>
    expect(serverInfo.name).toBe('gnubok')
    // Build-derived (commit SHA prefix) or the '1.0.0' self-hosted fallback:
    // never empty, so clients can tell deploys apart.
    expect(typeof serverInfo.version).toBe('string')
    expect((serverInfo.version as string).length).toBeGreaterThan(0)
    expect(initialized.instructions).toContain('gnubok_search_tools')

    const listed = await readResult(mcpRequest('tools/list'))
    const tools = listed.tools as Array<{ name: string }>
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every((tool) => tool.name.startsWith('gnubok_'))).toBe(true)
  })

  it('advertises the Accounted identity, tools, and staging references when selected', async () => {
    const initialized = await readResult(
      mcpRequest(
        'initialize',
        {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
        'accounted'
      )
    )
    const serverInfo = initialized.serverInfo as Record<string, unknown>
    expect(serverInfo.name).toBe('accounted')
    expect(typeof serverInfo.version).toBe('string')
    expect((serverInfo.version as string).length).toBeGreaterThan(0)
    expect(initialized.instructions).toContain('accounted_search_tools')

    const listed = await readResult(mcpRequest('tools/list', undefined, 'accounted'))
    const tools = listed.tools as Array<{
      name: string
      _meta?: { approve_tool?: string; preflight?: string }
    }>
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every((tool) => tool.name.startsWith('accounted_'))).toBe(true)
    const canonicalNames = new Set(canonicalTools.map((tool) => tool.name))
    const leakedReferences =
      JSON.stringify(tools).match(/\bgnubok_[A-Za-z0-9_]+\b/g)?.filter((name) =>
        canonicalNames.has(name)
      ) ?? []
    expect(leakedReferences).toEqual([])

    const stagingTool = tools.find((tool) => tool._meta?.approve_tool)
    expect(stagingTool?._meta?.approve_tool).toBe(
      'accounted_approve_pending_operation'
    )
    if (stagingTool?._meta?.preflight) {
      expect(stagingTool._meta.preflight).toMatch(/^accounted_/)
    }
  })

  it('accepts both aliases while returning the selected public namespace', async () => {
    const params = {
      arguments: {
        query: 'list companies',
        detail: 'name',
        limit: 10,
      },
    }

    const accountedCall = await readResult(
      mcpRequest(
        'tools/call',
        { ...params, name: 'accounted_search_tools' },
        'accounted'
      )
    )
    const legacyAliasCall = await readResult(
      mcpRequest(
        'tools/call',
        { ...params, name: 'gnubok_search_tools' },
        'accounted'
      )
    )

    expect(accountedCall.structuredContent).toEqual(
      legacyAliasCall.structuredContent
    )
    const structured = accountedCall.structuredContent as {
      tools: Array<{ name: string }>
    }
    expect(structured.tools.length).toBeGreaterThan(0)
    expect(
      structured.tools.every((tool) => tool.name.startsWith('accounted_'))
    ).toBe(true)
  })

  it('projects prompt and loaded-skill tool references for Accounted clients', async () => {
    const prompt = await readResult(
      mcpRequest(
        'prompts/get',
        { name: 'cash_today' },
        'accounted'
      )
    )
    const messages = prompt.messages as Array<{
      content: { text: string }
    }>
    expect(messages[0].content.text).toContain('accounted_get_balance_sheet')
    expect(messages[0].content.text).not.toContain('gnubok_get_balance_sheet')

    const loaded = await readResult(
      mcpRequest(
        'tools/call',
        {
          name: 'accounted_load_skill',
          arguments: { slug: 'month-end-close' },
        },
        'accounted'
      )
    )
    const structured = loaded.structuredContent as { body: string }
    expect(structured.body).toContain('accounted_list_uncategorized_transactions')
    expect(structured.body).not.toContain('gnubok_list_uncategorized_transactions')
  })
})
