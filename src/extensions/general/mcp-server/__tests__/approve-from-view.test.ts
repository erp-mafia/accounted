/**
 * The approval view's own door (view-approval.ts): a person's click on
 * Godkänn in the approval widget is recorded as the person's approval, an
 * approve call the AI makes is recorded as the AI's, and nothing the AI can
 * reach lets it pass for the person. Customer request 2026-11-05.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const KEY = 'key-1'
const OP = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'

const commitSpy = vi.fn()
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => commitSpy(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  const { createTableMockSupabase } = await import('@/tests/helpers')
  const company = '11111111-1111-4111-8111-111111111111'
  const pendingRows = [
    { id: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', company_id: company, operation_type: 'categorize_transaction', status: 'pending', risk_level: 'low', user_id: null },
  ]
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(
      () =>
        createTableMockSupabase({
          company_members: { data: { company_id: company, role: 'owner' }, error: null },
          pending_operations: { data: pendingRows, error: null, count: pendingRows.length },
        }).supabase,
    ),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { handleMcpRequest, tools, type ActorContext } from '../server'
import { validateApiKey } from '@/lib/auth/api-keys'
import { VIEW_APPROVAL_META_KEY, checkViewApprovalToken, mintViewApprovalToken } from '../view-approval'
import { findUiWidget } from '../widgets'

const viewTool = tools.find((t) => t.name === 'gnubok_approve_from_view')!
const approveTool = tools.find((t) => t.name === 'gnubok_approve_pending_operation')!

/** The connection Claude's sign-in mints: provider claude, approve ticked. */
const claudeKey = {
  userId: 'user-1',
  companyId: COMPANY,
  scopes: ['pending_operations:read', 'pending_operations:approve'],
  apiKeyId: KEY,
  apiKeyName: 'MCP-klient (OAuth)',
  client: 'claude',
  mode: 'live',
}

const claudeActor: ActorContext = { type: 'api_key', id: KEY, label: 'Claude (Anthropic)', oauthKey: true, oauthProvider: 'claude', approvalView: true }

