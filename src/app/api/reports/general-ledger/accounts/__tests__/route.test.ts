import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/reports/general-ledger', () => ({
  generateGeneralLedgerOverview: vi.fn(),
}))

import { generateGeneralLedgerOverview } from '@/lib/reports/general-ledger'
import { GET } from '../route'

const mockOverview = vi.mocked(generateGeneralLedgerOverview)
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }
const noParams = { params: Promise.resolve({}) }
const OVERVIEW = { accounts: [], period: { start: '2026-01-01', end: '2026-12-31' }, lines_included: true }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/reports/general-ledger/accounts', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/reports/general-ledger/accounts'), noParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 when period_id is missing', async () => {
    const res = await GET(createMockRequest('/api/reports/general-ledger/accounts'), noParams)
    expect(res.status).toBe(400)
    expect(mockOverview).not.toHaveBeenCalled()
  })

  it('returns 400 when the range falls outside the fiscal period', async () => {
    enqueue({ data: PERIOD })
    const res = await GET(
      createMockRequest('/api/reports/general-ledger/accounts', { searchParams: { period_id: 'period-1', from_date: '2025-06-01' } }),
      noParams,
    )
    expect(res.status).toBe(400)
    expect(mockOverview).not.toHaveBeenCalled()
  })

  it('passes the account range, the window and the dimension filter to the overview', async () => {
    enqueue({ data: PERIOD })
    mockOverview.mockResolvedValue(OVERVIEW)
    const res = await GET(
      createMockRequest('/api/reports/general-ledger/accounts', {
        searchParams: {
          period_id: 'period-1', account_from: '1900', account_to: '1999',
          from_date: '2026-06-01', to_date: '2026-06-30', dim_no: '6', dim_code: 'P1',
        },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{ data: typeof OVERVIEW }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual(OVERVIEW)
    expect(mockOverview).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', '1900', '1999', {
      dimensions: { '6': 'P1' }, fromDate: '2026-06-01', toDate: '2026-06-30',
    })
  })

  it('returns 500 with the generic report error when the overview fails', async () => {
    enqueue({ data: PERIOD })
    mockOverview.mockRejectedValue(new Error('get_trial_balance_aggregates failed: relation x'))
    const res = await GET(createMockRequest('/api/reports/general-ledger/accounts', { searchParams: { period_id: 'period-1' } }), noParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(500)
    expect(body.error.code).toBe('REPORT_GENERATION_FAILED')
  })
})
