/**
 * gnubok_get_kpi_report computes from the same inputs as the KPI page:
 * the company's cash/VAT account overrides, receivables as of the report
 * range end (not today) and payment days over payments inside the range.
 * Before, an agent could read a different cash position than the page and
 * last year's report showed today's receivables. Also covers the `metrics`
 * filter that replaces the rejected `metric` calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'
import { tools } from '../server'
import { KPI_METRIC_KEYS } from '../kpi-report'

vi.mock('@/lib/reports/income-statement', () => ({ generateIncomeStatement: vi.fn() }))
vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/reports/ar-ledger', () => ({ generateARLedger: vi.fn() }))
vi.mock('@/lib/reports/monthly-breakdown', () => ({ generateMonthlyBreakdown: vi.fn() }))

const kpiTool = tools.find((t) => t.name === 'gnubok_get_kpi_report')!

const PAST_PERIOD = {
  id: 'fp-2025',
  name: '2025',
  period_start: '2025-01-01',
  period_end: '2025-12-31',
}

const TB_ROWS = [
  { account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 1000, closing_credit: 0 },
  { account_number: '1940', account_name: 'Placeringskonto', account_class: 1, closing_debit: 5000, closing_credit: 0 },
  { account_number: '2611', account_name: 'Utgående moms', account_class: 2, closing_debit: 0, closing_credit: 300 },
  { account_number: '2641', account_name: 'Ingående moms', account_class: 2, closing_debit: 100, closing_credit: 0 },
]

const PAID = Array.from({ length: 5 }, () => ({ invoice_date: '2025-03-01', paid_at: '2025-03-21T00:00:00Z' }))

function mockGenerators() {
  vi.mocked(generateIncomeStatement).mockResolvedValue({
    revenue_sections: [],
    total_revenue: 10000,
    expense_sections: [],
    total_expenses: 4000,
    financial_sections: [],
    total_financial: 0,
    net_result: 6000,
    period: { start: '', end: '' },
  } as never)
  vi.mocked(generateTrialBalance).mockResolvedValue({
    rows: TB_ROWS,
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  } as never)
  vi.mocked(generateARLedger).mockResolvedValue({ total_outstanding: 2500.5, total_overdue: 500 } as never)
  vi.mocked(generateMonthlyBreakdown).mockResolvedValue({ months: [] } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockGenerators()
})

describe('gnubok_get_kpi_report', () => {
  it('honours the cash and VAT account overrides the KPI page uses', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PAST_PERIOD }) // fiscal_periods
    enqueue({
      data: { value: { accountOverrides: { cashPosition: ['1930'], vatLiability: ['2611'] } } },
    }) // extension_data preferences
    enqueue({ data: PAID }) // invoices

    const result = (await kpiTool.execute({ period_id: 'fp-2025' }, 'company-1', 'user-1', supabase as never)) as Record<string, unknown>

    // Override: only 1930, not the 1940 placement account the 19xx default sums.
    expect(result.cash_position).toBe(1000)
    // Override: only 2611 output VAT, no 2641 input VAT offset.
    expect(result.vat_liability).toBe(300)
  })

  it('falls back to 19xx and the ruta 49 accounts without overrides', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PAST_PERIOD })
    enqueue({ data: null }) // no preferences row
    enqueue({ data: [] })

    const result = (await kpiTool.execute({ period_id: 'fp-2025' }, 'company-1', 'user-1', supabase as never)) as Record<string, unknown>

    expect(result.cash_position).toBe(6000)
    expect(result.vat_liability).toBe(200)
  })

  it('measures receivables at the range end of a past period, not today', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PAST_PERIOD })
    enqueue({ data: null })
    enqueue({ data: [] })

    const result = (await kpiTool.execute({ period_id: 'fp-2025' }, 'company-1', 'user-1', supabase as never)) as Record<string, unknown>

    expect(generateARLedger).toHaveBeenCalledWith(supabase, 'company-1', '2025-12-31')
    expect(result.receivables_as_of).toBe('2025-12-31')
    expect(result.outstanding_receivables).toBe(2500.5)
  })

  it('scopes payment days to payments inside the range', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: PAST_PERIOD })
    enqueue({ data: null })
    enqueue({ data: PAID })

    const result = (await kpiTool.execute(
      { period_id: 'fp-2025', from_date: '2025-01-01', to_date: '2025-06-30' },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown>

    expect(findCalls('invoices', 'gte')).toContainEqual(['paid_at', '2025-01-01'])
    expect(findCalls('invoices', 'lt')).toContainEqual(['paid_at', '2025-07-01'])
    expect(result.avg_payment_days).toBe(20)
    expect(result.paid_invoice_count).toBe(5)
    expect(result.range).toEqual({ start: '2025-01-01', end: '2025-06-30' })
    // The range also reaches the balance and result generators.
    expect(generateTrialBalance).toHaveBeenCalledWith(supabase, 'company-1', 'fp-2025', {
      closingEntry: 'include',
      fromDate: '2025-01-01',
      toDate: '2025-06-30',
    })
    expect(generateARLedger).toHaveBeenCalledWith(supabase, 'company-1', '2025-06-30')
  })

  it('returns only the requested metrics plus the period fields', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PAST_PERIOD })
    enqueue({ data: null })
    enqueue({ data: [] })

    const result = (await kpiTool.execute(
      { period_id: 'fp-2025', metrics: ['cash_position', 'net_result'] },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown>

    expect(Object.keys(result).sort()).toEqual(
      ['cash_position', 'net_result', 'period_end', 'period_name', 'period_start', 'range', 'receivables_as_of'].sort(),
    )
    expect(result.net_result).toBe(6000)
  })

  it('rejects an unknown metric name and lists the valid ones', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      kpiTool.execute({ metrics: ['revenue_growth'] }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/Unknown metric\(s\): "revenue_growth"\. Valid: gross_margin/)
    expect(generateIncomeStatement).not.toHaveBeenCalled()
  })

  it('declares every metric name as an output key, so the schema documents the filter', () => {
    const output = kpiTool.outputSchema as { properties: Record<string, unknown> }
    for (const key of KPI_METRIC_KEYS) expect(Object.keys(output.properties)).toContain(key)
  })
})
