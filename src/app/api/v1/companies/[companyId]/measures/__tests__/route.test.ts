/**
 * GET /measures, /measures/{id} and /measures/{id}/explain through the v1
 * door of the operation registry (src/lib/operations/measures.ts). The
 * service client is the in-memory company of the measure parity tests, so
 * the routes run the real registry and report generators end to end.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// The SIE import lease has its own tests (lib/import/__tests__/sie-period-read.test.ts).
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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createFakeLedger } from '@/lib/measures/__tests__/fake-ledger'
import { CO, FP, fixtureData } from '@/lib/measures/__tests__/fixtures'
import { GET as listMeasures } from '../route'
import { GET as getMeasure } from '../[measureId]/route'
import { GET as explainMeasure } from '../[measureId]/explain/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const BASE = `https://x.test/api/v1/companies/${CO}/measures`
type Handler = (req: Request, p: { params: Promise<Record<string, string>> }) => Promise<Response>

function call(handler: Handler, path: string, params: Record<string, string> = {}) {
  return handler(new Request(`${BASE}${path}`, { headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } }), {
    params: Promise.resolve({ companyId: CO, ...params }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: CO,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read'],
    mode: 'live',
  })
  const ledger = createFakeLedger(
    fixtureData({ extraTables: { company_members: [{ company_id: CO, user_id: 'user-1', role: 'owner' }] } }),
  )
  mockServiceClient.mockReturnValue(ledger.supabase)
})

describe('auth and scope', () => {
  const doors: Array<[string, Handler, string, Record<string, string>]> = [
    ['list', listMeasures as Handler, '', {}],
    ['get', getMeasure as Handler, '/accounts_receivable?as_of_date=2026-06-30', { measureId: 'accounts_receivable' }],
    ['explain', explainMeasure as Handler, '/accounts_receivable/explain?as_of_date=2026-06-30', { measureId: 'accounts_receivable' }],
  ]

  it.each(doors)('%s: 401 when the API key is rejected', async (_name, handler, path, params) => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    expect((await call(handler, path, params)).status).toBe(401)
  })

  it.each(doors)('%s: 403 without reports:read', async (_name, handler, path, params) => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: CO, scopes: ['transactions:read'], mode: 'live' })
    expect((await call(handler, path, params)).status).toBe(403)
  })
})

describe('GET /measures', () => {
  it('lists every measure with its definition and the report it equals', async () => {
    const res = await call(listMeasures as Handler, '')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.measures).toHaveLength(10)
    expect(body.data.measures[0]).toMatchObject({ measure_id: 'vat_payable', unit: 'SEK', dimension: 'vat_period' })
  })
})

describe('GET /measures/{id}', () => {
  it('200 with the value, definition, as_of and explain handle', async () => {
    const res = await call(getMeasure as Handler, '/accounts_receivable?as_of_date=2026-06-30', { measureId: 'accounts_receivable' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({
      measure_id: 'accounts_receivable',
      value: 12500,
      unit: 'SEK',
      as_of: '2026-06-30',
      period: { start: '2026-01-01', end: '2026-06-30', fiscal_period_id: FP },
      equals: { report: 'Balansräkning', mcp_tool: 'gnubok_get_balance_sheet' },
    })
    expect(body.data.explain.v1_path).toBe(`/api/v1/companies/${CO}/measures/accounts_receivable/explain?as_of_date=2026-06-30`)
    // No bare id at a resource position: nothing for the handle layer to stamp.
    expect(body.data.id).toBeUndefined()
  })

  it('takes the momsperiod as query numbers', async () => {
    const res = await call(getMeasure as Handler, '/vat_payable?period_type=quarterly&year=2026&period=1', { measureId: 'vat_payable' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ value: 500, vat_period: { period_type: 'quarterly', year: 2026, period: 1 } })
  })

  it('404 MEASURE_NOT_FOUND for an unknown measure, with the valid ids', async () => {
    const res = await call(getMeasure as Handler, '/cash', { measureId: 'cash' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('MEASURE_NOT_FOUND')
    expect(body.error.details.valid).toContain('liquid_funds')
  })

  it('400 MEASURE_PERIOD_REQUIRED for vat_payable without a momsperiod, with the Swedish reason', async () => {
    const res = await call(getMeasure as Handler, '/vat_payable', { measureId: 'vat_payable' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('MEASURE_PERIOD_REQUIRED')
    expect(body.error.details.reason).toContain('momsperiod')
  })

  it('404 MEASURE_PERIOD_NOT_FOUND for a date no fiscal period covers', async () => {
    const res = await call(getMeasure as Handler, '/liquid_funds?as_of_date=2024-01-31', { measureId: 'liquid_funds' })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('MEASURE_PERIOD_NOT_FOUND')
  })

  it('400 for a query parameter the endpoint does not know, never dropped', async () => {
    const res = await call(getMeasure as Handler, '/accounts_receivable?as_of=2026-06-30', { measureId: 'accounts_receivable' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('400 MEASURE_PARAMETER_NOT_ACCEPTED for a parameter the measure does not take', async () => {
    const res = await call(getMeasure as Handler, '/accounts_receivable?from_date=2026-01-01', { measureId: 'accounts_receivable' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('MEASURE_PARAMETER_NOT_ACCEPTED')
  })

  it('400 VALIDATION_ERROR for a malformed period_id', async () => {
    const res = await call(getMeasure as Handler, '/net_revenue?period_id=nope', { measureId: 'net_revenue' })
    expect(res.status).toBe(400)
  })
})

describe('GET /measures/{id}/explain', () => {
  it('200 with contributors and journal lines carrying je_ handles, paged', async () => {
    const res = await call(explainMeasure as Handler, '/accounts_receivable/explain?as_of_date=2026-06-30&limit=1', {
      measureId: 'accounts_receivable',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.contributors[0]).toMatchObject({ account_number: '1510', amount: 12500, role: 'accounts_receivable' })
    expect(body.data.drilldown).toMatchObject({ kind: 'journal_lines', total: 2, offset: 0, next_offset: 1 })
    expect(body.data.drilldown.items[0].handle).toMatch(/^je_[0-9a-f]{32}$/)
    expect(body.data.reconciles).toBe(true)
  })

  it('refuses like the value does', async () => {
    const res = await call(explainMeasure as Handler, '/vat_payable/explain', { measureId: 'vat_payable' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('MEASURE_PERIOD_REQUIRED')
  })
})
