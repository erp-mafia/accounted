/**
 * GET /api/v1/companies/{companyId}/reports/avgifter-basis: the route-layer
 * contract (auth, scope, query validation, error path) and that the declared
 * figures reach the caller. The report itself is covered by
 * lib/salary/__tests__/avgifter-basis.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
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

vi.mock('@/lib/salary/avgifter-basis', () => ({ generateAvgifterBasis: vi.fn() }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { generateAvgifterBasis } from '@/lib/salary/avgifter-basis'
import { createTableMockSupabase } from '@/tests/helpers'
import { GET } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockGenerate = vi.mocked(generateAvgifterBasis)

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const URL_BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/reports/avgifter-basis`

const req = (query: string) =>
  new Request(`${URL_BASE}${query}`, { headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } })

const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['payroll:read'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(
    createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      'rpc:acquire_sie_period_read': { data: 'lease-1', error: null },
      'rpc:finish_sie_period_read': { data: null, error: null },
    }).supabase,
  )
})

describe('GET /reports/avgifter-basis', () => {
  it('returns 401 for a key that does not validate', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })

    expect((await GET(req('?year=2026'), params)).status).toBe(401)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 403 for a key without payroll:read', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'CI key',
      scopes: ['bookkeeping:read'],
      mode: 'live',
    })

    expect((await GET(req('?year=2026'), params)).status).toBe(403)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 400 without a valid year', async () => {
    expect((await GET(req(''), params)).status).toBe(400)
    expect((await GET(req('?year=1999'), params)).status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns the declared figures per month and sats', async () => {
    const report = {
      year: 2026,
      rows: [
        { periodYear: 2026, periodMonth: 9, category: 'youth', categoryLabel: 'Ungdomsrabatt (20,81%)', rate: 0.2081, basis: 25000, amount: 5202, employeeCount: 1 },
      ],
      totals: { totalBasis: 25000, totalAmount: 5202, regionalSupportDeduction: 0 },
    }
    mockGenerate.mockResolvedValue(report)

    const res = await GET(req('?year=2026'), params)

    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual(report)
    expect(mockGenerate).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 2026)
  })

  it('answers a report failure with REPORT_GENERATION_FAILED', async () => {
    mockGenerate.mockRejectedValue(new Error('column missing'))

    const res = await GET(req('?year=2026'), params)

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).error.code).toBe('REPORT_GENERATION_FAILED')
  })
})
