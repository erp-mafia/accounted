/**
 * Tests for the connect-card widget: registration, tool wiring (definition
 * level _meta so the card renders on EVERY connect-tool call), resource
 * serving, and the ui/open-link contract. Does NOT re-test the connect tools'
 * status logic (covered by connect-links tests); only the widget plumbing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools } from '../server'
import { findUiWidget } from '../widgets'

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
      scopes: ['companies:read'],
    }),
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
      return { from: () => makeChain() }
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

describe('Connect card widget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('widget registration', () => {
    it('registers the connect-card widget in uiWidgets', () => {
      const widget = findUiWidget('ui://connect-card/app.html')
      expect(widget).toBeDefined()
      expect(widget?.name).toBe('Connect Card')
      expect(widget?.html).toContain('<!DOCTYPE html>')
      expect(widget?.html).toContain('Anslut')
    })

    it('opens the link via ui/open-link on a real click, never an anchor tag', () => {
      const widget = findUiWidget('ui://connect-card/app.html')!
      // The sanctioned new-tab mechanism is a ui/open-link request sent from
      // the click handler (custom connectors always get Claude's confirmation
      // modal, so the URL is also shown in the card for recognition).
      expect(widget.html).toContain("sendRequest('ui/open-link'")
      expect(widget.html).toContain("addEventListener('click'")
      expect(widget.html).not.toContain('target="_blank"')
      expect(widget.html).not.toContain('window.open')
    })

    it('performs the ui/initialize handshake (claude.ai keeps the iframe hidden without it)', () => {
      const widget = findUiWidget('ui://connect-card/app.html')!
      expect(widget.html).toContain("sendRequest('ui/initialize'")
      expect(widget.html).toContain("sendNotification('ui/notifications/initialized')")
    })
  })

  describe('connect tool wiring', () => {
    it('both connect tools carry definition-level _meta pointing at the card', () => {
      for (const name of ['gnubok_connect_bank', 'gnubok_connect_skatteverket']) {
        const tool = tools.find((t) => t.name === name)!
        expect(
          (tool as { _meta?: { ui: { resourceUri: string } } })._meta
        ).toEqual({ ui: { resourceUri: 'ui://connect-card/app.html' } })
      }
    })

    it('tools/list surfaces the ui resourceUri on both connect tools', async () => {
      const res = await handleMcpRequest(mcpRequest('tools/list'))
      const result = await parseResult(res)
      for (const name of ['gnubok_connect_bank', 'gnubok_connect_skatteverket']) {
        const tool = result.tools.find((t: { name: string }) => t.name === name)
        expect(tool).toBeDefined()
        expect(tool._meta?.ui).toEqual({ resourceUri: 'ui://connect-card/app.html' })
      }
    })
  })

  describe('protocol: resources/list + resources/read', () => {
    it('lists the widget with the MCP Apps mime type', async () => {
      const res = await handleMcpRequest(mcpRequest('resources/list'))
      const result = await parseResult(res)
      const widget = result.resources.find(
        (r: { uri: string }) => r.uri === 'ui://connect-card/app.html'
      )
      expect(widget).toMatchObject({
        uri: 'ui://connect-card/app.html',
        name: 'Connect Card',
        mimeType: 'text/html;profile=mcp-app',
      })
    })

    it('returns the widget HTML on resources/read', async () => {
      const res = await handleMcpRequest(
        mcpRequest('resources/read', { uri: 'ui://connect-card/app.html' })
      )
      const result = await parseResult(res)
      expect(result.contents).toHaveLength(1)
      expect(result.contents[0].mimeType).toBe('text/html;profile=mcp-app')
      expect(result.contents[0].text).toContain('Anslut din bank')
      expect(result.contents[0].text).toContain('Anslut Skatteverket')
    })
  })
})
