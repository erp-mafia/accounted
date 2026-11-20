import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { DimensionPnlReport } from '@/types'

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

vi.mock('@/lib/reports/dimension-pnl', () => ({
  generateDimensionPnl: vi.fn(),
}))

import { generateDimensionPnl } from '@/lib/reports/dimension-pnl'
import { GET } from '../route'
import { GET as GET_XLSX } from '../xlsx/route'

const mockGenerate = vi.mocked(generateDimensionPnl)

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function unauthed() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }
const noParams = { params: Promise.resolve({}) }

const Q3_REPORT: DimensionPnlReport = {
  dimension: { sie_dim_no: '6', name: 'Projekt' },
  columns: [
    { code: 'P100', name: 'Villa Almgren' },
    { code: null, name: null },
  ],
  groups: [
    {
      class: 3,
      class_label: '3 Rörelsens inkomster/intäkter',
      rows: [{ account_number: '3001', account_name: 'Försäljning', values: [400, 100], total: 500 }],
      subtotals: [400, 100],
      subtotal_total: 500,
    },
  ],
  net_per_column: [400, 100],
  net_total: 500,
  period: { start: '2026-07-01', end: '2026-09-30' },
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  authed()
})

describe('GET /api/reports/dimension-pnl', () => {
  it('returns 401 when not authenticated', async () => {
    unauthed()
    const res = await GET(createMockRequest('/api/reports/dimension-pnl'), noParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 when period_id is missing', async () => {
    const res = await GET(createMockRequest('/api/reports/dimension-pnl'), noParams)
    expect(res.status).toBe(400)
  })

  it('returns 400 for a dim_no that is not an SIE dimension number', async () => {
    const res = await GET(
      createMockRequest('/api/reports/dimension-pnl', { searchParams: { period_id: 'period-1', dim_no: '6,is.null' } }),
      noParams,
    )
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 404 when the period is not the company\'s', async () => {
    enqueue({ data: null }) // fiscal_periods
    const res = await GET(
      createMockRequest('/api/reports/dimension-pnl', { searchParams: { period_id: 'period-x' } }),
      noParams,
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 when the window falls outside the period or runs backwards', async () => {
    const windows: Array<Record<string, string>> = [
      { period_id: 'period-1', from_date: '2025-12-01' },
      { period_id: 'period-1', from_date: '2026-09-30', to_date: '2026-07-01' },
    ]
    for (const searchParams of windows) {
      enqueue({ data: PERIOD }) // fiscal_periods
      const res = await GET(createMockRequest('/api/reports/dimension-pnl', { searchParams }), noParams)
      expect(res.status).toBe(400)
    }
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('passes the whole window, from_date included, to the generator', async () => {
    enqueue({ data: PERIOD }) // fiscal_periods
    mockGenerate.mockResolvedValue(Q3_REPORT)

    const res = await GET(
      createMockRequest('/api/reports/dimension-pnl', {
        searchParams: { period_id: 'period-1', dim_no: '6', from_date: '2026-07-01', to_date: '2026-09-30' },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{ data: DimensionPnlReport }>(res)
    expect(status).toBe(200)
    expect(body.data.period).toEqual({ start: '2026-07-01', end: '2026-09-30' })
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', '6', {
      fromDate: '2026-07-01',
      toDate: '2026-09-30',
    })
  })
})

describe('GET /api/reports/dimension-pnl/xlsx', () => {
  it('returns 401 when not authenticated', async () => {
    unauthed()
    const res = await GET_XLSX(createMockRequest('/api/reports/dimension-pnl/xlsx'), noParams)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the period is not the company\'s', async () => {
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    enqueue({ data: null }) // fiscal_periods
    const res = await GET_XLSX(
      createMockRequest('/api/reports/dimension-pnl/xlsx', { searchParams: { period_id: 'period-x' } }),
      noParams,
    )
    expect(res.status).toBe(404)
  })

  it('exports the window it was asked for and states it in the file', async () => {
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    enqueue({ data: PERIOD }) // fiscal_periods
    mockGenerate.mockResolvedValue(Q3_REPORT)

    const res = await GET_XLSX(
      createMockRequest('/api/reports/dimension-pnl/xlsx', {
        searchParams: { period_id: 'period-1', from_date: '2026-07-01', to_date: '2026-09-30' },
      }),
      noParams,
    )
    expect(res.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', '6', {
      fromDate: '2026-07-01',
      toDate: '2026-09-30',
    })

    const workbook = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false })
    expect(rows[0]).toEqual(['Grupp', 'Konto', 'Benämning', 'P100 Villa Almgren', '(Utan dimension)', 'Totalt'])
    expect(rows[1]).toEqual(['Period: 2026-07-01 till 2026-09-30', '', ''])
    expect(rows[2]).toEqual(['3 Rörelsens inkomster/intäkter', '3001', 'Försäljning', 400, 100, 500])
  })
})

describe('the budget view (accounted#134)', () => {
  const BUDGET_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const WITH_BUDGET: DimensionPnlReport = {
    ...Q3_REPORT,
    groups: [
      {
        ...Q3_REPORT.groups[0],
        rows: [{ ...Q3_REPORT.groups[0].rows[0], budget_values: [300, 50], budget_total: 350 }],
        budget_subtotals: [300, 50],
        budget_subtotal_total: 350,
      },
    ],
    budget: { budget_id: BUDGET_ID, name: 'Budget 2026', is_default: true, applied: true, from_month: '2026-07', to_month: '2026-09' },
    budget_net_per_column: [300, 50],
    budget_net_total: 350,
  }

  it('400 for a budget_id that is not an id; the budget reaches the generator', async () => {
    enqueue({ data: PERIOD })
    const bad = await GET(createMockRequest('/api/reports/dimension-pnl', { searchParams: { period_id: 'period-1', budget_id: 'x' } }), noParams)
    expect(bad.status).toBe(400)

    enqueue({ data: PERIOD })
    mockGenerate.mockResolvedValue(WITH_BUDGET)
    const ok = await GET(createMockRequest('/api/reports/dimension-pnl', { searchParams: { period_id: 'period-1', budget_id: BUDGET_ID } }), noParams)
    expect(ok.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', '6', expect.objectContaining({ budgetId: BUDGET_ID }))
  })

  it('exports Utfall, Budget and Avvikelse as three sheets', async () => {
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    enqueue({ data: PERIOD }) // fiscal_periods
    mockGenerate.mockResolvedValue(WITH_BUDGET)
    const res = await GET_XLSX(
      createMockRequest('/api/reports/dimension-pnl/xlsx', { searchParams: { period_id: 'period-1', budget_id: BUDGET_ID } }),
      noParams,
    )
    expect(res.status).toBe(200)
    const workbook = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
    expect(workbook.SheetNames).toEqual(['Utfall', 'Budget', 'Avvikelse'])
    const rowOf = (name: string) =>
      XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, blankrows: false }).find((r) => r[1] === '3001')
    expect(rowOf('Utfall')).toEqual(['3 Rörelsens inkomster/intäkter', '3001', 'Försäljning', 400, 100, 500])
    expect(rowOf('Budget')).toEqual(['3 Rörelsens inkomster/intäkter', '3001', 'Försäljning', 300, 50, 350])
    expect(rowOf('Avvikelse')).toEqual(['3 Rörelsens inkomster/intäkter', '3001', 'Försäljning', 100, 50, 150])
  })
})