/** What a 2026-07-28 client lists on every request: with MCP Apps, or without (Claude Code). */
const WITH_APPS = { 'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } }
const WITHOUT_APPS = { 'io.modelcontextprotocol/clientCapabilities': { extensions: {} } }

function mcp(method: string, params?: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

async function listedTools(meta?: Record<string, unknown>): Promise<Array<{ name: string; _meta?: Record<string, unknown> }>> {
  const res = await (await handleMcpRequest(mcp('tools/list', meta ? { _meta: meta } : undefined))).json()
  return res.result.tools
}

function pendingOp(overrides: Record<string, unknown> = {}) {
  return { id: OP, operation_type: 'categorize_transaction', company_id: COMPANY, status: 'pending', risk_level: 'low', params: {}, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-secret')
  vi.mocked(validateApiKey).mockResolvedValue(claudeKey as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the AI approving: recorded as the AI', () => {
  it('gnubok_approve_pending_operation names its door mcp_chat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: pendingOp(), error: null })
    commitSpy.mockResolvedValue({ status: 'committed' })
    await approveTool.execute({ operation_id: OP }, COMPANY, 'user-1', supabase as never, claudeActor)
    expect(commitSpy.mock.calls[0][4]).toMatchObject({ commitMethod: 'api_key', approvalDoor: 'mcp_chat' })
  })
})

describe('gnubok_approve_from_view', () => {
  it('commits a click carrying its view token, through the same approval, recorded as mcp_view', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: pendingOp(), error: null })
    commitSpy.mockResolvedValue({ status: 'committed', data: { journal_entry_id: 'je-1' } })
    const token = mintViewApprovalToken({ apiKeyId: KEY, operationId: OP })
    const result = await viewTool.execute({ operation_id: OP, view_token: token }, COMPANY, 'user-1', supabase as never, claudeActor)
    expect(result).toMatchObject({ status: 'committed', operation_id: OP })
    expect(commitSpy).toHaveBeenCalledTimes(1)
    expect(commitSpy.mock.calls[0][4]).toMatchObject({
      commitMethod: 'api_key',
      approvalDoor: 'mcp_view',
      actor: { type: 'mcp_oauth', label: 'Claude (Anthropic)' },
    })
  })

  it('keeps every gate of an approval: a high-risk click needs the armed confirmation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: pendingOp({ risk_level: 'high', operation_type: 'create_voucher' }), error: null })
    const token = mintViewApprovalToken({ apiKeyId: KEY, operationId: OP })
    await expect(
      viewTool.execute({ operation_id: OP, view_token: token }, COMPANY, 'user-1', supabase as never, claudeActor),
    ).rejects.toThrow(/confirmed=true/)
    expect(commitSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['no token', {}],
    ['a malformed token', { view_token: 'va1.nope' }],
    ['a token for another operation', { view_token: 'other' }],
    ['a token for another key', { view_token: 'other-key' }],
  ])('refuses %s and commits nothing', async (_label, extra) => {
    const { supabase } = createQueuedMockSupabase()
    const args: Record<string, unknown> = { operation_id: OP, ...extra }
    if (args.view_token === 'other') args.view_token = mintViewApprovalToken({ apiKeyId: KEY, operationId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b' })
    if (args.view_token === 'other-key') args.view_token = mintViewApprovalToken({ apiKeyId: 'key-2', operationId: OP })
    await expect(viewTool.execute(args, COMPANY, 'user-1', supabase as never, claudeActor)).rejects.toMatchObject({
      code: 'VIEW_APPROVAL_UNAVAILABLE',
    })
    expect(commitSpy).not.toHaveBeenCalled()
  })

  it('refuses a connection without the view, even with a valid token', async () => {
    const { supabase } = createQueuedMockSupabase()
    const token = mintViewApprovalToken({ apiKeyId: KEY, operationId: OP })
    for (const actor of [
      { ...claudeActor, oauthProvider: 'chatgpt', approvalView: false },
      { ...claudeActor, approvalView: false },
      { ...claudeActor, approvalView: undefined },
      { type: 'user' } as ActorContext,
    ]) {
      await expect(
        viewTool.execute({ operation_id: OP, view_token: token }, COMPANY, 'user-1', supabase as never, actor),
      ).rejects.toMatchObject({ code: 'VIEW_APPROVAL_UNAVAILABLE' })
    }
    expect(commitSpy).not.toHaveBeenCalled()
  })
})

describe('what the AI can reach', () => {
  it('lists the door app-only, to a Claude connection that may approve, and to nothing else', async () => {
    const door = (await listedTools()).find((t) => t.name === 'gnubok_approve_from_view')
    expect(door?._meta).toEqual({ ui: { visibility: ['app'] } })

    vi.mocked(validateApiKey).mockResolvedValue({ ...claudeKey, client: 'chatgpt' } as never)
    expect((await listedTools()).some((t) => t.name === 'gnubok_approve_from_view')).toBe(false)

    vi.mocked(validateApiKey).mockResolvedValue({ ...claudeKey, client: undefined, apiKeyName: 'Live Key' } as never)
    expect((await listedTools()).some((t) => t.name === 'gnubok_approve_from_view')).toBe(false)

    vi.mocked(validateApiKey).mockResolvedValue({ ...claudeKey, scopes: ['pending_operations:read'] } as never)
    expect((await listedTools()).some((t) => t.name === 'gnubok_approve_from_view')).toBe(false)
  })

  it('leaves the door out for a client that lists its capabilities without MCP Apps, and in for one with them', async () => {
    expect((await listedTools(WITHOUT_APPS)).some((t) => t.name === 'gnubok_approve_from_view')).toBe(false)
    expect((await listedTools(WITH_APPS)).some((t) => t.name === 'gnubok_approve_from_view')).toBe(true)
  })

  it('hands no tokens to a client that lists its capabilities without MCP Apps', async () => {
    const res = await (
      await handleMcpRequest(mcp('tools/call', { name: 'gnubok_list_pending_operations', arguments: { render_ui: true }, _meta: WITHOUT_APPS }))
    ).json()
    expect(res.result.isError).toBeUndefined()
    expect(res.result._meta?.[VIEW_APPROVAL_META_KEY]).toBeUndefined()
  })

  it('refuses the door to such a client even with a valid token, and commits nothing', async () => {
    const token = mintViewApprovalToken({ apiKeyId: KEY, operationId: OP })
    const res = await (
      await handleMcpRequest(
        mcp('tools/call', { name: 'gnubok_approve_from_view', arguments: { operation_id: OP, view_token: token }, _meta: WITHOUT_APPS }),
      )
    ).json()
    expect(res.result.isError).toBe(true)
    expect(JSON.stringify(res.result.structuredContent ?? res.result.content)).toContain('VIEW_APPROVAL_UNAVAILABLE')
    expect(commitSpy).not.toHaveBeenCalled()
  })

  it('never returns the door from search', async () => {
    const res = await (
      await handleMcpRequest(mcp('tools/call', { name: 'gnubok_search_tools', arguments: { query: 'approve view', detail: 'name', limit: 50 } }))
    ).json()
    expect(JSON.stringify(res.result)).not.toContain('gnubok_approve_from_view')
  })

  it('no bridge or cross-company runner carries it, or advises calling it: to them it does not exist', async () => {
    for (const bridge of ['gnubok_call_tool', 'gnubok_stage_tool']) {
      const res = await (
        await handleMcpRequest(
          mcp('tools/call', { name: bridge, arguments: { tool: 'gnubok_approve_from_view', arguments: { operation_id: OP, view_token: 'x' } } }),
        )
      ).json()
      const text = JSON.stringify(res)
      expect(text).toContain('Unknown tool')
      expect(text).not.toContain('directly')
    }
    // The runners need companies:read before they look at the tool they name.
    vi.mocked(validateApiKey).mockResolvedValue({ ...claudeKey, scopes: [...claudeKey.scopes, 'companies:read'] } as never)
    for (const runner of ['gnubok_run_across_companies', 'gnubok_stage_across_companies']) {
      const res = await (
        await handleMcpRequest(mcp('tools/call', { name: runner, arguments: { tool: 'gnubok_approve_from_view', arguments: {} } }))
      ).json()
      expect(JSON.stringify(res)).toContain('Unknown tool')
    }
    expect(commitSpy).not.toHaveBeenCalled()
  })

  it('leaves it out of the tools an unknown-tool error lists', async () => {
    const res = await (await handleMcpRequest(mcp('tools/call', { name: 'gnubok_approve_from_vieww', arguments: {} }))).json()
    const text = JSON.stringify(res)
    expect(text).toContain('Unknown tool')
    expect(text).toContain('gnubok_approve_pending_operation')
    expect(text).not.toContain('gnubok_approve_from_view"')
    expect(text).not.toMatch(/gnubok_approve_from_view[,\s]/)
  })

  it("puts the view's tokens in the rendered result's _meta only, never where the model reads", async () => {
    const res = await (
      await handleMcpRequest(mcp('tools/call', { name: 'gnubok_list_pending_operations', arguments: { render_ui: true } }))
    ).json()
    expect(res.result.isError).toBeUndefined()
    const tokens = res.result._meta[VIEW_APPROVAL_META_KEY].tokens as Record<string, string>
    expect(Object.keys(tokens)).toEqual([OP])
    expect(checkViewApprovalToken(tokens[OP], { apiKeyId: KEY, operationId: OP })).toEqual({ ok: true })
    expect(JSON.stringify(res.result.content)).not.toContain(tokens[OP])
    expect(JSON.stringify(res.result.structuredContent)).not.toContain(tokens[OP])
  })

  it('hands out no tokens without render_ui, or to a connection without the view', async () => {
    const plain = await (await handleMcpRequest(mcp('tools/call', { name: 'gnubok_list_pending_operations', arguments: {} }))).json()
    expect(plain.result._meta?.[VIEW_APPROVAL_META_KEY]).toBeUndefined()

    vi.mocked(validateApiKey).mockResolvedValue({ ...claudeKey, client: 'chatgpt' } as never)
    const other = await (
      await handleMcpRequest(mcp('tools/call', { name: 'gnubok_list_pending_operations', arguments: { render_ui: true } }))
    ).json()
    expect(other.result._meta?.ui).toBeDefined()
    expect(other.result._meta?.[VIEW_APPROVAL_META_KEY]).toBeUndefined()
  })

  it("tells the AI that its own approvals are recorded as its own", async () => {
    const res = await (await handleMcpRequest(mcp('initialize', { protocolVersion: '2025-06-18' }))).json()
    expect(res.result.instructions).toContain('recorded as yours (the AI)')
    expect(res.result.instructions).toContain('open the widget instead of approving')
  })
})

describe('the approval widget', () => {
  const html = findUiWidget('ui://pending-operations/app.html')!.html

  it("reads its tokens from the result's _meta and clicks through its own door", () => {
    expect(html).toContain("msg.params._meta['accounted/approval_view']")
    expect(html).toContain("callTool('gnubok_approve_from_view', viewArgs)")
  })

  it('falls back to the ordinary approve tool only when its door is unavailable', () => {
    expect(html).toContain("if (code !== 'VIEW_APPROVAL_UNAVAILABLE') return res;")
    expect(html).toContain("if (!token) return callTool('gnubok_approve_pending_operation', args);")
  })
})
