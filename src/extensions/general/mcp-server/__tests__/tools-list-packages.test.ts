/**
 * tools/list reads the resolved capabilities (lib/modules/capabilities.ts):
 * a tool whose module's package the company does not have is not listed, as
 * its page is not in the menu: switched off by the company's own row
 * (company_capability_config `package:payroll`, enabled = false, nothing
 * writes it yet) or left off by a stored profile. A company without either
 * lists exactly what it did (capabilities-snapshot.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { ALL_SCOPES } from '@/lib/auth/scope-catalog'
import { createTableMockSupabase } from '@/tests/helpers'
import { REPRESENTATIVE_COMPANIES, representativeCompanyTables } from '@/tests/fixtures/representative-companies'

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

import { handleMcpRequest, isListedFor, tools, type CatalogViewer } from '../server'
import { resetReachableCompanyCountCache } from '../company-routing'
import { moduleForTool } from '../tool-modules'

const COMPANY = REPRESENTATIVE_COMPANIES[0]
const PAYROLL_LISTED = tools.filter(
  (t) => moduleForTool(t.name) === 'payroll' && isListedFor(t, { anonymous: false, simpleCompanyMode: true, keyScopes: ALL_SCOPES }),
).map((t) => t.name)

function connect(opts: {
  switchedOff?: string[]
  reach?: 'one' | 'two'
  failCapabilities?: boolean
  profile?: { profile_id: string; profile_version: number }
  /** A salary run not yet paid and booked: Lön's obligation probe finds it. */
  openSalaryRun?: boolean
}) {
  const tables: Record<string, unknown> = representativeCompanyTables({
    ...COMPANY,
    disabledConfigKeys: (opts.switchedOff ?? []).map((id) => `package:${id}`),
  })
  if (opts.openSalaryRun) tables.salary_runs = { data: [{ id: 'run-1' }] }
  if (opts.profile) {
    // The stored profile answers its own read; every other companies read gets the row.
    const row = (tables.companies as { data: unknown }).data
    const profile = opts.profile
    tables.companies = (chainCalls: Array<{ method: string; args: unknown[] }>) =>
      chainCalls.some((c) => c.method === 'select' && String(c.args[0]).includes('profile_id')) ? { data: profile } : { data: row }
  }
  if (opts.failCapabilities) tables.companies = { data: null, error: { message: 'statement timeout' } }
  mocks.supabase = createTableMockSupabase(tables as never).supabase
  mocks.validateApiKey.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY.id,
    scopes: [...ALL_SCOPES],
    apiKeyId: 'key-1',
    apiKeyName: 'Packages key',
    mode: 'live',
  })
  const membership = (id: string) => ({ company_id: id, companies: { id, name: 'X', archived_at: null } })
  mocks.getUserCompanies.mockResolvedValue(
    opts.reach === 'two' ? [membership(COMPANY.id), membership('b2b2b2b2-0000-4000-8000-000000000009')] : [membership(COMPANY.id)],
  )
}

function rpc(method: string, params: Record<string, unknown> = {}): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

async function listed(): Promise<string[]> {
  const json = await (await handleMcpRequest(rpc('tools/list'))).json()
  return (json.result.tools as Array<{ name: string }>).map((t) => t.name)
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resetReachableCompanyCountCache()
})

describe('tools/list reads the resolved capabilities', () => {
  it('has payroll tools in the default catalog to hide', () => {
    expect(PAYROLL_LISTED.length).toBeGreaterThan(0)
  })

  it('lists the MCP hints and keeps the server-side effect class off the wire', async () => {
    connect({})
    const json = await (await handleMcpRequest(rpc('tools/list'))).json()
    const listedTools = json.result.tools as Array<{ name: string; annotations: Record<string, unknown> }>
    expect(listedTools.length).toBeGreaterThan(0)
    for (const tool of listedTools) {
      expect(tool.annotations, tool.name).not.toHaveProperty('effect')
      expect(typeof tool.annotations.readOnlyHint, tool.name).toBe('boolean')
    }
  })

  it('leaves out the tools of a switched-off package on a single-company connection', async () => {
    connect({ switchedOff: ['payroll'] })
    const names = await listed()
    expect(names.filter((n) => PAYROLL_LISTED.includes(n))).toEqual([])
    // Everything else stays, the briefing included.
    expect(names).toContain('gnubok_get_agent_briefing')
    expect(names).toContain('gnubok_list_invoices')
  })

  it('leaves out the tools of the packages a stored profile starts with off', async () => {
    connect({ profile: { profile_id: 'limited-company-no-employees', profile_version: 1 } })
    const names = await listed()
    expect(names.filter((n) => PAYROLL_LISTED.includes(n))).toEqual([])
    expect(names).toContain('gnubok_list_invoices')
    expect(names).toContain('gnubok_list_supplier_invoices')
  })

  it('keeps listing the tools of a package that winds down: its open work must be reachable', async () => {
    connect({ switchedOff: ['payroll'], openSalaryRun: true })
    expect(await listed()).toEqual(expect.arrayContaining(PAYROLL_LISTED))
  })

  it('lists every package on a connection that reaches several companies', async () => {
    connect({ switchedOff: ['payroll'], reach: 'two' })
    expect(await listed()).toEqual(expect.arrayContaining(PAYROLL_LISTED))
  })

  it('hides nothing when the capabilities cannot be read', async () => {
    connect({ switchedOff: ['payroll'], failCapabilities: true })
    expect(await listed()).toEqual(expect.arrayContaining(PAYROLL_LISTED))
  })

  it('tells search the same: a hidden tool is never reported as listed', async () => {
    connect({ switchedOff: ['payroll'] })
    const json = await (
      await handleMcpRequest(rpc('tools/call', { name: 'gnubok_search_tools', arguments: { query: 'salary', limit: 50 } }))
    ).json()
    const hits = JSON.parse(json.result.content[0].text).tools as Array<{ name: string; callable_via: string }>
    const payrollHits = hits.filter((h) => PAYROLL_LISTED.includes(h.name))
    expect(payrollHits.length).toBeGreaterThan(0)
    for (const hit of payrollHits) expect(hit.callable_via, hit.name).not.toBe('tools_list')
  })
})

