import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

/**
 * The server shows two faces, chosen per request from how many companies the
 * key reaches:
 *   - one company (or none): no company block on results, no company_id
 *     property on tool schemas, no company switch or cross-company tools in
 *     tools/list or tool search, one short company line in the instructions;
 *   - several: the full multi-company surface.
 * A failed count lookup reads as several (the informative face).
 */

const DEFAULT_COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY_ID = '22222222-2222-4222-8222-222222222222'

const mocks = vi.hoisted(() => ({
  getUserCompanies: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getUserCompanies: (...args: unknown[]) => mocks.getUserCompanies(...args),
}))
vi.mock('@/lib/clients/fetch-client-overview', () => ({ getByraMembership: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/entitlements/multi-user', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/multi-user')>()
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'entitled', graceEndsAt: null }) }
})

function serviceClient() {
  const membershipChain: Record<string, ReturnType<typeof vi.fn>> = {}
  let requested: string | null = null
  Object.assign(membershipChain, {
    select: vi.fn(() => membershipChain),
    eq: vi.fn((column: string, value: string) => {
      if (column === 'company_id') requested = value
      return membershipChain
    }),
    is: vi.fn(() => membershipChain),
    maybeSingle: vi.fn(async () => ({
      data: requested
        ? { company_id: requested, role: 'owner', companies: { archived_at: null, name: 'Solo AB' } }
        : null,
      error: null,
    })),
  })
  const pendingChain: Record<string, ReturnType<typeof vi.fn>> = {}
  Object.assign(pendingChain, {
    select: vi.fn(() => pendingChain),
    eq: vi.fn(() => pendingChain),
    in: vi.fn(() => pendingChain),
    order: vi.fn(() => pendingChain),
    range: vi.fn(async () => ({ data: [], error: null, count: 0 })),
  })
  return {
    from: vi.fn((table: string) => {
      if (table === 'company_members') return membershipChain
      if (table === 'pending_operations') return pendingChain
      throw new Error(`Unexpected table: ${table}`)
    }),
  }
}

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['companies:read', 'pending_operations:read', 'reports:read', 'invoices:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Test Key',
    }),
    createServiceClientNoCookies: vi.fn(() => serviceClient()),
  }
})

import { handleMcpRequest } from '../server'
import {
  getReachableCompanyCount,
  isSimpleCompanyMode,
  resetReachableCompanyCountCache,
} from '../company-routing'

const membership = (companyId: string, archivedAt: string | null = null) => ({
  company_id: companyId,
  companies: { id: companyId, name: 'X', archived_at: archivedAt },
})

function rpc(method: string, params: Record<string, unknown> = {}): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

async function listTools() {
  const json = await (await handleMcpRequest(rpc('tools/list'))).json()
  return json.result.tools as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>
}

async function callListPending() {
  const json = await (
    await handleMcpRequest(rpc('tools/call', { name: 'gnubok_list_pending_operations', arguments: {} }))
  ).json()
  const result = json.result as { content: Array<{ text: string }>; _meta?: Record<string, unknown>; isError?: boolean }
  return { text: JSON.parse(result.content[0].text) as Record<string, unknown>, meta: result._meta, isError: result.isError === true }
}

async function instructions() {
  const json = await (
    await handleMcpRequest(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }))
  ).json()
  return json.result.instructions as string
}

const MULTI_ONLY = [
  'gnubok_list_companies',
  'gnubok_client_overview',
  'gnubok_run_across_companies',
]

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resetReachableCompanyCountCache()
})

