/**
 * Tests for the VAT review widget: registration, resource serving,
 * and tool _meta wiring. Does NOT re-test the underlying VAT computation
 * (covered by existing get_vat_report tests); only the widget plumbing.
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
      companyId: 'company-1',
      scopes: ['reports:read'],
    }),
    // Fully-chainable, awaitable proxy resolving to empty data: satisfies both
    // loadAtomsAsSkills (select→eq→eq→order) and computeVatReport (select→eq→in→
    // gte→lte→…) without hand-enumerating each chain.
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

function mcpRequest(method: string, params?: Record<string, unknown>, id: number | string = 1): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
}

async function parseResult(response: Response) {
  const json = await response.json()
  return json.result
}

describe('VAT review widget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('widget registration', () => {
    it('registers the vat-review widget in uiWidgets', () => {
      const widget = findUiWidget('ui://vat-review/app.html')
      expect(widget).toBeDefined()
      expect(widget?.name).toBe('VAT Review')
      expect(widget?.html).toContain('<!DOCTYPE html>')
      expect(widget?.html).toContain('Momsdeklaration')
    })

    it('uiWidgets contains both receipt-matcher and vat-review', () => {
      const uris = uiWidgets.map((w) => w.uri)
      expect(uris).toContain('ui://receipt-matcher/app.html')
      expect(uris).toContain('ui://vat-review/app.html')
    })
  })

  describe('gnubok_vat_review_widget tool', () => {
    it('is registered with _meta.ui pointing to the vat-review widget', () => {
      const tool = tools.find((t) => t.name === 'gnubok_vat_review_widget')
      expect(tool).toBeDefined()
      expect(tool?._meta).toEqual({ ui: { resourceUri: 'ui://vat-review/app.html' } })
      expect(tool?.annotations.readOnlyHint).toBe(true)
    })

    it('declares the same required inputs as gnubok_get_vat_report', () => {
      const widgetTool = tools.find((t) => t.name === 'gnubok_vat_review_widget')
      const reportTool = tools.find((t) => t.name === 'gnubok_get_vat_report')
      const widgetRequired = (widgetTool?.inputSchema as { required?: string[] }).required ?? []
      const reportRequired = (reportTool?.inputSchema as { required?: string[] }).required ?? []
      expect(widgetRequired.sort()).toEqual(reportRequired.sort())
    })
  })

  describe('protocol: resources/list', () => {
    it('lists the vat-review widget alongside the receipt-matcher widget', async () => {
      const res = await handleMcpRequest(mcpRequest('resources/list'))
      const result = await parseResult(res)

      const widget = result.resources.find(
        (r: { uri: string }) => r.uri === 'ui://vat-review/app.html'
      )
      expect(widget).toEqual({
        uri: 'ui://vat-review/app.html',
        name: 'VAT Review',
        description: 'Interactive review of momsdeklaration (SKV 4700) before filing',
        mimeType: 'text/html;profile=mcp-app',
      })

      const uris = result.resources.map((r: { uri: string }) => r.uri)
      expect(uris).toContain('ui://receipt-matcher/app.html')
      expect(uris).toContain('ui://vat-review/app.html')
    })
  })

  describe('protocol: resources/read', () => {
    it('returns HTML for the vat-review widget', async () => {
      const res = await handleMcpRequest(
        mcpRequest('resources/read', { uri: 'ui://vat-review/app.html' })
      )
      const result = await parseResult(res)

      expect(result.contents).toHaveLength(1)
      expect(result.contents[0].uri).toBe('ui://vat-review/app.html')
      expect(result.contents[0].mimeType).toBe('text/html;profile=mcp-app')
      expect(result.contents[0].text).toContain('Momsdeklaration')
      expect(result.contents[0].text).toContain('ruta49')
    })
  })

  describe('protocol: tools/list', () => {
    it('includes gnubok_vat_review_widget with _meta when the API key has reports:read scope', async () => {
      const res = await handleMcpRequest(mcpRequest('tools/list'))
      const result = await parseResult(res)

      const widgetTool = result.tools.find(
        (t: { name: string }) => t.name === 'gnubok_vat_review_widget'
      )
      expect(widgetTool).toBeDefined()
      expect(widgetTool._meta).toEqual({ ui: { resourceUri: 'ui://vat-review/app.html' } })
    })
  })

  describe('gnubok_get_vat_report: render_ui merge', () => {
    it('declares render_ui and points at the vat-review widget', () => {
      const tool = tools.find((t) => t.name === 'gnubok_get_vat_report')!
      expect((tool as { uiResourceUri?: string }).uiResourceUri).toBe('ui://vat-review/app.html')
      const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties
      expect(props.render_ui).toMatchObject({ type: 'boolean' })
    })

    it('emits result-level _meta only when render_ui=true', async () => {
      const withUi = await (
        await handleMcpRequest(
          mcpRequest('tools/call', {
            name: 'gnubok_get_vat_report',
            arguments: { period_type: 'monthly', year: 2026, period: 3, render_ui: true },
          }),
        )
      ).json()
      expect(withUi.result.isError).toBeUndefined()
      expect(withUi.result._meta).toEqual({ ui: { resourceUri: 'ui://vat-review/app.html' } })

      const withoutUi = await (
        await handleMcpRequest(
          mcpRequest('tools/call', {
            name: 'gnubok_get_vat_report',
            arguments: { period_type: 'monthly', year: 2026, period: 3 },
          }),
        )
      ).json()
      expect(withoutUi.result.isError).toBeUndefined()
      expect(withoutUi.result._meta).toBeUndefined()
    })
  })
})
