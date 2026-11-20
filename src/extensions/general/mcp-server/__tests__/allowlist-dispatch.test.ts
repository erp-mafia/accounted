import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

/**
 * Dispatcher-level behaviour of a key with a company allowlist
 * (api_key_companies): the key's user belongs to two companies, the key is
 * restricted to one of them.
 *   - the other company is NOT_FOUND with candidates limited to the allowlist;
 *   - gnubok_list_companies lists only the allowlist;
 *   - all_companies listings and the scoped tools run over the allowlist only.
 */

// Hoisted: the api-keys mock factory below reads the allowed id at hoist time.
const { ALLOWED_COMPANY_ID } = vi.hoisted(() => ({
  ALLOWED_COMPANY_ID: '11111111-1111-4111-8111-111111111111',
}))
const MEMBER_ONLY_COMPANY_ID = '22222222-2222-4222-8222-222222222222'
const ENDPOINT = 'http://localhost:3000/api/extensions/ext/mcp-server/mcp'

const mocks = vi.hoisted(() => ({
  memberships: {} as Record<string, { role: string; name: string }>,
  membershipLookups: [] as string[],
  pendingQueries: [] as Array<{ column: string; value: unknown }>,
  getUserCompanies: vi.fn(),
  fetchPortfolioOverview: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getUserCompanies: (...args: unknown[]) => mocks.getUserCompanies(...args),
}))
vi.mock('@/lib/clients/fetch-client-overview', () => ({ getByraMembership: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/portfolio/overview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/portfolio/overview')>()
  return { ...actual, fetchPortfolioOverview: (...args: unknown[]) => mocks.fetchPortfolioOverview(...args) }
})
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
    maybeSingle: vi.fn(async () => {
      const id = requested
      requested = null
      if (id) mocks.membershipLookups.push(id)
      const membership = id ? mocks.memberships[id] : undefined
      return {
        data: membership && id
          ? { company_id: id, role: membership.role, companies: { archived_at: null, name: 'Legal', company_settings: { company_name: membership.name } } }
          : null,
        error: null,
      }
    }),
  })
  const pendingChain: Record<string, ReturnType<typeof vi.fn>> = {}
  Object.assign(pendingChain, {
    select: vi.fn(() => pendingChain),
    eq: vi.fn((column: string, value: unknown) => {
      mocks.pendingQueries.push({ column, value })
      return pendingChain
    }),
    in: vi.fn((column: string, value: unknown) => {
      mocks.pendingQueries.push({ column, value })
      return pendingChain
    }),
    order: vi.fn(() => pendingChain),
    range: vi.fn(async () => ({ data: [], error: null, count: 0 })),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
  })
  const settingsChain = {
    select: vi.fn(() => ({ in: vi.fn(() => ({ order: vi.fn(() => ({ range: vi.fn().mockResolvedValue({ data: [], error: null }) })) })) })),
  }
  return {
    from: vi.fn((table: string) => {
      if (table === 'company_members') return membershipChain
      if (table === 'pending_operations') return pendingChain
      if (table === 'company_settings') return settingsChain
      throw new Error(`Unexpected table: ${table}`)
    }),
  }
}

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: ALLOWED_COMPANY_ID,
      scopes: ['companies:read', 'pending_operations:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Restricted Key',
      mode: 'live',
      unattendedCommitLimit: null,
      allowedCompanyIds: [ALLOWED_COMPANY_ID],
    }),
    createServiceClientNoCookies: vi.fn(() => serviceClient()),
  }
})

import { handleMcpRequest } from '../server'

function toolCall(name: string, args: Record<string, unknown>): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer gnubok_sk_test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
}

async function parseTool(response: Response) {
  const json = await response.json()
  const result = json.result as { isError?: boolean; content: Array<{ text: string }> }
  return {
    isError: result.isError === true,
    text: JSON.parse(result.content[0].text) as Record<string, unknown>,
  }
}

