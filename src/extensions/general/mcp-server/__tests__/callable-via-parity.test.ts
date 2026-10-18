/**
 * callable_via is read off the caller's own tools/list (agent feedback seq
 * 995216).
 *
 * A ChatGPT connector agent was told gnubok_update_invoice was callable_via
 * "tools_list" while its client had no such tool. Two causes, both covered:
 *
 *   1. Server side, tools/list and callable_via were two copies of one rule:
 *      tools/list filtered inline (catalog tier, single-company mode, scope,
 *      the stage bridge's own gate) while callable_via read only the catalog
 *      tier. Both now go through isListedFor, and this suite runs the REAL
 *      dispatcher for several callers and requires every search hit to say
 *      tools_list exactly when that caller's own tools/list carries it.
 *   2. Client side, some connectors keep the tools/list they fetched when they
 *      were added, so a tool listed later never shows. The server cannot see
 *      that copy; it says what unblocks it where an agent with a stale copy
 *      lands: next to tools_list hits and in the bridge refusals that send it
 *      to a direct call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { ALL_SCOPES } from '@/lib/auth/api-keys'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY_ID = '22222222-2222-4222-8222-222222222222'

const mocks = vi.hoisted(() => ({
  token: vi.fn<() => string | null>(),
  scopes: { current: [] as string[] },
  getUserCompanies: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getUserCompanies: (...args: unknown[]) => mocks.getUserCompanies(...args),
}))
vi.mock('@/lib/clients/fetch-client-overview', () => ({ getByraMembership: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/auth/rate-limit-http', () => ({ checkRateLimit: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})
vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  const { createTableMockSupabase } = await import('@/tests/helpers')
  return {
    ...actual,
    extractBearerToken: vi.fn(() => mocks.token()),
    validateApiKey: vi.fn(async () => ({
      userId: 'user-1',
      companyId: COMPANY_ID,
      scopes: [...mocks.scopes.current],
      apiKeyId: 'key-1',
      apiKeyName: 'Connector',
      mode: 'live',
    })),
    // Every read resolves empty; the membership read answers owner of the
    // default company so company routing passes.
    createServiceClientNoCookies: vi.fn(
      () =>
        createTableMockSupabase({ company_members: { data: { company_id: COMPANY_ID, role: 'owner' } } })
          .supabase,
    ),
  }
})

import { handleMcpRequest, tools } from '../server'
import { resetReachableCompanyCountCache } from '../company-routing'

type Hit = { name: string; callable_via?: string; note?: string }

const membership = (companyId: string) => ({
  company_id: companyId,
  companies: { id: companyId, name: 'X', archived_at: null },
})

interface Caller {
  label: string
  token: string | null
  scopes: readonly string[]
  companies: number
}

const READ_SCOPES = ALL_SCOPES.filter((scope) => scope.endsWith(':read'))

const CALLERS: Caller[] = [
  { label: 'owner connector on several companies', token: 'k', scopes: ALL_SCOPES, companies: 2 },
  { label: 'owner connector on one company', token: 'k', scopes: ALL_SCOPES, companies: 1 },
  { label: 'read-only key: nothing to stage', token: 'k', scopes: READ_SCOPES, companies: 2 },
  { label: 'not connected yet', token: null, scopes: [], companies: 0 },
]

function useCaller(caller: Caller) {
  mocks.token.mockReturnValue(caller.token)
  mocks.scopes.current = [...caller.scopes]
  mocks.getUserCompanies.mockResolvedValue(
    [membership(COMPANY_ID), membership(OTHER_COMPANY_ID)].slice(0, caller.companies),
  )
}

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const response = await handleMcpRequest(
    new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  expect(response.status).toBe(200)
  return (await response.json()) as { result: Record<string, unknown> }
}

async function listedNames(): Promise<Set<string>> {
  const json = await rpc('tools/list')
  return new Set((json.result.tools as Array<{ name: string }>).map((t) => t.name))
}

async function callTool(name: string, args: Record<string, unknown>) {
  const json = await rpc('tools/call', { name, arguments: args })
  const result = json.result as { content: Array<{ text: string }>; isError?: boolean }
  return { body: JSON.parse(result.content[0].text) as Record<string, unknown>, isError: result.isError === true }
}

async function search(query: string, limit = 5) {
  const { body } = await callTool('gnubok_search_tools', { query, limit })
  return body as { tools: Hit[]; tools_list_note?: string; bridge_note?: string }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resetReachableCompanyCountCache()
})

describe.each(CALLERS)('callable_via matches tools/list: $label', (caller) => {
  it('every search hit says tools_list exactly when this tools/list carries it, and a bridge only when the bridge is listed', async () => {
    useCaller(caller)
    const listed = await listedNames()
    const mismatches: string[] = []
    let hits = 0
    for (const tool of tools) {
      const hit = (await search(tool.name)).tools.find((h) => h.name === tool.name)
      // Hidden from this caller's search (scope, single-company mode): it
      // makes no reach claim at all.
      if (!hit) continue
      hits++
      if ((hit.callable_via === 'tools_list') !== listed.has(tool.name)) {
        mismatches.push(`${tool.name}: callable_via ${hit.callable_via}, in tools/list ${listed.has(tool.name)}`)
      }
      for (const bridge of ['call_tool', 'stage_tool']) {
        if (hit.callable_via === bridge && !listed.has(`gnubok_${bridge}`)) {
          mismatches.push(`${tool.name}: callable_via ${bridge}, but gnubok_${bridge} is not in tools/list`)
        }
      }
    }
    expect(hits).toBeGreaterThan(0)
    expect(mismatches).toEqual([])
  })
})

describe('the callers above exercise the cases that drifted', () => {
  it('a read-only key is not shown gnubok_stage_tool, and search says so', async () => {
    useCaller(CALLERS[2])
    expect(await listedNames()).not.toContain('gnubok_stage_tool')
    const hit = (await search('gnubok_stage_tool')).tools.find((h) => h.name === 'gnubok_stage_tool')!
    expect(hit.callable_via).toBe('none')
  })

  it('a single-company key is not shown gnubok_list_companies, and the briefing says how to reach it', async () => {
    useCaller(CALLERS[1])
    expect(await listedNames()).not.toContain('gnubok_list_companies')
    const { body } = await callTool('gnubok_get_agent_briefing', {})
    const loadouts = body.recommended_tools as Array<{
      workflow: string
      tools: Array<{ name: string; callable: boolean; note?: string }>
    }>
    const entry = loadouts
      .find((w) => w.workflow === 'receipt_hunt')!
      .tools.find((t) => t.name === 'gnubok_list_companies')!
    expect(entry.callable).toBe(true)
    expect(entry.note).toContain('gnubok_call_tool')

    useCaller(CALLERS[0])
    resetReachableCompanyCountCache()
    expect(await listedNames()).toContain('gnubok_list_companies')
    const multi = (await callTool('gnubok_get_agent_briefing', {})).body.recommended_tools as typeof loadouts
    expect(multi.find((w) => w.workflow === 'receipt_hunt')!.tools.find((t) => t.name === 'gnubok_list_companies'))
      .toEqual({ name: 'gnubok_list_companies', callable: true })
  })
})

describe('a client holding an older tools/list is told what unblocks it', () => {
  beforeEach(() => useCaller(CALLERS[0]))

  it('the update tool from the report is listed and searched as tools_list, with the refresh note', async () => {
    expect(await listedNames()).toContain('gnubok_update_invoice')
    const result = await search('gnubok_update_invoice')
    expect(result.tools[0]).toMatchObject({ name: 'gnubok_update_invoice', callable_via: 'tools_list' })
    expect(result.tools_list_note).toMatch(/older copy of the list/)
    expect(result.tools_list_note).toMatch(/refresh or reconnect/)
  })

  it('no note when no hit is tools_list', async () => {
    const result = await search('gnubok_create_invoice_from_sales_order', 1)
    expect(result.tools[0].callable_via).toBe('stage_tool')
    expect(result).not.toHaveProperty('tools_list_note')
  })

  it('both bridges, pointed at a listed write, name the stale-copy fix next to "call it directly"', async () => {
    for (const bridge of ['gnubok_stage_tool', 'gnubok_call_tool']) {
      const { body, isError } = await callTool(bridge, {
        tool: 'gnubok_update_invoice',
        arguments: { invoice_id: COMPANY_ID },
      })
      expect(isError, bridge).toBe(true)
      const text = JSON.stringify(body)
      expect(text, bridge).toContain('directly by name')
      expect(text, bridge).toContain('older copy of tools/list')
    }
  })
})

// gnubok_stage_tool was listed weeks after gnubok_call_tool: a connector
// added in between read payment orders through one bridge and told its user
// the other was "not available" (support case 2026-10-18).
describe('a client whose older tools/list lacks a bridge is told what unblocks it', () => {
  beforeEach(() => useCaller(CALLERS[0]))

  it('a search with a bridged hit carries the bridge note once', async () => {
    const result = await search('gnubok_prepare_payments', 1)
    expect(result.tools[0]).toMatchObject({ name: 'gnubok_prepare_payments', callable_via: 'stage_tool' })
    expect(result.bridge_note).toContain('gnubok_stage_tool')
    expect(result.bridge_note).toMatch(/refresh or reconnect/)
    expect(result.bridge_note).toMatch(/do not report it as unavailable/)
  })

  it('no bridge note when every hit is in tools/list', async () => {
    const result = await search('gnubok_update_invoice', 1)
    expect(result.tools[0].callable_via).toBe('tools_list')
    expect(result).not.toHaveProperty('bridge_note')
  })

  it('no bridge note on detail=name, which reports no reach', async () => {
    const { body } = await callTool('gnubok_search_tools', { query: 'gnubok_prepare_payments', limit: 1, detail: 'name' })
    expect(body).not.toHaveProperty('bridge_note')
  })

  it('gnubok_call_tool pointed at a staged write names the stale-copy fix next to "use gnubok_stage_tool"', async () => {
    const { body, isError } = await callTool('gnubok_call_tool', {
      tool: 'gnubok_prepare_payments',
      arguments: {},
    })
    expect(isError).toBe(true)
    const text = JSON.stringify(body)
    expect(text).toContain('use gnubok_stage_tool')
    expect(text).toContain('If your client does not show gnubok_stage_tool')
  })

  it('the briefing carries the bridge note when a loadout entry is reached through a bridge', async () => {
    const { body } = await callTool('gnubok_get_agent_briefing', {})
    const loadouts = body.recommended_tools as Array<{ tools: Array<{ callable: boolean; note?: string }> }>
    expect(loadouts.some((w) => w.tools.some((t) => t.callable && t.note))).toBe(true)
    expect(body.bridge_note).toMatch(/refresh or reconnect/)
  })

  it('the initialize instructions say the same', async () => {
    const json = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(json.result.instructions).toMatch(/A bridge your client does not show means it kept an older copy of tools\/list/)
  })
})
