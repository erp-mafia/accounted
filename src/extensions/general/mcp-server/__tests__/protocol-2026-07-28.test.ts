import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  serviceClient: {} as unknown,
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
    createServiceClientNoCookies: vi.fn(() => mocks.serviceClient),
  }
})

/**
 * Chainable query builder resolving to empty rows: enough for the skills
 * registry load behind resources/list. The default service client stays {}
 * so tool-execution tests keep failing the way the isError test expects.
 */
function emptyRegistryClient(): unknown {
  const builder: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'order']) {
    builder[m] = () => builder
  }
  builder.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(onFulfilled)
  return { from: () => builder }
}

import { handleMcpRequest } from '../server'

const STATELESS_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {
    extensions: { 'io.modelcontextprotocol/ui': {} },
  },
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
}

function mcpRequest(
  method: string,
  params?: Record<string, unknown>,
  headers?: Record<string, string>
): Request {
  const url = new URL('http://localhost:3000/api/extensions/ext/mcp-server/mcp')
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
      ...(headers ?? {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
  })
}

async function readBody(request: Request): Promise<{
  status: number
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}> {
  const response = await handleMcpRequest(request)
  const body = await response.json()
  return { status: response.status, result: body.result, error: body.error }
}

describe('MCP spec revision 2026-07-28', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mocks.serviceClient = {}
  })

  describe('server/discover', () => {
    it('advertises supported versions, capabilities, identity, and freshness', async () => {
      const { result } = await readBody(mcpRequest('server/discover'))
      expect(result?.resultType).toBe('complete')
      expect(result?.supportedVersions).toEqual([
        '2026-07-28',
        '2025-06-18',
        '2025-03-26',
        '2024-11-05',
      ])
      const capabilities = result?.capabilities as Record<string, unknown>
      expect(capabilities.tools).toEqual({ listChanged: false })
      expect(capabilities.extensions).toMatchObject({ 'io.modelcontextprotocol/ui': {} })
      expect(typeof result?.ttlMs).toBe('number')
      expect(result?.cacheScope).toBe('private')
      const meta = result?._meta as Record<string, Record<string, unknown>>
      expect(meta['io.modelcontextprotocol/serverInfo'].name).toBe('gnubok')
      expect(result?.instructions).toContain('gnubok_search_tools')
    })
  })

  describe('per-request _meta version negotiation', () => {
    it('rejects an unsupported protocol version with UnsupportedProtocolVersionError', async () => {
      const { status, error } = await readBody(
        mcpRequest('tools/list', {
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2031-01-01' },
        })
      )
      expect(status).toBe(400)
      expect(error?.code).toBe(-32022)
      expect((error?.data as { supported: string[] }).supported).toContain('2026-07-28')
    })

    it('decorates results for stateless clients: resultType, serverInfo, freshness', async () => {
      const { result } = await readBody(mcpRequest('tools/list', { _meta: STATELESS_META }))
      expect(result?.resultType).toBe('complete')
      // 5 min, not 1 h: the catalog and widgets change with every deploy and a
      // long client cache made freshly shipped tools flap in and out (E2E #7/#8).
      expect(result?.ttlMs).toBe(300_000)
      expect(result?.cacheScope).toBe('private')
      const meta = result?._meta as Record<string, Record<string, unknown>>
      expect(meta['io.modelcontextprotocol/serverInfo'].name).toBe('gnubok')
      expect((result?.tools as unknown[]).length).toBeGreaterThan(0)
    })

    it('keeps handshake-era responses byte-identical (no new fields)', async () => {
      const { result } = await readBody(mcpRequest('tools/list'))
      expect(result?.resultType).toBeUndefined()
      expect(result?.ttlMs).toBeUndefined()
      expect(result?.cacheScope).toBeUndefined()
      expect(result?._meta).toBeUndefined()
    })

    it('returns deterministic tools/list ordering across calls', async () => {
      const first = await readBody(mcpRequest('tools/list'))
      const second = await readBody(mcpRequest('tools/list'))
      const names = (r: typeof first) => (r.result?.tools as Array<{ name: string }>).map((t) => t.name)
      expect(names(first)).toEqual(names(second))
    })
  })

  describe('standard request headers', () => {
    it('rejects an Mcp-Method header that disagrees with the body', async () => {
      const { status, error } = await readBody(
        mcpRequest('tools/list', undefined, { 'Mcp-Method': 'tools/call' })
      )
      expect(status).toBe(400)
      expect(error?.code).toBe(-32020)
    })

    it('accepts a matching Mcp-Method and Mcp-Name pair', async () => {
      const { result } = await readBody(
        mcpRequest(
          'tools/call',
          {
            name: 'gnubok_search_tools',
            arguments: { query: 'list companies', detail: 'name', limit: 5 },
          },
          { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'gnubok_search_tools' }
        )
      )
      expect(result?.structuredContent).toBeDefined()
    })

    it('rejects an Mcp-Name header that disagrees with params.name', async () => {
      const { status, error } = await readBody(
        mcpRequest(
          'tools/call',
          {
            name: 'gnubok_search_tools',
            arguments: { query: 'x', detail: 'name', limit: 5 },
          },
          { 'Mcp-Name': 'gnubok_create_invoice' }
        )
      )
      expect(status).toBe(400)
      expect(error?.code).toBe(-32020)
    })

    it('accepts requests without the standard headers (handshake-era clients)', async () => {
      const { result } = await readBody(mcpRequest('tools/list'))
      expect((result?.tools as unknown[]).length).toBeGreaterThan(0)
    })

    it('validates Mcp-Name against params.uri on resources/read', async () => {
      const mismatch = await readBody(
        mcpRequest(
          'resources/read',
          { uri: 'ui://receipt-matcher/app.html' },
          { 'Mcp-Name': 'ui://vat-review/app.html' }
        )
      )
      expect(mismatch.status).toBe(400)
      expect(mismatch.error?.code).toBe(-32020)

      const match = await readBody(
        mcpRequest(
          'resources/read',
          { uri: 'ui://receipt-matcher/app.html' },
          { 'Mcp-Name': 'ui://receipt-matcher/app.html' }
        )
      )
      expect(match.error).toBeUndefined()
      expect(match.result?.contents).toBeDefined()
    })

    it('decodes the base64 sentinel form of Mcp-Name before comparing', async () => {
      const encoded = `=?base64?${Buffer.from('gnubok_search_tools', 'utf8').toString('base64')}?=`
      const { result } = await readBody(
        mcpRequest(
          'tools/call',
          {
            name: 'gnubok_search_tools',
            arguments: { query: 'list companies', detail: 'name', limit: 5 },
          },
          { 'Mcp-Name': encoded }
        )
      )
      expect(result?.structuredContent).toBeDefined()
    })

    it('rejects an MCP-Protocol-Version header that disagrees with _meta', async () => {
      const { status, error } = await readBody(
        mcpRequest(
          'tools/list',
          { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
          { 'MCP-Protocol-Version': '2025-06-18' }
        )
      )
      expect(status).toBe(400)
      expect(error?.code).toBe(-32020)
    })
  })

  describe('stateless tool results', () => {
    it('carries resultType on successful tools/call results', async () => {
      const { result } = await readBody(
        mcpRequest('tools/call', {
          name: 'gnubok_search_tools',
          arguments: { query: 'list companies', detail: 'name', limit: 5 },
          _meta: STATELESS_META,
        })
      )
      expect(result?.resultType).toBe('complete')
      const meta = result?._meta as Record<string, Record<string, unknown>>
      expect(meta['io.modelcontextprotocol/serverInfo'].name).toBe('gnubok')
    })

    it('carries resultType on isError tool results too', async () => {
      // The empty supabase mock makes any company-dependent tool fail during
      // execution, which produces an isError TOOL RESULT (not a JSON-RPC
      // error): exactly the shape that must also carry resultType.
      const { result } = await readBody(
        mcpRequest('tools/call', {
          name: 'gnubok_get_trial_balance',
          arguments: {},
          _meta: STATELESS_META,
        })
      )
      expect(result?.isError).toBe(true)
      expect(result?.resultType).toBe('complete')
    })

    it('keeps unknown tools on the standard invalid-params JSON-RPC error', async () => {
      const { error } = await readBody(
        mcpRequest('tools/call', {
          name: 'gnubok_nonexistent_tool_xyz',
          arguments: {},
          _meta: STATELESS_META,
        })
      )
      expect(error?.code).toBe(-32602)
    })

    it('adds freshness hints to resources/list for stateless clients', async () => {
      mocks.serviceClient = emptyRegistryClient()
      const { result } = await readBody(mcpRequest('resources/list', { _meta: STATELESS_META }))
      expect(result?.resultType).toBe('complete')
      expect(result?.ttlMs).toBe(300_000)
      expect(result?.cacheScope).toBe('private')
    })

    it('adds freshness hints to prompts/list for stateless clients', async () => {
      const { result } = await readBody(mcpRequest('prompts/list', { _meta: STATELESS_META }))
      expect(result?.resultType).toBe('complete')
      // 5 min, not 1 h: the catalog and widgets change with every deploy and a
      // long client cache made freshly shipped tools flap in and out (E2E #7/#8).
      expect(result?.ttlMs).toBe(300_000)
    })

    it('keeps resource-not-found on -32602 (invalid params)', async () => {
      const { error } = await readBody(
        mcpRequest('resources/read', {
          uri: 'ui://does-not-exist/app.html',
          _meta: STATELESS_META,
        })
      )
      expect(error?.code).toBe(-32602)
    })
  })

  describe('legacy handshake unchanged', () => {
    it('still negotiates initialize for handshake-era versions', async () => {
      const { result } = await readBody(
        mcpRequest('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        })
      )
      expect(result?.protocolVersion).toBe('2025-06-18')
      expect((result?.serverInfo as Record<string, unknown>).name).toBe('gnubok')
      const capabilities = result?.capabilities as Record<string, unknown>
      expect(capabilities.extensions).toMatchObject({ 'io.modelcontextprotocol/ui': {} })
    })

    it('negotiates an initialize requesting 2026-07-28 down to the handshake default', async () => {
      const { result } = await readBody(
        mcpRequest('initialize', {
          protocolVersion: '2026-07-28',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        })
      )
      expect(result?.protocolVersion).toBe('2025-06-18')
    })
  })
})
