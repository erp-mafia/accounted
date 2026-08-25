/**
 * Custom date-range args on the report tools:
 * gnubok_get_income_statement (from_date/to_date) and
 * gnubok_get_balance_sheet (as_of_date). The generators are mocked; under
 * test is the MCP layer: validation (format, inside-period, ordering), the
 * options handoff, the effective-period echo, and the unknown-arg rejection
 * that replaces the old silent ignoring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { tools } from '../server'

vi.mock('@/lib/reports/income-statement', () => ({ generateIncomeStatement: vi.fn() }))
vi.mock('@/lib/reports/balance-sheet', () => ({ generateBalanceSheet: vi.fn() }))

const incomeStatement = tools.find((t) => t.name === 'gnubok_get_income_statement')!
const balanceSheet = tools.find((t) => t.name === 'gnubok_get_balance_sheet')!

const mockIncomeStatement = vi.mocked(generateIncomeStatement)
const mockBalanceSheet = vi.mocked(generateBalanceSheet)

const PERIOD_ROW = {
  id: 'fp-1',
  name: '2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_get_income_statement: from_date/to_date', () => {
  it('passes the range to the generator and echoes the effective window', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null }) // period info
    mockIncomeStatement.mockResolvedValueOnce({ net_result: 42 } as never)

    const result = (await incomeStatement.execute(
      { period_id: 'fp-1', from_date: '2026-01-01', to_date: '2026-07-31' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { period: { start: string; end: string } }

    expect(mockIncomeStatement).toHaveBeenCalledWith(supabase, 'company-1', 'fp-1', {
      fromDate: '2026-01-01',
      toDate: '2026-07-31',
    })
    expect(result.period).toEqual({ start: '2026-01-01', end: '2026-07-31' })
  })

  it('rejects a malformed from_date instead of silently ignoring it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null })

    await expect(
      incomeStatement.execute(
        { period_id: 'fp-1', from_date: '31/07/2026' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/from_date must be an ISO date/)
    expect(mockIncomeStatement).not.toHaveBeenCalled()
  })

  it('rejects a range outside the fiscal period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null })

    await expect(
      incomeStatement.execute(
        { period_id: 'fp-1', to_date: '2027-01-31' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/within the fiscal period/)
    expect(mockIncomeStatement).not.toHaveBeenCalled()
  })

  it('rejects from_date after to_date', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null })

    await expect(
      incomeStatement.execute(
        { period_id: 'fp-1', from_date: '2026-08-01', to_date: '2026-07-01' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/must not be after/)
    expect(mockIncomeStatement).not.toHaveBeenCalled()
  })

  it('rejects unknown args instead of silently ignoring them', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null })

    await expect(
      incomeStatement.execute(
        { period_id: 'fp-1', fromdate: '2026-01-01' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Unknown parameter\(s\): fromdate/)
    expect(mockIncomeStatement).not.toHaveBeenCalled()
  })
})

describe('gnubok_get_balance_sheet: as_of_date', () => {
  it('maps as_of_date to the generator toDate and echoes the effective window', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null }) // period info (most-recent lookup skipped: period_id given)
    mockBalanceSheet.mockResolvedValueOnce({ total_assets: 0, total_equity_liabilities: 0 } as never)

    const result = (await balanceSheet.execute(
      { period_id: 'fp-1', as_of_date: '2026-07-31' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { period: { start: string; end: string } }

    expect(mockBalanceSheet).toHaveBeenCalledWith(supabase, 'company-1', 'fp-1', {
      toDate: '2026-07-31',
    })
    expect(result.period).toEqual({ start: '2026-01-01', end: '2026-07-31' })
  })

  it('rejects an as_of_date outside the fiscal period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null })

    await expect(
      balanceSheet.execute(
        { period_id: 'fp-1', as_of_date: '2025-12-31' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/within the fiscal period/)
    expect(mockBalanceSheet).not.toHaveBeenCalled()
  })

  it('rejects unknown args instead of silently ignoring them', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null })

    await expect(
      balanceSheet.execute(
        { period_id: 'fp-1', to_date: '2026-07-31' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Unknown parameter\(s\): to_date/)
    expect(mockBalanceSheet).not.toHaveBeenCalled()
  })
})
