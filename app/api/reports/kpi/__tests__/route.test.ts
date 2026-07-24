import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { KPIReport } from '@/types'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// Legacy generators are mocked as spies: the no-dimension hot path must never
// call them, the dimension path must still route through them. The pure
// builders (buildIncomeStatementFromRows, assembleMonthlyBreakdown) stay real
// so the happy path asserts the full KPI JSON end to end.
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))
vi.mock('@/lib/reports/ar-ledger', () => ({
  generateARLedger: vi.fn(),
}))
vi.mock('@/lib/reports/income-statement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports/income-statement')>()
  return { ...actual, generateIncomeStatement: vi.fn() }
})
vi.mock('@/lib/reports/monthly-breakdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports/monthly-breakdown')>()
  return { ...actual, generateMonthlyBreakdown: vi.fn() }
})

import { GET } from '../route'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'

const mockTrialBalance = vi.mocked(generateTrialBalance)
const mockARLedger = vi.mocked(generateARLedger)
const mockIncomeStatement = vi.mocked(generateIncomeStatement)
const mockMonthlyBreakdown = vi.mocked(generateMonthlyBreakdown)

const noParams = { params: Promise.resolve({}) }

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

function makePeriod(overrides: Record<string, unknown> = {}) {
  return {
    id: 'period-1',
    company_id: 'company-1',
    period_start: '2026-01-01',
    period_end: '2026-03-31',
    is_closed: false,
    opening_balance_entry_id: null,
    ...overrides,
  }
}

/** Wire payload as returned by the get_kpi_report_aggregates RPC. */
function aggPayload() {
  return {
    tb: [
      { account_number: '1930', debit: 12500, credit: 0 },
      { account_number: '2611', debit: 0, credit: 2500 },
      { account_number: '3001', debit: 0, credit: 10000 },
      { account_number: '5010', debit: 3000, credit: 0 },
    ],
    tb_ex_year_end: [
      { account_number: '1930', debit: 12500, credit: 0 },
      { account_number: '2611', debit: 0, credit: 2500 },
      { account_number: '3001', debit: 0, credit: 10000 },
      { account_number: '5010', debit: 3000, credit: 0 },
    ],
    ob: [],
    monthly: [
      { year: 2026, month: 1, income: 10000, expenses: 0 },
      { year: 2026, month: 2, income: 0, expenses: 3000 },
    ],
  }
}

const CHART = [
  { account_number: '1930', account_name: 'Företagskonto', account_class: 1 },
  { account_number: '3001', account_name: 'Försäljning 25%', account_class: 3 },
  { account_number: '5010', account_name: 'Lokalhyra', account_class: 5 },
]

const PAID_INVOICES = Array.from({ length: 5 }, () => ({
  invoice_date: '2026-01-01',
  paid_at: '2026-01-11',
}))

const SUPPLIER_ROWS = [
  { supplier_id: 'sup-1', total_sek: 400, total: 400, supplier: { id: 'sup-1', name: 'Leverantören AB' } },
  { supplier_id: 'sup-1', total_sek: 100, total: 100, supplier: { id: 'sup-1', name: 'Leverantören AB' } },
  { supplier_id: 'sup-2', total_sek: 200, total: 200, supplier: { id: 'sup-2', name: 'Andra AB' } },
]

function kpiRequest(searchParams: Record<string, string> = { period_id: 'period-1' }) {
  return createMockRequest('/api/reports/kpi', { searchParams })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  authed()
  mockARLedger.mockResolvedValue({ total_outstanding: 1500, total_overdue: 500 } as never)
})

