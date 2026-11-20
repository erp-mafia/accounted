/**
 * GET /api/v1/companies/{companyId}/reports/salary-journal: the route-layer
 * contract (auth, scope, query validation, error path) and that the report's
 * per-category totals reach the caller. The report itself is covered by
 * lib/reports/__tests__/salary-journal.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The shared wrapper's lease boundary has separate real and unit coverage.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
}))

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

vi.mock('@/lib/reports/salary-journal', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reports/salary-journal')>('@/lib/reports/salary-journal')
  return { ...actual, generateSalaryJournal: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { generateSalaryJournal } from '@/lib/reports/salary-journal'
import { createTableMockSupabase } from '@/tests/helpers'
import { GET } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockGenerate = vi.mocked(generateSalaryJournal)

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const URL_BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/reports/salary-journal`

function req(query: string): Request {
  return new Request(`${URL_BASE}${query}`, { headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } })
}

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
    }).supabase,
  )
})

describe('GET /reports/salary-journal', () => {
  it('returns 401 for a key that does not validate', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })

    const res = await GET(req('?year=2026'), params)

    expect(res.status).toBe(401)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 403 INSUFFICIENT_SCOPE without payroll:read', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'wrong scope',
      scopes: ['invoices:read'],
      mode: 'live',
    })

    const res = await GET(req('?year=2026'), params)

    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it('returns 400 VALIDATION_ERROR naming year when it is missing', async () => {
    const res = await GET(req(''), params)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('year')
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR for a month outside 1-12', async () => {
    const res = await GET(req('?year=2026&month_from=13'), params)

    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns the rows with their category and the per-category totals', async () => {
    const groupTotals = [
      {
        group: 'arbetare' as const,
        employeeCount: 2,
        grossSalary: 61000,
        taxWithheld: 14000,
        netSalary: 47000,
        avgifterAmount: 19166.2,
        vacationAccrual: 7320,
        vacationAccrualAvgifter: 2299.94,
        totalEmployerCost: 89786.14,
      },
    ]
    mockGenerate.mockResolvedValue({
      rows: [],
      totals: {
        grossSalary: 61000,
        taxWithheld: 14000,
        netSalary: 47000,
        avgifterAmount: 19166.2,
        vacationAccrual: 7320,
        vacationAccrualAvgifter: 2299.94,
        totalEmployerCost: 89786.14,
      },
      groupTotals,
      period: { year: 2026, monthFrom: 1, monthTo: 6 },
    })

    const res = await GET(req('?year=2026&month_from=1&month_to=6'), params)

    expect(res.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 2026, 1, 6)
    const body = await res.json()
    expect(body.data.groupTotals).toEqual(groupTotals)
  })

  it('answers a generator failure as an error envelope, not a crash', async () => {
    mockGenerate.mockRejectedValue(new Error('boom'))

    const res = await GET(req('?year=2026'), params)

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).error.code).toBeDefined()
  })
})
