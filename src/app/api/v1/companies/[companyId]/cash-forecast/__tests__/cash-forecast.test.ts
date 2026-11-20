/**
 * GET /api/v1/companies/:companyId/cash-forecast (operation cash-forecast.get):
 * the door's contract. The projection's rules are tested in
 * src/lib/forecast/__tests__; here the builder is replaced.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

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
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
const buildMock = vi.fn()
vi.mock('@/lib/forecast/build', async () => {
  const actual = await vi.importActual<typeof import('@/lib/forecast/build')>('@/lib/forecast/build')
  return { ...actual, buildCashForecast: (...a: unknown[]) => buildMock(...a) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_COMPANY = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'viewer' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/cash-forecast`

const FORECAST = {
  currency: 'SEK',
  today: '2026-10-28',
  horizon: { start: '2026-10-28', end: '2027-01-24', weeks: 13 },
  opening: { amount: 100000, source: 'bank', as_of: '2026-10-28T05:00:00Z', age_days: 0, accounts: [] },
  days: [{ date: '2026-10-28', opening: 100000, inflow: 0, outflow: 0, closing: 100000, lowest: true }],
  weeks: [{ iso_week: '2026-W44', start: '2026-10-26', end: '2026-11-01', opening: 100000, inflow: 0, outflow: 0, closing: 100000, min_closing: 100000, lowest: true }],
  lowest: { date: '2026-10-28', closing: 100000, iso_week: '2026-W44' },
  closing: 100000,
  flows: [],
  overdue: { receivables: { total: 0, invoices: [] }, payables: { total: 0, invoices: [] } },
  complete: true,
  caveats: [],
}

const request = (url: string) => new Request(url, { headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } })

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, apiKeyId: 'ak_1', scopes: ['reports:read'], mode: 'live' })
  buildMock.mockResolvedValue(FORECAST)
})

describe('GET /api/v1/companies/:companyId/cash-forecast', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(createTableMockSupabase({}).supabase)
    expect((await GET(request(BASE), { params: Promise.resolve({ companyId: COMPANY_ID }) })).status).toBe(401)
    expect(buildMock).not.toHaveBeenCalled()
  })

  it('403 without reports:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['forecast:write'], mode: 'live' })
    mockServiceClient.mockReturnValue(createTableMockSupabase({ company_members: MEMBER }).supabase)
    expect((await GET(request(BASE), { params: Promise.resolve({ companyId: COMPANY_ID }) })).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for more than 26 weeks', async () => {
    mockServiceClient.mockReturnValue(createTableMockSupabase({ company_members: MEMBER }).supabase)
    const res = await GET(request(`${BASE}?weeks=27`), { params: Promise.resolve({ companyId: COMPANY_ID }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 for a company the key holds no membership in', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(createTableMockSupabase({ company_members: { data: null, error: null } }).supabase)
    const res = await GET(request(BASE.replace(COMPANY_ID, OTHER_COMPANY)), { params: Promise.resolve({ companyId: OTHER_COMPANY }) })
    expect(res.status).toBe(404)
    expect(buildMock).not.toHaveBeenCalled()
  })

  it('answers the forecast for the key\'s company, read-only for a viewer too', async () => {
    mockServiceClient.mockReturnValue(createTableMockSupabase({ company_members: MEMBER }).supabase)
    const res = await GET(request(`${BASE}?weeks=8`), { params: Promise.resolve({ companyId: COMPANY_ID }) })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ currency: 'SEK', closing: 100000, lowest: { iso_week: '2026-W44' } })
    expect(buildMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, { weeks: 8 })
  })

  it('500 CASH_FORECAST_FAILED when the forecast cannot be built', async () => {
    mockServiceClient.mockReturnValue(createTableMockSupabase({ company_members: MEMBER }).supabase)
    buildMock.mockRejectedValue(new Error('cash accounts read failed'))
    const res = await GET(request(BASE), { params: Promise.resolve({ companyId: COMPANY_ID }) })
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('CASH_FORECAST_FAILED')
  })
})
