/**
 * Every report tool an agent reads a figure from returns `data_status` for
 * the same range: the trust signals (open period, unbooked bank rows, drafts,
 * stale bank feed, cash method) that used to live only in separate tools.
 * The generators and the status builder are mocked; under test is that each
 * tool asks for the status over its own effective range and returns it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import { buildReportDataStatus } from '@/lib/reports/data-status'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateGeneralLedger } from '@/lib/reports/general-ledger'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'
import { tools } from '../server'

vi.mock('@/lib/reports/data-status', () => ({ buildReportDataStatus: vi.fn() }))
vi.mock('@/lib/reports/income-statement', () => ({ generateIncomeStatement: vi.fn() }))
vi.mock('@/lib/reports/balance-sheet', () => ({ generateBalanceSheet: vi.fn() }))
vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/reports/general-ledger', () => ({ generateGeneralLedger: vi.fn() }))
vi.mock('@/lib/reports/ar-ledger', () => ({ generateARLedger: vi.fn() }))
vi.mock('@/lib/reports/monthly-breakdown', () => ({ generateMonthlyBreakdown: vi.fn() }))

const tool = (name: string) => tools.find((t) => t.name === name)!

const PERIOD_ROW = { id: 'fp-1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }
const STATUS = {
  computed_at: '2026-09-26T00:00:00.000Z',
  range: { from: '2026-01-01', to: '2026-12-31' },
  period: { period_id: 'fp-1', name: '2026', status: 'open', lock_date: null },
  accounting_method: 'accrual',
  unbooked_transactions: 3,
  draft_entries: 0,
  missing_underlag: 0,
  bank: { last_sync_at: null, reconciled_through: null },
  preliminary: true,
  caveats: ['Period 2026 is open: these figures can still change.'],
}

const INCOME_STATEMENT = {
  revenue: [],
  expenses: [],
  financial: [],
  total_revenue: 0,
  total_expenses: 0,
  total_financial: 0,
  net_result: 0,
  period: { start: '2026-01-01', end: '2026-12-31' },
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  vi.mocked(buildReportDataStatus).mockResolvedValue(STATUS as never)
  vi.mocked(generateIncomeStatement).mockResolvedValue(INCOME_STATEMENT as never)
  vi.mocked(generateBalanceSheet).mockResolvedValue({ total_assets: 0 } as never)
  vi.mocked(generateTrialBalance).mockResolvedValue({ rows: [] } as never)
  vi.mocked(generateGeneralLedger).mockResolvedValue({ accounts: [] } as never)
  vi.mocked(generateARLedger).mockResolvedValue({ total_outstanding: 0, total_overdue: 0 } as never)
  vi.mocked(generateMonthlyBreakdown).mockResolvedValue({ months: [] } as never)
})

async function run(name: string, args: Record<string, unknown>, extraSlots = 0) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: PERIOD_ROW })
  for (let i = 0; i < extraSlots; i += 1) enqueue({ data: [] })
  const result = (await tool(name).execute(args, 'company-1', 'user-1', supabase as never)) as {
    data_status?: unknown
  }
  return { result, supabase }
}

describe('report tools carry data_status', () => {
  it('gnubok_get_income_statement: status over the effective from/to range', async () => {
    const { result, supabase } = await run('gnubok_get_income_statement', {
      period_id: 'fp-1',
      from_date: '2026-03-01',
      to_date: '2026-03-31',
    })
    expect(buildReportDataStatus).toHaveBeenCalledWith(supabase, 'company-1', {
      periodId: 'fp-1',
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
    })
    expect(result.data_status).toEqual(STATUS)
  })

  it('gnubok_get_balance_sheet: status up to as_of_date', async () => {
    const { result, supabase } = await run('gnubok_get_balance_sheet', {
      period_id: 'fp-1',
      as_of_date: '2026-06-30',
    })
    expect(buildReportDataStatus).toHaveBeenCalledWith(supabase, 'company-1', {
      periodId: 'fp-1',
      toDate: '2026-06-30',
    })
    expect(result.data_status).toEqual(STATUS)
  })

  it('gnubok_get_trial_balance: status over the whole period', async () => {
    const { result, supabase } = await run('gnubok_get_trial_balance', { period_id: 'fp-1' })
    expect(buildReportDataStatus).toHaveBeenCalledWith(supabase, 'company-1', { periodId: 'fp-1' })
    expect(result.data_status).toEqual(STATUS)
  })

  it('gnubok_get_kpi_report: status over the whole period', async () => {
    // One extra slot: the paid-invoices read for avg_payment_days.
    const { result, supabase } = await run('gnubok_get_kpi_report', { period_id: 'fp-1' }, 1)
    expect(buildReportDataStatus).toHaveBeenCalledWith(supabase, 'company-1', { periodId: 'fp-1' })
    expect(result.data_status).toEqual(STATUS)
  })

  it('gnubok_get_general_ledger: status over the whole period', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = (await tool('gnubok_get_general_ledger').execute(
      { period_id: 'fp-1' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { data_status?: unknown }
    expect(buildReportDataStatus).toHaveBeenCalledWith(supabase, 'company-1', { periodId: 'fp-1' })
    expect(result.data_status).toEqual(STATUS)
  })

  it('returns the fail-soft marker as-is so the report still answers', async () => {
    vi.mocked(buildReportDataStatus).mockResolvedValueOnce({ unavailable: true, reason: 'boom' })
    const { result } = await run('gnubok_get_trial_balance', { period_id: 'fp-1' })
    expect(result.data_status).toEqual({ unavailable: true, reason: 'boom' })
  })
})
