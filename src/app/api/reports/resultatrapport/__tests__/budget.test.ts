/**
 * The resultatrapport's budget (accounted#134, part 2) through its three
 * doors: the JSON the page reads, the PDF and the xlsx. ?budget_id is the
 * only new input; the generator (tested in lib/reports) does the rest.
 */
import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { createMockRequest, createQueuedMockSupabase } from '@/tests/helpers'
import type { ResultatrapportReport } from '@/types'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
}))
vi.mock('@/lib/reports/resultatrapport', () => ({ generateResultatrapport: vi.fn() }))

import { generateResultatrapport } from '@/lib/reports/resultatrapport'
import { ReportBudgetError } from '@/lib/budgets/report-budget'
import { GET } from '../route'
import { GET as GET_XLSX } from '../xlsx/route'

const mockGenerate = vi.mocked(generateResultatrapport)
const BUDGET_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }
const noParams = { params: Promise.resolve({}) }

const REPORT: ResultatrapportReport = {
  groups: [
    {
      class: 3,
      class_label: '3 Rörelsens inkomster/intäkter',
      rows: [
        {
          account_number: '3001',
          account_name: 'Försäljning',
          current_period: 120000,
          prior_period: 0,
          budget: { budget: 100000, deviation: 20000, deviation_percent: 20 },
        },
      ],
      subtotal_current: 120000,
      subtotal_prior: 0,
      subtotal_budget: { budget: 100000, deviation: 20000, deviation_percent: 20 },
    },
  ],
  net_result_current: 120000,
  net_result_prior: 0,
  period: { start: '2026-01-01', end: '2026-12-31' },
  prior_period: null,
  budget: { budget_id: BUDGET_ID, name: 'Budget 2026', is_default: true, applied: true, from_month: '2026-01', to_month: '2026-12' },
  net_result_budget: { budget: 100000, deviation: 20000, deviation_percent: 20 },
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/reports/resultatrapport?budget_id=', () => {
  it('401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await GET(createMockRequest('/api/reports/resultatrapport', { searchParams: { period_id: 'p1', budget_id: BUDGET_ID } }), noParams)
    expect(res.status).toBe(401)
  })

  it('400 for a budget_id that is not an id', async () => {
    enqueue({ data: PERIOD })
    const res = await GET(createMockRequest('/api/reports/resultatrapport', { searchParams: { period_id: 'p1', budget_id: 'default' } }), noParams)
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('404 BUDGET_NOT_FOUND and 400 BUDGET_OTHER_FISCAL_YEAR from the generator', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockRejectedValueOnce(new ReportBudgetError('BUDGET_NOT_FOUND'))
    const missing = await GET(createMockRequest('/api/reports/resultatrapport', { searchParams: { period_id: 'p1', budget_id: BUDGET_ID } }), noParams)
    expect(missing.status).toBe(404)
    expect((await missing.json()).error.code).toBe('BUDGET_NOT_FOUND')

    enqueue({ data: PERIOD })
    mockGenerate.mockRejectedValueOnce(new ReportBudgetError('BUDGET_OTHER_FISCAL_YEAR'))
    const other = await GET(createMockRequest('/api/reports/resultatrapport', { searchParams: { period_id: 'p1', budget_id: BUDGET_ID } }), noParams)
    expect(other.status).toBe(400)
  })

  it('passes the budget with the window and the filter', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockResolvedValue(REPORT)
    const res = await GET(
      createMockRequest('/api/reports/resultatrapport', {
        searchParams: { period_id: 'p1', budget_id: BUDGET_ID, from_date: '2026-01-01', to_date: '2026-06-30', dim_no: '6', dim_code: 'H1' },
      }),
      noParams,
    )
    expect(res.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 'p1', {
      fromDate: '2026-01-01',
      toDate: '2026-06-30',
      dimensions: { '6': 'H1' },
      budgetId: BUDGET_ID,
    })
  })
})

describe('GET /api/reports/resultatrapport/xlsx?budget_id=', () => {
  it('adds Budget, Avvikelse and Avvikelse % and names the budget', async () => {
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    enqueue({ data: PERIOD }) // fiscal_periods
    mockGenerate.mockResolvedValue(REPORT)
    const res = await GET_XLSX(createMockRequest('/api/reports/resultatrapport/xlsx', { searchParams: { period_id: 'p1', budget_id: BUDGET_ID } }), noParams)
    expect(res.status).toBe(200)
    const book = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
    const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]!]!, { header: 1 })
    expect(rows[0]).toEqual(['Grupp', 'Konto', 'Kontonamn', 'Aktuell period', 'Budget', 'Avvikelse', 'Avvikelse %', 'Föregående period'])
    expect(rows[1]![0]).toBe('Budget Budget 2026: 2026-01 till 2026-12')
    const account = rows.find((r) => r[1] === '3001')!
    // The percent column holds a fraction (Excel's 0.00% format).
    expect(account.slice(3, 8)).toEqual([120000, 100000, 20000, 0.2, 0])
  })
})
