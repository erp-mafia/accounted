/**
 * What an agent sees of each representative company (tests/fixtures/
 * representative-companies.ts): the tools/list names for single-company,
 * multi-company, read-only and anonymous connections, and the briefing's
 * capabilities digest and recommended_tools reach.
 *
 * Written before tools/list and the briefing read the resolved capabilities
 * object (lib/modules/capabilities.ts) and kept byte-identical since: the
 * packages step changes how MCP decides, never what it lists. A diff here is
 * a visible change. Update the snapshot only when the catalog itself changes
 * (a tool added to or removed from the default catalog), never to absorb a
 * capabilities change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { ALL_SCOPES, DEFAULT_SCOPES } from '@/lib/auth/scope-catalog'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  REPRESENTATIVE_COMPANIES,
  representativeCompanyTables,
  type RepresentativeCompany,
} from '@/tests/fixtures/representative-companies'

const mocks = vi.hoisted(() => ({
  getUserCompanies: vi.fn(),
  validateApiKey: vi.fn(),
  supabase: null as unknown,
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
vi.mock('@/lib/auth/rate-limit-http', () => ({ checkRateLimit: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    validateApiKey: (...args: unknown[]) => mocks.validateApiKey(...args),
    createServiceClientNoCookies: vi.fn(() => mocks.supabase),
  }
})

import { handleMcpRequest, tools } from '../server'
import { resetReachableCompanyCountCache } from '../company-routing'

const OTHER_COMPANY_ID = 'b2b2b2b2-0000-4000-8000-000000000009'

const membership = (companyId: string, archivedAt: string | null = null) => ({
  company_id: companyId,
  companies: { id: companyId, name: 'X', archived_at: archivedAt },
})

function useCompany(company: RepresentativeCompany, opts: { scopes: readonly string[]; reach?: 'one' | 'two' }) {
  const { supabase } = createTableMockSupabase(representativeCompanyTables(company))
  mocks.supabase = supabase
  mocks.validateApiKey.mockResolvedValue({
    userId: 'user-1',
    companyId: company.id,
    scopes: [...opts.scopes],
    apiKeyId: 'key-1',
    apiKeyName: 'Snapshot key',
    mode: 'live',
  })
  mocks.getUserCompanies.mockResolvedValue(
    opts.reach === 'two'
      ? [membership(company.id, company.companies.archived_at), membership(OTHER_COMPANY_ID)]
      : [membership(company.id, company.companies.archived_at)],
  )
  return supabase
}

async function listedToolNames(opts: { anonymous?: boolean } = {}): Promise<string[]> {
  const request = new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.anonymous ? {} : { Authorization: 'Bearer test-token' }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  const json = await (await handleMcpRequest(request)).json()
  return (json.result.tools as Array<{ name: string }>).map((t) => t.name)
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resetReachableCompanyCountCache()
})

describe('tools/list for each representative company', () => {
  it.each(REPRESENTATIVE_COMPANIES.map((c) => [c.name, c] as const))(
    'single-company key with every scope: %s',
    async (_name, company) => {
      useCompany(company, { scopes: ALL_SCOPES })
      expect(await listedToolNames()).toMatchSnapshot()
    },
  )

  it('single-company key with the default read-only scopes', async () => {
    useCompany(REPRESENTATIVE_COMPANIES[0], { scopes: DEFAULT_SCOPES })
    expect(await listedToolNames()).toMatchSnapshot()
  })

  it('a key that reaches two companies', async () => {
    useCompany(REPRESENTATIVE_COMPANIES[1], { scopes: ALL_SCOPES, reach: 'two' })
    expect(await listedToolNames()).toMatchSnapshot()
  })

  it('an anonymous connection', async () => {
    useCompany(REPRESENTATIVE_COMPANIES[0], { scopes: ALL_SCOPES })
    expect(await listedToolNames({ anonymous: true })).toMatchSnapshot()
  })
})

describe('the agent briefing for each representative company', () => {
  const briefing = () => tools.find((t) => t.name === 'gnubok_get_agent_briefing')!

  it.each(REPRESENTATIVE_COMPANIES.map((c) => [c.name, c] as const))('%s', async (_name, company) => {
    const supabase = useCompany(company, { scopes: ALL_SCOPES })
    const result = (await briefing().execute(
      { __keyScopes: ALL_SCOPES, __simpleCompanyMode: true },
      company.id,
      'user-1',
      supabase as never,
      { type: 'api_key', label: 'Snapshot key' },
    )) as { capabilities?: unknown; recommended_tools: unknown }
    expect({ capabilities: result.capabilities, recommended_tools: result.recommended_tools }).toMatchSnapshot()
  })
})