describe('key allowlist at the dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mocks.membershipLookups.length = 0
    mocks.pendingQueries.length = 0
    mocks.memberships = {
      [ALLOWED_COMPANY_ID]: { role: 'owner', name: 'Allowed AB' },
      [MEMBER_ONLY_COMPANY_ID]: { role: 'owner', name: 'Member Only AB' },
    }
    mocks.getUserCompanies.mockResolvedValue([
      { company_id: ALLOWED_COMPANY_ID, role: 'owner', companies: { id: ALLOWED_COMPANY_ID, name: 'Allowed AB', archived_at: null, org_number: null, entity_type: 'aktiebolag', team_id: null } },
      { company_id: MEMBER_ONLY_COMPANY_ID, role: 'owner', companies: { id: MEMBER_ONLY_COMPANY_ID, name: 'Member Only AB', archived_at: null, org_number: null, entity_type: 'aktiebolag', team_id: null } },
    ])
    mocks.fetchPortfolioOverview.mockImplementation(async (_supabase: unknown, scope: { companies: unknown[] }) => ({
      team: null,
      summary: { companies: scope.companies.length, matched: scope.companies.length, unbooked_total: 0, inbox_total: 0, overdue: 0, action_needed: 0 },
      companies: [],
    }))
  })

  it('reaches the allowed company as usual', async () => {
    const result = await parseTool(
      await handleMcpRequest(toolCall('gnubok_list_pending_operations', { company_id: ALLOWED_COMPANY_ID }))
    )
    expect(result.isError).toBe(false)
    // A key limited to one company is a single-company key: simple company
    // mode, so the result carries no company block.
    expect(result.text).not.toHaveProperty('company')
  })

  it('answers a member company outside the allowlist with NOT_FOUND and allowlisted candidates only', async () => {
    const result = await parseTool(
      await handleMcpRequest(toolCall('gnubok_list_pending_operations', { company_id: MEMBER_ONLY_COMPANY_ID }))
    )
    expect(result.isError).toBe(true)
    expect((result.text.error as { code: string }).code).toBe('NOT_FOUND')
    expect(result.text.candidates).toEqual([{ company_id: ALLOWED_COMPANY_ID, name: 'Allowed AB' }])
    // Refused before the membership query: the allowlist reveals nothing.
    expect(mocks.membershipLookups).toEqual([])
  })

  it('lists only the allowlist from gnubok_list_companies', async () => {
    const result = await parseTool(await handleMcpRequest(toolCall('gnubok_list_companies', {})))
    expect(result.isError).toBe(false)
    const companies = result.text.companies as Array<{ company_id: string }>
    expect(companies.map((c) => c.company_id)).toEqual([ALLOWED_COMPANY_ID])
    expect(result.text.total_count).toBe(1)
  })

  it('bounds an all_companies listing to the allowlist', async () => {
    const result = await parseTool(
      await handleMcpRequest(toolCall('gnubok_list_pending_operations', { all_companies: true }))
    )
    expect(result.isError).toBe(false)
    const inFilter = mocks.pendingQueries.find((q) => q.column === 'company_id' && Array.isArray(q.value))
    expect(inFilter?.value).toEqual([ALLOWED_COMPANY_ID])
  })

  it('resolves a scoped tool over the allowlist only, reporting an explicit outsider as unresolved', async () => {
    const all = await parseTool(await handleMcpRequest(toolCall('gnubok_client_overview', { scope: 'all' })))
    expect(all.isError).toBe(false)
    const scopeArg = mocks.fetchPortfolioOverview.mock.calls[0][1] as { companies: Array<{ companyId: string }> }
    expect(scopeArg.companies.map((c) => c.companyId)).toEqual([ALLOWED_COMPANY_ID])

    const explicit = await parseTool(
      await handleMcpRequest(toolCall('gnubok_client_overview', { scope: [MEMBER_ONLY_COMPANY_ID, ALLOWED_COMPANY_ID] }))
    )
    expect(explicit.isError).toBe(false)
    expect((explicit.text.scope as { unresolved: string[] }).unresolved).toEqual([MEMBER_ONLY_COMPANY_ID])
  })
})
