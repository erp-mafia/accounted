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

vi.mock('@/lib/reports/balance-sheet', () => ({
  generateBalanceSheet: vi.fn(),
}))

// The data status reads its own tables (lib/reports/__tests__/data-status.test.ts);
// mocked so its reads do not draw from the queued client.
vi.mock('@/lib/reports/data-status', () => ({ buildReportDataStatus: vi.fn() }))

import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { buildReportDataStatus, type ReportDataStatus } from '@/lib/reports/data-status'
import { GET } from '../route'

const mockGenerate = vi.mocked(generateBalanceSheet)
const mockDataStatus = vi.mocked(buildReportDataStatus)
const noParams = { params: Promise.resolve({}) }
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }

function report() {
  return {
    asset_sections: [],
    equity_liability_sections: [],
    total_assets: 5000,
    total_equity_liabilities: 5000,
    period: { start: '2026-01-01', end: '2026-12-31' },
  } as unknown as Awaited<ReturnType<typeof generateBalanceSheet>>
}

const DATA_STATUS: ReportDataStatus = {
  computed_at: '2026-07-01T09:00:00.000Z',
  range: { from: '2026-01-01', to: '2026-06-30' },
  period: { period_id: 'period-1', name: '2026', status: 'open', lock_date: null },
  accounting_method: 'accrual',
  unbooked_transactions: 2,
  draft_entries: 0,
  bank: { feed_status: 'stopped', last_sync_at: '2026-05-20T06:00:00Z', stale: true, reconciled_through: null },
  preliminary: true,
  caveats: [],
}

function request(searchParams: Record<string, string>) {
  return createMockRequest('/api/reports/balance-sheet', { searchParams })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  mockDataStatus.mockResolvedValue(DATA_STATUS)
})

describe('GET /api/reports/balance-sheet', () => {
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

  it('returns 400 when from_date is after to_date', async () => {
    enqueue({ data: PERIOD })
    const res = await GET(
      request({ period_id: 'period-1', from_date: '2026-07-01', to_date: '2026-06-30' }),
      noParams,
    )
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockDataStatus).not.toHaveBeenCalled()
  })

  it('returns the report with the data status from the period start to to_date, built once', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockResolvedValue(report())

    const res = await GET(
      request({ period_id: 'period-1', from_date: '2026-04-01', to_date: '2026-06-30' }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{
      data: { total_assets: number }
      data_status: ReportDataStatus
    }>(res)

    expect(status).toBe(200)
    expect(body.data.total_assets).toBe(5000)
    expect(body.data_status).toEqual(DATA_STATUS)
    expect(mockDataStatus).toHaveBeenCalledTimes(1)
    // The balances at to_date carry every row from the period start: the same
    // call the MCP balance sheet makes for this date.
    expect(mockDataStatus).toHaveBeenCalledWith(supabase, 'company-1', {
      periodId: 'period-1',
      toDate: '2026-06-30',
    })
  })

  it('returns the data status over the whole räkenskapsår when no range is given', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockResolvedValue(report())

    const res = await GET(request({ period_id: 'period-1' }), noParams)
    const { status, body } = await parseJsonResponse<{ data_status: ReportDataStatus }>(res)
    expect(status).toBe(200)
    expect(body.data_status).toEqual(DATA_STATUS)
    expect(mockDataStatus).toHaveBeenCalledWith(supabase, 'company-1', { periodId: 'period-1' })
  })

  it('still answers with the report when the data status could not be read', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockResolvedValue(report())
    mockDataStatus.mockResolvedValue({ unavailable: true, reason: 'bank connection read failed' })

    const res = await GET(request({ period_id: 'period-1' }), noParams)
    const { status, body } = await parseJsonResponse<{ data: { total_assets: number }; data_status: unknown }>(res)
    expect(status).toBe(200)
    expect(body.data.total_assets).toBe(5000)
    expect(body.data_status).toEqual({ unavailable: true, reason: 'bank connection read failed' })
  })

  it('returns 500 when the generator fails', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockRejectedValue(new Error('boom'))

    const res = await GET(request({ period_id: 'period-1' }), noParams)
    expect(res.status).toBe(500)
  })
})