describe('GET /api/reports/kpi', () => {
  it('returns 401 when not authenticated', async () => {
    unauthed()
    const res = await GET(kpiRequest(), noParams)
    expect(res.status).toBe(401)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when period_id is missing', async () => {
    const res = await GET(kpiRequest({}), noParams)
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unknown fiscal period', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const res = await GET(kpiRequest(), noParams)
    expect(res.status).toBe(404)
  })

  it('returns 400 for a half-provided dimension pair', async () => {
    enqueue({ data: makePeriod() })
    const res = await GET(kpiRequest({ period_id: 'period-1', dim_no: '6' }), noParams)
    expect(res.status).toBe(400)
  })

  it('happy path: builds the full KPI report from one aggregate round trip', async () => {
    enqueue({ data: makePeriod() }) // fiscal_periods
    enqueue({ data: aggPayload() }) // rpc get_kpi_report_aggregates
    enqueue({ data: [{ account_number: '1930', debit: 5000, credit: 0 }] }) // rpc compute_prior_opening_balances
    enqueue({ data: CHART }) // chart_of_accounts
    enqueue({ data: null }) // extension_data prefs (no row)
    enqueue({ data: PAID_INVOICES }) // invoices
    enqueue({ data: SUPPLIER_ROWS }) // supplier_invoices

    const res = await GET(kpiRequest(), noParams)
    const { status, body } = await parseJsonResponse<{ data: KPIReport }>(res)

    expect(status).toBe(200)
    expect(body.data).toEqual({
      netResult: 7000,
      cashPosition: 17500, // 5000 IB + 12500 period debit on 1930
      outstandingReceivables: 1500,
      overdueReceivables: 500,
      vatLiability: 2500,
      totalRevenue: 10000,
      totalExpenses: 3000,
      grossMargin: 100,
      expenseRatio: 30,
      avgPaymentDays: 10,
      periodComplete: false,
      months: [
        { label: 'Jan', income: 10000, expenses: 0, net: 10000 },
        { label: 'Feb', income: 0, expenses: 3000, net: -3000 },
        { label: 'Mar', income: 0, expenses: 0, net: 0 },
      ],
      period: { start: '2026-01-01', end: '2026-03-31' },
      expenseComposition: { class4: 0, class5: 3000, class6: 0, class7: 0 },
      topExpenseAccounts: [
        { account_number: '5010', account_name: 'Lokalhyra', total: 3000 },
      ],
      topSuppliers: [
        { supplier_id: 'sup-1', supplier_name: 'Leverantören AB', total: 500 },
        { supplier_id: 'sup-2', supplier_name: 'Andra AB', total: 200 },
      ],
    })

    expect(supabase.rpc).toHaveBeenCalledWith('get_kpi_report_aggregates', {
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
      p_ob_entry_id: null,
    })
    expect(supabase.rpc).toHaveBeenCalledWith('compute_prior_opening_balances', {
      p_company_id: 'company-1',
      p_period_start: '2026-01-01',
    })
    // The hot path must not touch the legacy line-scanning generators.
    expect(mockTrialBalance).not.toHaveBeenCalled()
    expect(mockIncomeStatement).not.toHaveBeenCalled()
    expect(mockMonthlyBreakdown).not.toHaveBeenCalled()
  })

  it('skips the prior-balance RPC when the period has an opening balance entry', async () => {
    enqueue({ data: makePeriod({ opening_balance_entry_id: 'ob-1' }) }) // fiscal_periods
    enqueue({
      data: {
        ...aggPayload(),
        ob: [
          { account_number: '1930', debit: 5000, credit: 0 },
          { account_number: '2081', debit: 0, credit: 5000 },
        ],
      },
    }) // rpc get_kpi_report_aggregates (no prior RPC follows)
    enqueue({ data: CHART }) // chart_of_accounts
    enqueue({ data: null }) // extension_data prefs
    enqueue({ data: [] }) // invoices
    enqueue({ data: [] }) // supplier_invoices

    const res = await GET(kpiRequest(), noParams)
    const { status, body } = await parseJsonResponse<{ data: KPIReport }>(res)

    expect(status).toBe(200)
    expect(body.data.cashPosition).toBe(17500) // OB 5000 + period 12500 on 1930
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('get_kpi_report_aggregates', {
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
      p_ob_entry_id: 'ob-1',
    })
  })

  it('dimension-filtered path still uses the legacy generators and never the RPC', async () => {
    enqueue({ data: makePeriod() }) // fiscal_periods
    enqueue({ data: null }) // extension_data prefs
    enqueue({ data: [] }) // invoices
    enqueue({ data: [] }) // supplier_invoices

    mockIncomeStatement.mockResolvedValue({
      revenue_sections: [],
      total_revenue: 0,
      expense_sections: [],
      total_expenses: 0,
      financial_sections: [],
      total_financial: 0,
      net_result: 0,
      period: { start: '', end: '' },
    })
    mockTrialBalance.mockResolvedValue({
      rows: [],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    mockMonthlyBreakdown.mockResolvedValue({ months: [] })

    const res = await GET(
      kpiRequest({ period_id: 'period-1', dim_no: '6', dim_code: 'P001' }),
      noParams
    )
    expect(res.status).toBe(200)

    const dimensions = { '6': 'P001' }
    expect(mockIncomeStatement).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', {
      dimensions,
    })
    expect(mockMonthlyBreakdown).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', {
      dimensions,
    })
    // Unfiltered TB for balance-side KPIs + dimension-scoped TB for the
    // expense composition.
    expect(mockTrialBalance).toHaveBeenCalledTimes(2)
    expect(mockTrialBalance).toHaveBeenNthCalledWith(1, supabase, 'company-1', 'period-1')
    expect(mockTrialBalance).toHaveBeenNthCalledWith(2, supabase, 'company-1', 'period-1', {
      dimensions,
    })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 500 when the aggregates RPC fails', async () => {
    enqueue({ data: makePeriod() }) // fiscal_periods
    enqueue({ data: null, error: { message: 'connection reset' } }) // rpc get_kpi_report_aggregates

    const res = await GET(kpiRequest(), noParams)
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error).toBeDefined()
  })
})