describe('isListedFor', () => {
  const viewer = (hidden?: string[]): CatalogViewer => ({
    anonymous: false,
    simpleCompanyMode: true,
    keyScopes: ALL_SCOPES,
    ...(hidden ? { hiddenModules: new Set(hidden as never[]) } : {}),
  })

  it('hides a tool by its module and keeps the rest', () => {
    const payroll = tools.find((t) => t.name === PAYROLL_LISTED[0])!
    const invoices = tools.find((t) => t.name === 'gnubok_list_invoices')!
    expect(isListedFor(payroll, viewer())).toBe(true)
    expect(isListedFor(payroll, viewer(['payroll']))).toBe(false)
    expect(isListedFor(invoices, viewer(['payroll']))).toBe(true)
  })
})

describe('the briefing reads the same package view', () => {
  const briefing = () => tools.find((t) => t.name === 'gnubok_get_agent_briefing')!

  async function payrollLoadout(switchedOff: string[]) {
    connect({ switchedOff })
    const result = (await briefing().execute(
      { __keyScopes: ALL_SCOPES, __simpleCompanyMode: true },
      COMPANY.id,
      'user-1',
      mocks.supabase as never,
      { type: 'api_key', label: 'Packages key' },
    )) as { recommended_tools: Array<{ workflow: string; tools: Array<{ name: string; callable: boolean; note?: string }> }> }
    return result.recommended_tools.find((w) => w.workflow === 'payroll_month')!.tools
  }

  it('names the stored profile and the packages it leaves off', async () => {
    connect({ profile: { profile_id: 'limited-company-no-employees', profile_version: 1 } })
    const result = (await briefing().execute(
      { __keyScopes: ALL_SCOPES, __simpleCompanyMode: true },
      COMPANY.id,
      'user-1',
      mocks.supabase as never,
      { type: 'api_key', label: 'Packages key' },
    )) as { capabilities_profile?: unknown }
    expect(result.capabilities_profile).toEqual({
      id: 'limited-company-no-employees',
      version: 1,
      name: 'Limited company without employees',
      name_sv: 'Aktiebolag utan anställda',
      source: 'stored',
      packages_off: ['payroll', 'assets', 'pos-and-webshop'],
    })
  })

  it('names a package that winds down with what keeps it visible, and nothing for a company where none does', async () => {
    const run = async () =>
      (await briefing().execute(
        { __keyScopes: ALL_SCOPES, __simpleCompanyMode: true },
        COMPANY.id,
        'user-1',
        mocks.supabase as never,
        { type: 'api_key', label: 'Packages key' },
      )) as { capabilities_profile?: Record<string, unknown> }
    connect({ switchedOff: ['payroll'], openSalaryRun: true })
    const winding = (await run()).capabilities_profile!
    expect(winding.packages_off).toEqual([])
    expect(winding.packages_winding_down).toEqual([
      expect.objectContaining({
        package_id: 'payroll',
        name_sv: 'Lön',
        open_obligations: expect.arrayContaining(['open_salary_runs']),
      }),
    ])

    connect({})
    expect((await run()).capabilities_profile).not.toHaveProperty('packages_winding_down')
  })

  it('stops calling a payroll tool listed once Lön is switched off', async () => {
    const on = await payrollLoadout([])
    const off = await payrollLoadout(['payroll'])
    const listedOn = on.filter((t) => PAYROLL_LISTED.includes(t.name))
    expect(listedOn.length).toBeGreaterThan(0)
    for (const t of listedOn) expect(t.note, t.name).toBeUndefined()
    for (const t of off.filter((e) => PAYROLL_LISTED.includes(e.name))) expect(t.note, t.name).toBeDefined()
  })
})
