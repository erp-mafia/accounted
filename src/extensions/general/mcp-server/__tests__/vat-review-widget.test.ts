/**
 * Tests for the VAT review widget: registration, resource serving,
 * and tool _meta wiring. Does NOT re-test the underlying VAT computation
 * (covered by existing get_vat_report tests); only the widget plumbing.
 */
import vm from 'node:vm'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools } from '../server'
import { uiWidgets, findUiWidget } from '../widgets'

const { mockPeriodReadRpc } = vi.hoisted(() => ({ mockPeriodReadRpc: vi.fn() }))

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
        rpc: mockPeriodReadRpc,
      }
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

/**
 * Runs the widget's own script against a stub page, hands it one tool result
 * and returns what it drew, with every kind of space read as a plain one.
 */
function drawWidget(report: Record<string, unknown>): string {
  const html = findUiWidget('ui://vat-review/app.html')!.html
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]
  const elements = new Map<string, { innerHTML: string; textContent: string }>()
  const element = (id: string) => {
    if (!elements.has(id)) {
      elements.set(id, {
        innerHTML: '',
        textContent: '',
        addEventListener() {},
        classList: { add() {}, remove() {} },
      } as never)
    }
    return elements.get(id)!
  }
  let onMessage: ((event: { data: unknown }) => void) | undefined
  const document = {
    getElementById: element,
    // esc() writes text into a detached element and reads its markup back.
    createElement: () => {
      let text = ''
      return {
        set textContent(value: string) {
          text = String(value)
        },
        get innerHTML() {
          return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        },
      }
    },
    documentElement: { classList: { add() {}, remove() {} } },
  }
  const window = {
    parent: { postMessage() {} },
    addEventListener: (_type: string, handler: (event: { data: unknown }) => void) => {
      onMessage = handler
    },
  }
  vm.runInNewContext(script, { window, document, navigator: {}, setTimeout })
  onMessage!({
    data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: report } },
  })
  return element('content').innerHTML.replace(/[\u00a0\u202f]/g, ' ')
}

describe('VAT review widget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPeriodReadRpc.mockImplementation(async (name: string) => ({
      data: name === 'acquire_sie_period_read' ? 'report-read-token' : null,
      error: null,
    }))
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

  describe('the amount it states', () => {
    // crm#1171's period: the öre sum is -6 140,10, filed it is -6 141. The
    // app, the momsverifikat and the payment say 6 141; the widget said
    // 6 140,10 from rutor.ruta49.
    const report = {
      period_label: 'Q3 2026',
      rutor: { ruta10: 1153.86, ruta30: 4127.38, ruta48: 11421.34, ruta49: -6140.1 },
      net_filed: -6141,
      warnings: [],
    }

    it('is the net as filed, in the headline and on row 49', () => {
      const drawn = drawWidget(report)
      expect(drawn).toContain('<div class="summary-label">Moms att få tillbaka</div>')
      expect(drawn).toContain('<div class="summary-amount refund">6 141,00 kr</div>')
      expect(drawn).toMatch(/<td class="ruta-code">49<\/td>.*?<td class="amount">[-−]6 141,00 kr<\/td>/)
    })

    it('prints the öre sum only as the note that explains the difference', () => {
      const drawn = drawWidget(report)
      expect(drawn.split('6 140,10 kr')).toHaveLength(2)
      expect(drawn).toContain('<p class="ore-note">')
      expect(drawn).toContain('Exakt i ören: 6 140,10 kr.')
    })

    it('states the öre sum for a result stored before net_filed existed, never zero', () => {
      const { net_filed: _netFiled, ...stored } = report
      const drawn = drawWidget(stored)
      expect(drawn).toContain('<div class="summary-label">Moms att få tillbaka</div>')
      expect(drawn).toContain('<div class="summary-amount refund">6 140,10 kr</div>')
      expect(drawn).not.toContain('ore-note')
    })

    it('leaves the note out when nothing was dropped', () => {
      const drawn = drawWidget({ ...report, rutor: { ...report.rutor, ruta49: -6141 } })
      expect(drawn).not.toContain('ore-note')
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
      // _meta also carries the company echo on every company-scoped call;
      // the UI directive is what this test pins.
      expect(withUi.result._meta).toMatchObject({ ui: { resourceUri: 'ui://vat-review/app.html' } })

      const withoutUi = await (
        await handleMcpRequest(
          mcpRequest('tools/call', {
            name: 'gnubok_get_vat_report',
            arguments: { period_type: 'monthly', year: 2026, period: 3 },
          }),
        )
      ).json()
      expect(withoutUi.result.isError).toBeUndefined()
      expect(withoutUi.result._meta?.ui).toBeUndefined()
    })

    it('refuses an external VAT report while the database holds an unfinished import', async () => {
      mockPeriodReadRpc.mockResolvedValueOnce({
        data: null,
        error: { code: '55000', message: 'Importen pågår eller är oavslutad.' },
      })
      const result = await parseResult(await handleMcpRequest(mcpRequest('tools/call', {
        name: 'gnubok_get_vat_report',
        arguments: { period_type: 'monthly', year: 2026, period: 3, render_ui: true },
      })))
      expect(result.isError).toBe(true)
      expect(result._meta).toBeUndefined()
      expect(mockPeriodReadRpc).toHaveBeenCalledWith('acquire_sie_period_read', {
        p_company_id: '11111111-1111-4111-8111-111111111111', p_purpose: 'report_export',
      })
      expect(mockPeriodReadRpc).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(result)).toContain('CONFLICT')
    })
  })
})
