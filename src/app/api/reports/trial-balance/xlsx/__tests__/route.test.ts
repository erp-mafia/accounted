import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createQueuedMockSupabase, createMockRequest } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// The export holds the SIE read lease; its own tests cover that boundary.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
}))

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { GET } from '../route'

const mockGenerate = vi.mocked(generateTrialBalance)
const noParams = { params: Promise.resolve({}) }
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }

function request(searchParams: Record<string, string>) {
  return createMockRequest('/api/reports/trial-balance/xlsx', { searchParams })
}

function report() {
  return {
    rows: [
      {
        account_number: '1931',
        account_name: 'Betalkonto',
        account_class: 1,
        opening_debit: 0,
        opening_credit: 0,
        period_debit: 181.51,
        period_credit: 0,
        closing_debit: 181.51,
        closing_credit: 0,
      },
    ],
    totalDebit: 181.51,
    totalCredit: 0,
    isBalanced: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/reports/trial-balance/xlsx', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(request({ period_id: 'period-1' }), noParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 when period_id is missing', async () => {
    const res = await GET(request({}), noParams)
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 400 when the period cannot be read', async () => {
    enqueue({ data: null }) // fiscal_periods
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings

    const res = await GET(request({ period_id: 'missing' }), noParams)
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 400 when the range reaches outside the räkenskapsår', async () => {
    enqueue({ data: PERIOD })
    enqueue({ data: { company_name: 'Test AB' } })

    const res = await GET(request({ period_id: 'period-1', to_date: '2027-01-31' }), noParams)
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('exports the range on screen and names the file after its last day', async () => {
    enqueue({ data: PERIOD })
    enqueue({ data: { company_name: 'Test AB' } })
    mockGenerate.mockResolvedValue(report())

    const res = await GET(
      request({ period_id: 'period-1', from_date: '2026-06-01', to_date: '2026-06-30' }),
      noParams,
    )
    expect(res.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', {
      closingEntry: 'include',
      fromDate: '2026-06-01',
      toDate: '2026-06-30',
    })
    expect(res.headers.get('content-disposition')).toContain('20260630')

    const workbook = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, blankrows: false })
    expect(rows[1]).toEqual(['1931', 'Betalkonto', 1, 0, 0, 181.51, 0, 181.51, 0])
  })

  it('names the file after the period end when no range is given', async () => {
    enqueue({ data: PERIOD })
    enqueue({ data: { company_name: 'Test AB' } })
    mockGenerate.mockResolvedValue(report())

    const res = await GET(request({ period_id: 'period-1' }), noParams)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('20261231')
  })
})
