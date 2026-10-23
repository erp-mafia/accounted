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
  generateGeneralLedgerAccountPage: vi.fn(),
}))

import { generateGeneralLedgerAccountPage } from '@/lib/reports/general-ledger'
import { GET } from '../route'

const mockPage = vi.mocked(generateGeneralLedgerAccountPage)
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }
const noParams = { params: Promise.resolve({}) }
const LINE_ID = '00000000-0000-4000-8000-000000000042'

function request(searchParams: Record<string, string>) {
  return createMockRequest('/api/reports/general-ledger/lines', { searchParams })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/reports/general-ledger/lines', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(request({ period_id: 'period-1', account: '1930' }), noParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 without a period or a four-digit account', async () => {
    const cases: Array<Record<string, string>> = [{ account: '1930' }, { period_id: 'period-1' }, { period_id: 'period-1', account: "1930' or 1=1" }]
    for (const params of cases) {
      const res = await GET(request(params), noParams)
      expect(res.status).toBe(400)
    }
    expect(mockPage).not.toHaveBeenCalled()
  })

  it('returns 400 for a partial or malformed cursor', async () => {
    const cursors: Array<Record<string, string>> = [
      { after_date: '2026-06-01' },
      { after_date: '2026-06-01', after_voucher: '12', after_line: 'not-a-uuid' },
      { after_date: '1 June', after_voucher: '12', after_line: LINE_ID },
      { after_date: '2026-06-01', after_voucher: '-1', after_line: LINE_ID },
    ]
    for (const cursor of cursors) {
      const res = await GET(request({ period_id: 'period-1', account: '1930', ...cursor }), noParams)
      expect(res.status).toBe(400)
    }
    expect(mockPage).not.toHaveBeenCalled()
  })

  it('returns 404 when the period is not the company\'s', async () => {
    enqueue({ data: null })
    const res = await GET(request({ period_id: 'other', account: '1930' }), noParams)
    expect(res.status).toBe(404)
    expect(mockPage).not.toHaveBeenCalled()
  })

  it('reads the page after the cursor, in the window, under the filter', async () => {
    enqueue({ data: PERIOD })
    const page = { lines: [], next: null }
    mockPage.mockResolvedValue(page)
    const res = await GET(
      request({
        period_id: 'period-1', account: '1930', from_date: '2026-06-01', to_date: '2026-06-30',
        dim_no: '1', dim_code: 'KS01', after_date: '2026-06-03', after_voucher: '12', after_line: LINE_ID,
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{ data: typeof page }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual(page)
    expect(mockPage).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', '1930', {
      dimensions: { '1': 'KS01' },
      fromDate: '2026-06-01',
      toDate: '2026-06-30',
      after: { date: '2026-06-03', voucher_number: 12, line_id: LINE_ID },
    })
  })

  it('returns 500 with the generic report error when the page fails', async () => {
    enqueue({ data: PERIOD })
    mockPage.mockRejectedValue(new Error('get_general_ledger_account_page failed'))
    const res = await GET(request({ period_id: 'period-1', account: '1930' }), noParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(500)
    expect(body.error.code).toBe('REPORT_GENERATION_FAILED')
  })
})
