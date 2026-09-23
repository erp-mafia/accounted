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
import { eventBus } from '@/lib/events/bus'
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
  eventBus.clear()
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

// #2185: a date in the call names the year. Before, the tools defaulted to
// the most recent period and then rejected the date, so every question about
// an earlier year failed unless the model had first looked up that year's
// UUID. Now a from_date / as_of_date without period_id resolves the period
// that contains it.
describe('report period resolved from a date when period_id is absent (#2185)', () => {
  const PERIOD_2023 = {
    id: 'fp-2023',
    name: '2023',
    period_start: '2023-01-01',
    period_end: '2023-12-31',
  }

  it('income statement: from_date/to_date in an earlier year run against that year', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_2023, error: null }) // the period containing from_date
    mockIncomeStatement.mockResolvedValueOnce({ net_result: 7 } as never)

    const result = (await incomeStatement.execute(
      { from_date: '2023-01-01', to_date: '2023-12-31' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { period_name: string; period: { start: string; end: string } }

    expect(mockIncomeStatement).toHaveBeenCalledWith(supabase, 'company-1', 'fp-2023', {
      fromDate: '2023-01-01',
      toDate: '2023-12-31',
    })
    expect(result.period).toEqual({ start: '2023-01-01', end: '2023-12-31' })
    // Scoped to the company and bounded by the date, not "most recent".
    expect(findCalls('fiscal_periods', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(findCalls('fiscal_periods', 'lte')).toContainEqual(['period_start', '2023-01-01'])
    expect(findCalls('fiscal_periods', 'gte')).toContainEqual(['period_end', '2023-01-01'])
  })

  it('income statement: to_date alone is enough to name the year', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_2023, error: null })
    mockIncomeStatement.mockResolvedValueOnce({ net_result: 7 } as never)

    await incomeStatement.execute({ to_date: '2023-06-30' }, 'company-1', 'user-1', supabase as never)

    expect(mockIncomeStatement).toHaveBeenCalledWith(supabase, 'company-1', 'fp-2023', {
      fromDate: undefined,
      toDate: '2023-06-30',
    })
  })

  it('income statement: a date no period covers names the span the company has', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // no containing period
    enqueue({
      data: [
        { period_start: '2023-01-01', period_end: '2023-12-31' },
        { period_start: '2026-01-01', period_end: '2026-12-31' },
      ],
      error: null,
    }) // the span

    await expect(
      incomeStatement.execute({ from_date: '2019-06-30' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(
      /No fiscal period contains 2019-06-30: the company's fiscal periods span 2023-01-01 to 2026-12-31/,
    )
    expect(mockIncomeStatement).not.toHaveBeenCalled()
  })

  it('income statement: a range that spans two years is still refused, with the resolved year named', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_2023, error: null })

    await expect(
      incomeStatement.execute(
        { from_date: '2023-07-01', to_date: '2024-06-30' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/to_date must be within the fiscal period \(2023-01-01 to 2023-12-31\)/)
    expect(mockIncomeStatement).not.toHaveBeenCalled()
  })

  it('income statement: without any date the most recent period is still the default', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'fp-1' }, error: null }) // most recent lookup
    enqueue({ data: PERIOD_ROW, error: null }) // scoped re-read
    mockIncomeStatement.mockResolvedValueOnce({ net_result: 1 } as never)

    await incomeStatement.execute({}, 'company-1', 'user-1', supabase as never)

    expect(mockIncomeStatement).toHaveBeenCalledWith(supabase, 'company-1', 'fp-1', {
      fromDate: undefined,
      toDate: undefined,
    })
  })

  it('income statement: an explicit period_id wins over the date', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null })
    mockIncomeStatement.mockResolvedValueOnce({ net_result: 1 } as never)

    await incomeStatement.execute(
      { period_id: 'fp-1', to_date: '2026-03-31' },
      'company-1',
      'user-1',
      supabase as never,
    )

    expect(mockIncomeStatement).toHaveBeenCalledWith(supabase, 'company-1', 'fp-1', {
      fromDate: undefined,
      toDate: '2026-03-31',
    })
    expect(findCalls('fiscal_periods', 'lte')).toEqual([])
  })

  it('balance sheet: as_of_date in an earlier year runs against that year', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_2023, error: null })
    mockBalanceSheet.mockResolvedValueOnce({ total_assets: 0, total_equity_liabilities: 0 } as never)

    const result = (await balanceSheet.execute(
      { as_of_date: '2023-12-31' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { period_name: string; period: { start: string; end: string } }

    expect(mockBalanceSheet).toHaveBeenCalledWith(supabase, 'company-1', 'fp-2023', {
      toDate: '2023-12-31',
    })
    expect(result.period_name).toBe('2023')
    expect(result.period).toEqual({ start: '2023-01-01', end: '2023-12-31' })
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
