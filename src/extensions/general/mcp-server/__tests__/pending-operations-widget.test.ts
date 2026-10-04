/**
 * Tests for the pending-operations approval-queue widget: registration,
 * resource serving, tool wiring, and namespace projection. Does NOT re-test
 * approve/reject semantics (covered by pending-operations-tools tests);
 * only the widget plumbing.
 */
import vm from 'node:vm'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools } from '../server'
import { uiWidgets, findUiWidget } from '../widgets'
import { PENDING_OPERATIONS_HTML } from '../widgets/pending-operations'

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
import { validateApiKey } from '@/lib/auth/api-keys'

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

/**
 * Runs the widget's inline script against a minimal DOM and returns a
 * function that delivers a list result (the host's tool-result notification)
 * and answers with the rendered table HTML.
 */
function renderWidget(): (structuredContent: Record<string, unknown>) => string {
  const script = PENDING_OPERATIONS_HTML.slice(
    PENDING_OPERATIONS_HTML.indexOf('<script>') + '<script>'.length,
    PENDING_OPERATIONS_HTML.indexOf('</script>'),
  )
  const content = { innerHTML: '' }
  const counter = { textContent: '' }
  let onMessage: ((event: { data: unknown }) => void) | null = null
  const window = {
    addEventListener: (type: string, fn: (event: { data: unknown }) => void) => {
      if (type === 'message') onMessage = fn
    },
    parent: { postMessage: () => {} },
  }
  const document = {
    getElementById: (id: string) => (id === 'content' ? content : id === 'counter' ? counter : null),
    querySelectorAll: () => [],
    createElement: () => {
      let text = ''
      return {
        set textContent(value: string) {
          text = value
        },
        get innerHTML() {
          return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        },
      }
    },
    documentElement: { classList: { add: () => {}, remove: () => {} } },
  }
  vm.runInNewContext(script, { window, document, setTimeout: () => 0, clearTimeout: () => {} })
  return (structuredContent) => {
    expect(onMessage).not.toBeNull()
    onMessage!({ data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent } } })
    return content.innerHTML
  }
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
      // _meta also carries the company echo on every company-scoped call;
      // the UI directive is what this test pins.
      expect(withUi.result._meta).toMatchObject({
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
      expect(withoutUi.result._meta?.ui).toBeUndefined()
    })
  })

  // Issue #3408, founder decision 2026-10-03: approve is never pre-ticked on
  // the consent page, so the default one-click connection cannot approve.
  // Neither the widget nor the instructions may promise it can. Its write
  // scopes still let it reject the proposals it staged itself (second
  // decision of 2026-10-03); a read-only key can do neither.
  describe('a key without pending_operations:approve', () => {
    const withApprove = {
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['pending_operations:read', 'pending_operations:approve'],
    }

    async function instructions(): Promise<string> {
      const res = await handleMcpRequest(mcpRequest('initialize', { protocolVersion: '2025-06-18' }))
      return (await parseResult(res)).instructions as string
    }

    it('the list result tells the widget this key cannot approve', async () => {
      const res = await (
        await handleMcpRequest(
          mcpRequest('tools/call', { name: 'gnubok_list_pending_operations', arguments: { render_ui: true } }),
        )
      ).json()
      expect(res.result.isError).toBeUndefined()
      expect(res.result.structuredContent).toMatchObject({ can_approve: false })

      vi.mocked(validateApiKey).mockResolvedValueOnce(withApprove as never)
      const approver = await (
        await handleMcpRequest(
          mcpRequest('tools/call', { name: 'gnubok_list_pending_operations', arguments: { render_ui: true } }),
        )
      ).json()
      expect(approver.result.structuredContent).toMatchObject({ can_approve: true })
    })

    const op = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      title: `Förslag ${id}`,
      operation_type: 'categorize_transaction',
      risk_level: 'low',
      created_at: '2026-10-03T10:00:00Z',
      ...extra,
    })

    it('the widget swaps Godkänn and Avvisa for a pointer to the app when can_approve is false', () => {
      const html = renderWidget()({ can_approve: false, operations: [op('a'), op('b')] })
      expect(html).not.toContain('data-approve=')
      expect(html).not.toContain('data-reject=')
      expect(html).toContain('I Accounted')
      expect(html).toContain('kan inte godkänna eller avvisa')
      expect(html).toContain('Att göra › Agentförslag')
    })

    // Founder decision 2026-10-03: the key may still withdraw its own proposals.
    it('keeps Avvisa, without Godkänn, on the rows this key may reject', () => {
      const html = renderWidget()({
        can_approve: false,
        operations: [op('own', { can_reject: true }), op('theirs', { can_reject: false })],
      })
      expect(html).toContain('data-reject="0"')
      expect(html).not.toContain('data-reject="1"')
      expect(html).not.toContain('data-approve=')
      expect(html).toContain('Godkänns i Accounted')
      expect(html).toContain('I Accounted')
      expect(html).toContain('Förslag som anslutningen själv har skapat kan du avvisa här')
      expect(html).not.toContain('kan inte godkänna eller avvisa')
    })

    it('a key with approve gets both buttons on every row', () => {
      const html = renderWidget()({
        can_approve: true,
        operations: [op('a', { can_reject: true }), op('b', { can_reject: true })],
      })
      for (const i of [0, 1]) {
        expect(html).toContain(`data-approve="${i}"`)
        expect(html).toContain(`data-reject="${i}"`)
      }
      expect(html).not.toContain('readonly-note')
    })

    it('tools/list shows reject, not approve, to a write key without approve', async () => {
      const listed = async (scopes: string[]) => {
        vi.mocked(validateApiKey).mockResolvedValueOnce({ ...withApprove, scopes } as never)
        const result = await parseResult(await handleMcpRequest(mcpRequest('tools/list')))
        return (result.tools as Array<{ name: string }>).map((t) => t.name)
      }
      const writeKey = await listed(['pending_operations:read', 'transactions:write'])
      expect(writeKey).toContain('gnubok_reject_pending_operation')
      expect(writeKey).not.toContain('gnubok_approve_pending_operation')

      const readKey = await listed(['pending_operations:read'])
      expect(readKey).not.toContain('gnubok_reject_pending_operation')
      expect(readKey).not.toContain('gnubok_approve_pending_operation')

      const approver = await listed(withApprove.scopes)
      expect(approver).toContain('gnubok_reject_pending_operation')
      expect(approver).toContain('gnubok_approve_pending_operation')
    })

    it('approve stays refused for a write key without approve', async () => {
      vi.mocked(validateApiKey).mockResolvedValueOnce({
        ...withApprove,
        scopes: ['pending_operations:read', 'transactions:write'],
      } as never)
      const res = await (
        await handleMcpRequest(
          mcpRequest('tools/call', {
            name: 'gnubok_approve_pending_operation',
            arguments: { operation_id: '0e5f0000-0000-4000-8000-000000000001' },
          }),
        )
      ).json()
      expect(res.result.isError).toBe(true)
      const error = JSON.parse(res.result.content[0].text).error
      expect(error.code).toBe('INSUFFICIENT_SCOPE')
      expect(error.remediation.description).toContain('cannot approve agent proposals')
    })

    it('reject is refused at the scope gate for a key with neither approve nor a write scope', async () => {
      const res = await (
        await handleMcpRequest(
          mcpRequest('tools/call', {
            name: 'gnubok_reject_pending_operation',
            arguments: { operation_id: '0e5f0000-0000-4000-8000-000000000001' },
          }),
        )
      ).json()
      expect(res.result.isError).toBe(true)
      const error = JSON.parse(res.result.content[0].text).error
      expect(error.code).toBe('INSUFFICIENT_SCOPE')
      expect(error.remediation.description).toContain('nor a write scope')
    })

    it('the instructions let a write key withdraw its own proposals, and still send approval to the app', async () => {
      vi.mocked(validateApiKey).mockResolvedValueOnce({
        ...withApprove,
        scopes: ['pending_operations:read', 'transactions:write'],
      } as never)
      const text = await instructions()
      expect(text).toContain('APPROVAL ON THIS CONNECTION')
      expect(text).toContain('you cannot approve agent proposals')
      expect(text).toContain('drop a proposal this connection staged itself, call gnubok_reject_pending_operation')
      expect(text).toContain('not yours to reject')
      expect(text).toContain('Att göra › Agentförslag')
      expect(text).not.toContain('APPROVAL IS A FIRST-CLASS AGENT ACTION')
      expect(text).not.toContain('cannot approve or reject agent proposals')
    })

    it('the instructions send the user to Att göra › Agentförslag instead of promising chat approval', async () => {
      // The mocked key is read-only: it can neither approve nor reject.
      const text = await instructions()
      expect(text).toContain('APPROVAL ON THIS CONNECTION')
      expect(text).toContain('cannot approve or reject agent proposals')
      expect(text).toContain('Att göra › Agentförslag')
      expect(text).toContain('connect again with Godkänn ticked')
      expect(text).not.toContain('APPROVAL IS A FIRST-CLASS AGENT ACTION')
      expect(text).not.toContain('approves/rejects with a click')
      expect(text).not.toContain('gnubok_approve_pending_operation (after user confirms in chat)')
    })

    it('a key with approve keeps the chat-approval instructions', async () => {
      vi.mocked(validateApiKey).mockResolvedValueOnce(withApprove as never)
      const text = await instructions()
      expect(text).toContain('APPROVAL IS A FIRST-CLASS AGENT ACTION')
      expect(text).toContain('approves/rejects with a click')
      expect(text).not.toContain('APPROVAL ON THIS CONNECTION')
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
