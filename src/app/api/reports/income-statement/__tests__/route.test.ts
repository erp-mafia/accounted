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

vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(),
}))

// The data status reads its own tables (lib/reports/__tests__/data-status.test.ts);
// mocked so its reads do not draw from the queued client.
vi.mock('@/lib/reports/data-status', () => ({ buildReportDataStatus: vi.fn() }))

import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { buildReportDataStatus, type ReportDataStatus } from '@/lib/reports/data-status'
import { GET } from '../route'

const mockGenerate = vi.mocked(generateIncomeStatement)
const mockDataStatus = vi.mocked(buildReportDataStatus)
const noParams = { params: Promise.resolve({}) }
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }

function report() {
  return {
    revenue_sections: [],
    expense_sections: [],
    financial_sections: [],
    total_revenue: 1000,
    total_expenses: 400,
    total_financial: 0,
    net_result: 600,
    period: { start: '2026-01-01', end: '2026-12-31' },
  } as unknown as Awaited<ReturnType<typeof generateIncomeStatement>>
}

const DATA_STATUS: ReportDataStatus = {
  computed_at: '2026-03-15T09:00:00.000Z',
  range: { from: '2026-03-01', to: '2026-03-31' },
  period: { period_id: 'period-1', name: '2026', status: 'open', lock_date: null },
  accounting_method: 'accrual',
  unbooked_transactions: 7,
  draft_entries: 1,
  bank: { feed_status: 'active', last_sync_at: '2026-03-14T06:00:00Z', stale: false, reconciled_through: null },
  preliminary: true,
  caveats: [],
}

function request(searchParams: Record<string, string>) {
  return createMockRequest('/api/reports/income-statement', { searchParams })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  mockDataStatus.mockResolvedValue(DATA_STATUS)
})

describe('GET /api/reports/income-statement', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(request({ period_id: 'period-1' }), noParams)
    expect(res.status).toBe(401)
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockDataStatus).not.toHaveBeenCalled()
  })

  it('returns 400 when period_id is missing', async () => {
    const res = await GET(request({}), noParams)
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockDataStatus).not.toHaveBeenCalled()
  })

  it('returns 400 when the range reaches outside the räkenskapsår', async () => {
    enqueue({ data: PERIOD })
    const res = await GET(
      request({ period_id: 'period-1', from_date: '2025-12-01', to_date: '2026-03-31' }),
      noParams,
    )
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockDataStatus).not.toHaveBeenCalled()
  })

  it('returns 400 when only half of the dimension filter is given', async () => {
    enqueue({ data: PERIOD })
    const res = await GET(request({ period_id: 'period-1', dim_no: '6' }), noParams)
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockDataStatus).not.toHaveBeenCalled()
  })

  it('returns the report with the data status over the same range, built once', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockResolvedValue(report())

    const res = await GET(
      request({ period_id: 'period-1', from_date: '2026-03-01', to_date: '2026-03-31' }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{
      data: { net_result: number; period: { start: string; end: string } }
      data_status: ReportDataStatus
    }>(res)

    expect(status).toBe(200)
    expect(body.data.net_result).toBe(600)
    expect(body.data.period).toEqual({ start: '2026-03-01', end: '2026-03-31' })
    expect(body.data_status).toEqual(DATA_STATUS)
    expect(mockDataStatus).toHaveBeenCalledTimes(1)
    // The same call the MCP income statement makes for this range.
    expect(mockDataStatus).toHaveBeenCalledWith(supabase, 'company-1', {
      periodId: 'period-1',
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
    })
  })

  it('keeps the data status company-wide under a dimension filter', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockResolvedValue(report())

    const res = await GET(request({ period_id: 'period-1', dim_no: '6', dim_code: 'P001' }), noParams)
    expect(res.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', {
      dimensions: { '6': 'P001' },
    })
    expect(mockDataStatus).toHaveBeenCalledWith(supabase, 'company-1', { periodId: 'period-1' })
  })

  it('still answers with the report when the data status could not be read', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockResolvedValue(report())
    mockDataStatus.mockResolvedValue({ unavailable: true, reason: 'bank connection read failed' })

    const res = await GET(request({ period_id: 'period-1' }), noParams)
    const { status, body } = await parseJsonResponse<{ data: { net_result: number }; data_status: unknown }>(res)
    expect(status).toBe(200)
    expect(body.data.net_result).toBe(600)
    expect(body.data_status).toEqual({ unavailable: true, reason: 'bank connection read failed' })
  })

  it('returns 500 when the generator fails', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockRejectedValue(new Error('boom'))

    const res = await GET(request({ period_id: 'period-1' }), noParams)
    expect(res.status).toBe(500)
  })
})
