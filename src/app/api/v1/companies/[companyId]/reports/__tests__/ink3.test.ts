/**
 * GET /api/v1/companies/{companyId}/reports/ink3 (operation reports.ink3)
 * through the v1 door, and the MCP tool the same operation generates. The
 * engine is mocked (lib/reports/ink3 has its own tests); what is under test
 * is the door: auth and scope, validation, the 404 for another company's
 * period, the legal-form and period refusals, and the qualified ids.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// The shared wrapper's lease boundary has separate real and unit coverage.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
}))

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})

const generate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reports/ink3/ink3-engine', async (orig) => ({
  ...(await orig<typeof import('@/lib/reports/ink3/ink3-engine')>()),
  generateInk3Underlag: generate,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { Ink3PeriodNotSupportedError } from '@/lib/reports/ink3/field-table'
import { reportsInk3 } from '@/lib/operations/filing-reports'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { GET } from '../ink3/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const PERIOD = {
  data: { id: PERIOD_ID, name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: true },
  error: null,
}
const NO_PERIOD = { data: null, error: null }
const IDEELL = { data: { entity_type: 'ideell_forening' }, error: null }
const AB = { data: { entity_type: 'aktiebolag' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}`
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

function get(path: string) {
  return GET(new Request(`${BASE}${path}`, { headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } }), params)
}

function useClient(tables: Record<string, TableMockResult>) {
  const { supabase } = createTableMockSupabase({ company_members: OWNER, ...tables })
  mockServiceClient.mockReturnValue(supabase)
  return supabase
}

function underlag() {
  return {
    fiscalYear: { id: PERIOD_ID, name: '2026', start: '2026-01-01', end: '2026-12-31', isClosed: true },
    beskattningsperiod: '2026P4',
    fieldTable: { beskattningsperiod: '2026P4', files: ['INK3R_SKV2003-33-02-26-07.xls'] },
    companyInfo: { companyName: 'Föreningen', orgNumber: '802400-0000' },
    allmannyttig: true,
    sufApplicable: true,
    fields: [],
    filing: { '8650': 42000, '8663': 18000 },
    accounts: [],
    totals: { totalAssets: 1, totalEquityLiabilities: 1, bookkeepingResult: 18000, taxableResult: 0, taxableSurplus: 0 },
    complete: true,
    warnings: [],
  }
}

const PATH = `/reports/ink3?period_id=${PERIOD_ID}`

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read'],
    mode: 'live',
  })
})

describe('GET /reports/ink3', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    useClient({})
    expect((await get(PATH)).status).toBe(401)
  })

  it('403 without reports:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    useClient({})
    expect((await get(PATH)).status).toBe(403)
  })

  it('400 VALIDATION_ERROR without a uuid period_id', async () => {
    useClient({})
    const res = await get('/reports/ink3?period_id=nope')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it("404 for a period that is not the company's, before the engine runs", async () => {
    useClient({ fiscal_periods: NO_PERIOD })
    const res = await get(PATH)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('FISCAL_PERIOD_NOT_FOUND')
    expect(generate).not.toHaveBeenCalled()
  })

  it('400 TAX_DECL_INK3_WRONG_LEGAL_FORM for an aktiebolag', async () => {
    useClient({ fiscal_periods: PERIOD, company_settings: AB })
    const res = await get(PATH)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('TAX_DECL_INK3_WRONG_LEGAL_FORM')
    expect(generate).not.toHaveBeenCalled()
  })

  it('422 TAX_DECL_INK3_PERIOD_NOT_SUPPORTED for a räkenskapsår without pinned field codes', async () => {
    useClient({ fiscal_periods: PERIOD, company_settings: IDEELL })
    generate.mockRejectedValue(new Ink3PeriodNotSupportedError('2025P4', ['2026P4']))
    const res = await get(PATH)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.code).toBe('TAX_DECL_INK3_PERIOD_NOT_SUPPORTED')
    expect(body.error.details).toMatchObject({ beskattningsperiod: '2025P4', supported: ['2026P4'] })
  })

  it('200 with the underlag and a qualified fiscal period id', async () => {
    useClient({ fiscal_periods: PERIOD, company_settings: IDEELL })
    generate.mockResolvedValue(underlag())
    const res = await get(PATH)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.filing).toEqual({ '8650': 42000, '8663': 18000 })
    expect(body.data.beskattningsperiod).toBe('2026P4')
    expect(body.data.fiscalYear.fiscal_period_id).toBe(PERIOD_ID)
    expect(body.data.fiscalYear.id).toBeUndefined()
    expect(generate).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, PERIOD_ID)
  })
})

describe('MCP gnubok_get_ink3_underlag', () => {
  it('is a read-only tool on reports:read, generated from the same operation', () => {
    expect(reportsInk3.kind).toBe('read')
    expect(reportsInk3.mcp?.name).toBe('gnubok_get_ink3_underlag')
    expect(TOOL_SCOPE_MAP['gnubok_get_ink3_underlag']).toBe('reports:read')
    expect(reportsInk3.mcp?.stage).toBeUndefined()
    expect((reportsInk3.mcp?.description ?? '').length).toBeLessThanOrEqual(280)
  })
})
