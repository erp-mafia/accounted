/**
 * Tests for the pending-operations approval-queue widget: registration,
 * resource serving, tool wiring, and namespace projection. Does NOT re-test
 * approve/reject semantics (covered by pending-operations-tools tests);
 * only the widget plumbing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools } from '../server'
import { uiWidgets, findUiWidget } from '../widgets'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['pending_operations:read'],
    }),
    // Fully-chainable, awaitable proxy resolving to empty data: satisfies
    // both loadAtomsAsSkills and the pending_operations list query without
    // hand-enumerating each chain.
    createServiceClientNoCookies: vi.fn(() => {
      const makeChain = (): unknown =>
        new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === 'then') {
                return (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 })
              }
              return () => makeChain()
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
        from: (table: string) => (table === 'company_members' ? membershipChain : makeChain()),
      }
    }),
  }
})

import { handleMcpRequest } from '../server'

function mcpRequest(method: string, params?: Record<string, unknown>, namespace?: 'accounted'): Request {
  const url = new URL('http://localhost:3000/api/extensions/ext/mcp-server/mcp')
  if (namespace) url.searchParams.set('tool_namespace', namespace)
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

async function parseResult(response: Response) {
  const json = await response.json()
  return json.result
}

describe('Pending operations widget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('widget registration', () => {
    it('registers the pending-operations widget in uiWidgets', () => {
      const widget = findUiWidget('ui://pending-operations/app.html')
      expect(widget).toBeDefined()
      expect(widget?.name).toBe('Pending Operations')
      expect(widget?.html).toContain('<!DOCTYPE html>')
      expect(widget?.html).toContain('Att godkänna')
    })

    it('uiWidgets contains all three widgets', () => {
      const uris = uiWidgets.map((w) => w.uri)
      expect(uris).toContain('ui://receipt-matcher/app.html')
      expect(uris).toContain('ui://vat-review/app.html')
      expect(uris).toContain('ui://pending-operations/app.html')
    })

    it('times out stranded RPCs so a silent host cannot freeze a row', () => {
      const widget = findUiWidget('ui://pending-operations/app.html')!
      expect(widget.html).toContain('RPC_TIMEOUT_MS')
      expect(widget.html).toContain('clearTimeout(timer)')
    })

    it('the widget calls the approve and reject tools and arms confirmed=true for high risk', () => {
      const widget = findUiWidget('ui://pending-operations/app.html')!
      expect(widget.html).toContain('gnubok_approve_pending_operation')
      expect(widget.html).toContain('gnubok_reject_pending_operation')
      // High-risk approvals send confirmed=true only from the armed second
      // click: the human acknowledgment, never a default.
      expect(widget.html).toContain('args.confirmed = true')
      expect(widget.html).toContain("risk_level === 'high'")
    })
  })

  describe('gnubok_list_pending_operations wiring', () => {
    it('declares render_ui and points at the pending-operations widget', () => {
      const tool = tools.find((t) => t.name === 'gnubok_list_pending_operations')!
      expect((tool as { uiResourceUri?: string }).uiResourceUri).toBe(
        'ui://pending-operations/app.html'
      )
      const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties
      expect(props.render_ui).toMatchObject({ type: 'boolean' })
      expect(tool.annotations.readOnlyHint).toBe(true)
    })

    it('emits result-level _meta only when render_ui=true', async () => {
      const withUi = await (
        await handleMcpRequest(
          mcpRequest('tools/call', {
            name: 'gnubok_list_pending_operations',
            arguments: { render_ui: true },
          }),
        )
      ).json()
      expect(withUi.result.isError).toBeUndefined()
      expect(withUi.result._meta).toEqual({
        ui: { resourceUri: 'ui://pending-operations/app.html' },
      })

      const withoutUi = await (
        await handleMcpRequest(
          mcpRequest('tools/call', {
            name: 'gnubok_list_pending_operations',
            arguments: {},
          }),
        )
      ).json()
      expect(withoutUi.result.isError).toBeUndefined()
      expect(withoutUi.result._meta).toBeUndefined()
    })
  })

  describe('protocol: resources/list + resources/read', () => {
    it('lists the widget with the MCP Apps mime type', async () => {
      const res = await handleMcpRequest(mcpRequest('resources/list'))
      const result = await parseResult(res)
      const widget = result.resources.find(
        (r: { uri: string }) => r.uri === 'ui://pending-operations/app.html'
      )
      expect(widget).toMatchObject({
        uri: 'ui://pending-operations/app.html',
        name: 'Pending Operations',
        mimeType: 'text/html;profile=mcp-app',
      })
    })

    it('returns the widget HTML on resources/read', async () => {
      const res = await handleMcpRequest(
        mcpRequest('resources/read', { uri: 'ui://pending-operations/app.html' })
      )
      const result = await parseResult(res)
      expect(result.contents).toHaveLength(1)
      expect(result.contents[0].mimeType).toBe('text/html;profile=mcp-app')
      expect(result.contents[0].text).toContain('Att godkänna')
    })

    it('projects the tool names inside the widget HTML for the accounted namespace', async () => {
      const res = await handleMcpRequest(
        mcpRequest('resources/read', { uri: 'ui://pending-operations/app.html' }, 'accounted')
      )
      const result = await parseResult(res)
      const html = result.contents[0].text as string
      expect(html).toContain('accounted_approve_pending_operation')
      expect(html).toContain('accounted_reject_pending_operation')
      expect(html).not.toContain('gnubok_approve_pending_operation')
    })
  })
})
