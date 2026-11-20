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
  generateGeneralLedgerArrangedPage: vi.fn(),
}))

import { generateGeneralLedgerAccountPage, generateGeneralLedgerArrangedPage } from '@/lib/reports/general-ledger'
import { GET } from '../route'

const mockPage = vi.mocked(generateGeneralLedgerAccountPage)
const mockArranged = vi.mocked(generateGeneralLedgerArrangedPage)
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

  describe('without sort, search or offset: the ledger page, as before', () => {
    it('reads the first page with exactly the arguments it always had, and answers it unchanged', async () => {
      enqueue({ data: PERIOD })
      const page = {
        lines: [
          {
            date: '2026-06-01', voucher_series: 'A', voucher_number: 12, journal_entry_id: 'e1',
            description: 'Hyra', source_type: 'manual', debit: 0, credit: 8000, balance: 2000,
          },
        ],
        next: { date: '2026-06-01', voucher_number: 12, line_id: LINE_ID },
      }
      mockPage.mockResolvedValue(page)
      const res = await GET(request({ period_id: 'period-1', account: '1930' }), noParams)
      const { status, body } = await parseJsonResponse(res)

      expect(status).toBe(200)
      // The whole body, not a subset: nothing is added to the default answer.
      expect(body).toEqual({ data: page })
      expect(mockPage).toHaveBeenCalledTimes(1)
      expect(mockPage).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', '1930', {
        dimensions: undefined,
        fromDate: undefined,
        toDate: undefined,
        after: undefined,
      })
      expect(mockArranged).not.toHaveBeenCalled()
    })

    it('reads an empty sort, search or offset as none', async () => {
      enqueue({ data: PERIOD })
      mockPage.mockResolvedValue({ lines: [], next: null })
      const res = await GET(request({ period_id: 'period-1', account: '1930', sort: '', search: '   ', offset: '' }), noParams)

      expect(res.status).toBe(200)
      expect(mockPage).toHaveBeenCalledTimes(1)
      expect(mockArranged).not.toHaveBeenCalled()
    })
  })

  describe('with sort, search or offset: the arranged page', () => {
    const arrangedPage = { lines: [], line_count: 0, next_offset: null, matched: null }

    it('returns 400 for a sort it does not know', async () => {
      for (const sort of ['balance_asc', 'date', 'date_up', 'date_asc,voucher_asc', "date_asc' or 1=1"]) {
        const res = await GET(request({ period_id: 'period-1', account: '1930', sort }), noParams)
        expect(res.status, sort).toBe(400)
      }
      expect(mockArranged).not.toHaveBeenCalled()
      expect(mockPage).not.toHaveBeenCalled()
    })

    it('returns 400 for a search past 200 characters', async () => {
      const res = await GET(request({ period_id: 'period-1', account: '1930', search: 'a'.repeat(201) }), noParams)
      expect(res.status).toBe(400)
      expect(mockArranged).not.toHaveBeenCalled()
    })

    it('returns 400 for an offset that is not a whole number from zero', async () => {
      for (const offset of ['-1', '1.5', 'ten', '12345678']) {
        const res = await GET(request({ period_id: 'period-1', account: '1930', sort: 'date_desc', offset }), noParams)
        expect(res.status, offset).toBe(400)
      }
      expect(mockArranged).not.toHaveBeenCalled()
    })

    it('returns 400 for a ledger cursor next to a sort or a search', async () => {
      const cursor = { after_date: '2026-06-01', after_voucher: '12', after_line: LINE_ID }
      const arrangements: Array<Record<string, string>> = [{ sort: 'date_desc' }, { search: 'hyra' }, { offset: '500' }]
      for (const arrangement of arrangements) {
        const res = await GET(request({ period_id: 'period-1', account: '1930', ...cursor, ...arrangement }), noParams)
        expect(res.status).toBe(400)
      }
      expect(mockArranged).not.toHaveBeenCalled()
      expect(mockPage).not.toHaveBeenCalled()
    })

    it('returns 404 when the period is not the company\'s', async () => {
      enqueue({ data: null })
      const res = await GET(request({ period_id: 'other', account: '1930', sort: 'date_desc' }), noParams)
      expect(res.status).toBe(404)
      expect(mockArranged).not.toHaveBeenCalled()
    })

    it('arranges the account in the window, under the filter, from the offset', async () => {
      enqueue({ data: PERIOD })
      const page = {
        lines: [
          {
            date: '2026-06-01', voucher_series: 'A', voucher_number: 71, journal_entry_id: 'e1',
            description: 'Hyra', source_type: 'manual', debit: 0, credit: 12500, balance: 2000,
          },
        ],
        line_count: 501,
        next_offset: null,
        matched: { debit: 0, credit: 6262500 },
      }
      mockArranged.mockResolvedValue(page)
      const res = await GET(
        request({
          period_id: 'period-1', account: '1930', from_date: '2026-06-01', to_date: '2026-06-30',
          dim_no: '1', dim_code: 'KS01', sort: 'credit_desc', search: ' 12 500 kr ', offset: '500',
        }),
        noParams,
      )
      const { status, body } = await parseJsonResponse<{ data: typeof page }>(res)

      expect(status).toBe(200)
      expect(body.data).toEqual(page)
      expect(mockArranged).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', '1930', {
        dimensions: { '1': 'KS01' },
        fromDate: '2026-06-01',
        toDate: '2026-06-30',
        sort: { column: 'credit', ascending: false },
        search: '12 500 kr',
        offset: 500,
      })
      expect(mockPage).not.toHaveBeenCalled()
    })

    it('takes a sort alone, a search alone and an offset alone', async () => {
      const cases: Array<[Record<string, string>, Record<string, unknown>]> = [
        [{ sort: 'date_desc' }, { sort: { column: 'date', ascending: false }, search: null, offset: 0 }],
        [{ search: 'A71' }, { sort: null, search: 'A71', offset: 0 }],
        [{ offset: '500' }, { sort: null, search: null, offset: 500 }],
      ]
      for (const [params, expected] of cases) {
        vi.clearAllMocks()
        reset()
        requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
        enqueue({ data: PERIOD })
        mockArranged.mockResolvedValue(arrangedPage)
        const res = await GET(request({ period_id: 'period-1', account: '1930', ...params }), noParams)

        expect(res.status).toBe(200)
        expect(mockArranged).toHaveBeenCalledWith(
          supabase, 'company-1', 'period-1', '1930', expect.objectContaining(expected),
        )
      }
    })

    it('returns 500 with the generic report error when the account cannot be read', async () => {
      enqueue({ data: PERIOD })
      mockArranged.mockRejectedValue(new Error('get_general_ledger_account_page failed'))
      const res = await GET(request({ period_id: 'period-1', account: '1930', search: 'hyra' }), noParams)
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
      expect(status).toBe(500)
      expect(body.error.code).toBe('REPORT_GENERATION_FAILED')
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