describe('single-company key: the simple face', () => {
  beforeEach(() => {
    mocks.getUserCompanies.mockResolvedValue([membership(DEFAULT_COMPANY_ID)])
  })

  it('lists no company switch, no cross-company tools and no company_id property', async () => {
    const tools = await listTools()
    const names = tools.map((t) => t.name)
    for (const name of MULTI_ONLY) expect(names).not.toContain(name)
    expect(names).toContain('gnubok_list_pending_operations')
    const withCompanyId = tools.filter((t) => t.inputSchema.properties && 'company_id' in t.inputSchema.properties)
    expect(withCompanyId.map((t) => t.name)).toEqual([])
  })

  it('returns results without the company block, in text and in _meta', async () => {
    const result = await callListPending()
    expect(result.isError).toBe(false)
    expect(result.text).not.toHaveProperty('company')
    expect(result.meta?.company).toBeUndefined()
  })

  it('still accepts a company_id the caller sends anyway', async () => {
    const json = await (
      await handleMcpRequest(
        rpc('tools/call', { name: 'gnubok_list_pending_operations', arguments: { company_id: DEFAULT_COMPANY_ID } })
      )
    ).json()
    expect(json.result.isError).toBeUndefined()
  })

  it('tells the agent in one line that company_id is never needed', async () => {
    const text = await instructions()
    expect(text).toContain('this account has one company')
    expect(text).not.toContain('gnubok_run_across_companies')
    expect(text).not.toContain('gnubok_list_companies lists every company')
  })

  it('keeps the multi-company tools out of tool search', async () => {
    const json = await (
      await handleMcpRequest(
        rpc('tools/call', { name: 'gnubok_search_tools', arguments: { query: 'companies', detail: 'full', limit: 50 } })
      )
    ).json()
    const payload = JSON.parse(json.result.content[0].text) as {
      tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>
    }
    const names = payload.tools.map((t) => t.name)
    for (const name of MULTI_ONLY) expect(names).not.toContain(name)
    for (const tool of payload.tools) {
      expect(tool.inputSchema?.properties ?? {}).not.toHaveProperty('company_id')
    }
  })

  it('looks the count up once and serves the following calls from the cache', async () => {
    await listTools()
    await callListPending()
    await callListPending()
    expect(mocks.getUserCompanies).toHaveBeenCalledTimes(1)
  })
})

describe('multi-company key: the full face', () => {
  beforeEach(() => {
    mocks.getUserCompanies.mockResolvedValue([
      membership(DEFAULT_COMPANY_ID),
      membership(OTHER_COMPANY_ID),
    ])
  })

  it('lists the company switch, the cross-company tools and company_id on company tools', async () => {
    const tools = await listTools()
    const names = tools.map((t) => t.name)
    for (const name of MULTI_ONLY) expect(names).toContain(name)
    const pending = tools.find((t) => t.name === 'gnubok_list_pending_operations')!
    expect(pending.inputSchema.properties).toHaveProperty('company_id')
  })

  it('opens every company-scoped result with the company block', async () => {
    const result = await callListPending()
    expect(Object.keys(result.text)[0]).toBe('company')
    expect(result.text.company).toEqual({ company_id: DEFAULT_COMPANY_ID, name: 'Solo AB', is_default: true })
    expect(result.meta).toMatchObject({ company: { company_id: DEFAULT_COMPANY_ID } })
  })

  it('carries the multi-company guidance in the instructions', async () => {
    const text = await instructions()
    expect(text).toContain('gnubok_run_across_companies')
    expect(text).not.toContain('this account has one company')
  })
})

describe('count lookup', () => {
  it('ignores archived companies, honours a restriction and treats a failure as unknown', async () => {
    mocks.getUserCompanies.mockResolvedValue([
      membership(DEFAULT_COMPANY_ID),
      membership(OTHER_COMPANY_ID),
      membership('33333333-3333-4333-8333-333333333333', '2026-01-01'),
    ])
    await expect(getReachableCompanyCount({} as never, 'user-1')).resolves.toBe(2)
    await expect(getReachableCompanyCount({} as never, 'user-1', [OTHER_COMPANY_ID.toUpperCase()])).resolves.toBe(1)

    resetReachableCompanyCountCache()
    mocks.getUserCompanies.mockRejectedValue(new Error('down'))
    await expect(getReachableCompanyCount({} as never, 'user-1')).resolves.toBeNull()
    // Unknown is never cached: the next request tries again.
    mocks.getUserCompanies.mockResolvedValue([membership(DEFAULT_COMPANY_ID)])
    await expect(getReachableCompanyCount({} as never, 'user-1')).resolves.toBe(1)
  })

  it('expires the cache after a minute', async () => {
    let clock = 1_000
    mocks.getUserCompanies.mockResolvedValue([membership(DEFAULT_COMPANY_ID)])
    await getReachableCompanyCount({} as never, 'user-1', null, () => clock)
    clock += 59_000
    await getReachableCompanyCount({} as never, 'user-1', null, () => clock)
    expect(mocks.getUserCompanies).toHaveBeenCalledTimes(1)
    clock += 2_000
    await getReachableCompanyCount({} as never, 'user-1', null, () => clock)
    expect(mocks.getUserCompanies).toHaveBeenCalledTimes(2)
  })

  it('one company or none is simple; several or unknown is not', () => {
    expect(isSimpleCompanyMode(0)).toBe(true)
    expect(isSimpleCompanyMode(1)).toBe(true)
    expect(isSimpleCompanyMode(2)).toBe(false)
    expect(isSimpleCompanyMode(null)).toBe(false)
  })

  it('a failed lookup shows the full face', async () => {
    mocks.getUserCompanies.mockRejectedValue(new Error('down'))
    const result = await callListPending()
    expect(result.text).toHaveProperty('company')
  })
})
