import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { generateResultatrapport, shiftDateOneYearBack } from '../resultatrapport'
import { generateTrialBalance } from '../trial-balance'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { TrialBalanceRow } from '@/types'

const mockTrialBalance = vi.mocked(generateTrialBalance)

beforeEach(() => {
  vi.clearAllMocks()
})

function makeRow(overrides: Partial<TrialBalanceRow>): TrialBalanceRow {
  const row: TrialBalanceRow = {
    account_number: '3001',
    account_name: 'Test',
    account_class: 3,
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: 0,
    closing_credit: 0,
    ...overrides,
  }
  // Full-period P&L reality: no opening balance, so window activity equals
  // closing. Tests specify closing_*; mirror into period_* unless the test
  // sets period activity explicitly.
  if (row.period_debit === 0 && row.period_credit === 0) {
    row.period_debit = row.closing_debit
    row.period_credit = row.closing_credit
  }
  return row
}

function tb(rows: TrialBalanceRow[]) {
  const totalDebit = rows.reduce((s, r) => s + r.closing_debit, 0)
  const totalCredit = rows.reduce((s, r) => s + r.closing_credit, 0)
  return {
    rows,
    totalDebit: Math.round(totalDebit * 100) / 100,
    totalCredit: Math.round(totalCredit * 100) / 100,
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
  }
}

describe('generateResultatrapport', () => {
  it('groups P&L accounts by class with current and prior period values', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '3001', account_name: 'Försäljning 25%', account_class: 3, closing_credit: 100000 }),
        makeRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, closing_debit: 30000 }),
        makeRow({ account_number: '7210', account_name: 'Löner', account_class: 7, closing_debit: 50000 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups).toHaveLength(3)
    expect(report.groups.map((g) => g.class)).toEqual([3, 5, 7])
    expect(report.groups[0].rows[0]).toEqual({
      account_number: '3001',
      account_name: 'Försäljning 25%',
      current_period: 100000,
      prior_period: 0,
    })
    // Expense rows shown as negative (credit - debit)
    expect(report.groups[1].rows[0].current_period).toBe(-30000)
    expect(report.groups[2].rows[0].current_period).toBe(-50000)

    // Net result = revenue - expenses = 100000 - 30000 - 50000 = 20000
    expect(report.net_result_current).toBe(20000)
    expect(report.net_result_prior).toBe(0)
    expect(report.prior_period).toBeNull()
  })

  it('joins prior-period values onto current accounts', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: 'period-0' },
      error: null,
    })
    q.enqueue({
      data: { period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })

    mockTrialBalance
      .mockResolvedValueOnce(
        tb([
          makeRow({ account_number: '3001', account_name: 'Försäljning', account_class: 3, closing_credit: 200000 }),
          makeRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, closing_debit: 60000 }),
        ])
      )
      .mockResolvedValueOnce(
        tb([
          makeRow({ account_number: '3001', account_name: 'Försäljning', account_class: 3, closing_credit: 150000 }),
          makeRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, closing_debit: 45000 }),
        ])
      )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    const revenueRow = report.groups[0].rows[0]
    expect(revenueRow.current_period).toBe(200000)
    expect(revenueRow.prior_period).toBe(150000)

    const expenseRow = report.groups[1].rows[0]
    expect(expenseRow.current_period).toBe(-60000)
    expect(expenseRow.prior_period).toBe(-45000)

    expect(report.net_result_current).toBe(140000)
    expect(report.net_result_prior).toBe(105000)
    expect(report.prior_period).toEqual({ start: '2025-01-01', end: '2025-12-31' })
  })

  it('includes accounts that exist only in prior period (with current=0)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: 'period-0' },
      error: null,
    })
    q.enqueue({
      data: { period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })

    mockTrialBalance
      .mockResolvedValueOnce(
        tb([
          makeRow({ account_number: '3001', account_name: 'Försäljning', account_class: 3, closing_credit: 100000 }),
        ])
      )
      .mockResolvedValueOnce(
        tb([
          makeRow({ account_number: '3001', account_name: 'Försäljning', account_class: 3, closing_credit: 80000 }),
          // Account discontinued this year
          makeRow({ account_number: '3002', account_name: 'Gammal intäkt', account_class: 3, closing_credit: 5000 }),
        ])
      )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    const class3 = report.groups.find((g) => g.class === 3)!
    expect(class3.rows).toHaveLength(2)
    const discontinued = class3.rows.find((r) => r.account_number === '3002')!
    expect(discontinued.current_period).toBe(0)
    expect(discontinued.prior_period).toBe(5000)
  })

  it('excludes account 8999 (year-end closing account)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 100000 }),
        makeRow({ account_number: '8999', account_name: 'Årets resultat', account_class: 8, closing_debit: 100000 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    const class8 = report.groups.find((g) => g.class === 8)
    expect(class8).toBeUndefined()
    expect(report.net_result_current).toBe(100000)
  })

  it('ignores balance accounts (class 1-2)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 50000 }),
        makeRow({ account_number: '2440', account_name: 'Lev.skuld', account_class: 2, closing_credit: 10000 }),
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 40000 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups).toHaveLength(1)
    expect(report.groups[0].class).toBe(3)
  })

  it('drops rows where both current and prior are zero', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 50000 }),
        makeRow({ account_number: '3002', account_name: 'Tom rad', account_class: 3, closing_credit: 0 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups[0].rows).toHaveLength(1)
    expect(report.groups[0].rows[0].account_number).toBe('3001')
  })

  it('falls back to the date-adjacent prior period when previous_period_id is null', async () => {
    // Reproduces the multi-year-SIE bug: the continuity chain was never linked,
    // so the comparison must resolve the prior year by date instead.
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null },
      error: null,
    })
    // Date-range fallback finds the immediately-preceding period.
    q.enqueue({ data: [{ id: 'period-0' }], error: null })
    // Prior-period dates.
    q.enqueue({ data: { period_start: '2025-01-01', period_end: '2025-12-31' }, error: null })

    mockTrialBalance
      .mockResolvedValueOnce(
        tb([makeRow({ account_number: '3001', account_class: 3, closing_credit: 200000 })])
      )
      .mockResolvedValueOnce(
        tb([makeRow({ account_number: '3001', account_class: 3, closing_credit: 150000 })])
      )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups[0].rows[0].current_period).toBe(200000)
    expect(report.groups[0].rows[0].prior_period).toBe(150000)
    expect(report.prior_period).toEqual({ start: '2025-01-01', end: '2025-12-31' })
    // The fallback resolved 'period-0' and the prior TB was fetched for it.
    expect(mockTrialBalance).toHaveBeenNthCalledWith(2, expect.anything(), 'company-1', 'period-0')
  })

  it('leaves the prior column empty when there is no earlier period at all', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null },
      error: null,
    })
    q.enqueue({ data: [], error: null }) // no date-adjacent predecessor

    mockTrialBalance.mockResolvedValueOnce(
      tb([makeRow({ account_number: '3001', account_class: 3, closing_credit: 100000 })])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.prior_period).toBeNull()
    expect(report.net_result_prior).toBe(0)
    expect(mockTrialBalance).toHaveBeenCalledTimes(1)
  })

  it('throws when fiscal period not found', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: null, error: null })

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generateResultatrapport(q.supabase as any, 'company-1', 'missing')
    ).rejects.toThrow('Fiscal period not found')
  })

  it('compares a date range against the same window shifted one year back', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: 'period-0' },
      error: null,
    })
    // Fiscal periods covering the shifted window 2025-01-01..2025-03-31.
    q.enqueue({
      data: [{ id: 'period-0', period_start: '2025-01-01', period_end: '2025-12-31' }],
      error: null,
    })

    mockTrialBalance
      .mockResolvedValueOnce(
        tb([makeRow({ account_number: '3001', account_class: 3, closing_credit: 90000 })])
      )
      .mockResolvedValueOnce(
        tb([makeRow({ account_number: '3001', account_class: 3, closing_credit: 60000 })])
      )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1', {
      fromDate: '2026-01-01',
      toDate: '2026-03-31',
    })

    expect(report.groups[0].rows[0].current_period).toBe(90000)
    expect(report.groups[0].rows[0].prior_period).toBe(60000)
    expect(report.prior_period).toEqual({ start: '2025-01-01', end: '2025-03-31' })
    expect(mockTrialBalance).toHaveBeenNthCalledWith(2, expect.anything(), 'company-1', 'period-0', {
      fromDate: '2025-01-01',
      toDate: '2025-03-31',
    })
  })

  it('merges the shifted window across two fiscal periods (brutet räkenskapsår)', async () => {
    const q = createQueuedMockSupabase()
    // Current period: brutet räkenskapsår Jul 2025 - Jun 2026; window is the
    // calendar Q1 2026, so the shifted window Jan-Mar 2025 spans FY 24/25
    // only. Use a window that straddles instead: Jun-Jul 2026 shifted to
    // Jun-Jul 2025, split across FY 24/25 (ends Jun 30) and FY 25/26.
    q.enqueue({
      data: { period_start: '2025-07-01', period_end: '2026-06-30', previous_period_id: 'period-0' },
      error: null,
    })
    q.enqueue({
      data: [
        { id: 'period-old', period_start: '2024-07-01', period_end: '2025-06-30' },
        { id: 'period-1', period_start: '2025-07-01', period_end: '2026-06-30' },
      ],
      error: null,
    })

    mockTrialBalance
      // Current window
      .mockResolvedValueOnce(
        tb([makeRow({ account_number: '3001', account_class: 3, closing_credit: 50000 })])
      )
      // Prior part 1: 2025-06-01..2025-06-30 in period-old
      .mockResolvedValueOnce(
        tb([makeRow({ account_number: '3001', account_class: 3, closing_credit: 10000 })])
      )
      // Prior part 2: 2025-07-01..2025-07-31 in period-1 (current period is a
      // legitimate source when the shifted window reaches into it)
      .mockResolvedValueOnce(
        tb([makeRow({ account_number: '3001', account_class: 3, closing_credit: 15000 })])
      )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1', {
      fromDate: '2026-06-01',
      toDate: '2026-07-31',
    })

    expect(report.groups[0].rows[0].prior_period).toBe(25000)
    expect(report.prior_period).toEqual({ start: '2025-06-01', end: '2025-07-31' })
    expect(mockTrialBalance).toHaveBeenNthCalledWith(2, expect.anything(), 'company-1', 'period-old', {
      fromDate: '2025-06-01',
      toDate: '2025-06-30',
    })
    expect(mockTrialBalance).toHaveBeenNthCalledWith(3, expect.anything(), 'company-1', 'period-1', {
      fromDate: '2025-07-01',
      toDate: '2025-07-31',
    })
  })

  it('drops the comparison when the shifted window would overlap the current one', async () => {
    const q = createQueuedMockSupabase()
    // 18-month fiscal period with a 14-month window: shifting back one year
    // overlaps the window itself, so no comparison is possible.
    q.enqueue({
      data: { period_start: '2025-01-01', period_end: '2026-06-30', previous_period_id: null },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([makeRow({ account_number: '3001', account_class: 3, closing_credit: 100000 })])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1', {
      fromDate: '2025-01-01',
      toDate: '2026-02-28',
    })

    expect(report.prior_period).toBeNull()
    expect(mockTrialBalance).toHaveBeenCalledTimes(1)
  })

  it('still drops the comparison for dimension-filtered ranges', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: 'period-0' },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([makeRow({ account_number: '3001', account_class: 3, closing_credit: 100000 })])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1', {
      fromDate: '2026-01-01',
      toDate: '2026-03-31',
      dimensions: { '6': 'P001' },
    })

    expect(report.prior_period).toBeNull()
    expect(mockTrialBalance).toHaveBeenCalledTimes(1)
  })

  it('reports window activity, not rolled-forward YTD closing', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null },
      error: null,
    })
    q.enqueue({ data: [], error: null }) // no fiscal period covers the shifted window

    // A June window: trial balance rolls Jan-May (60 000) into opening, so
    // closing shows 100 000 YTD while the window's own activity is 40 000.
    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({
          account_number: '3001',
          account_class: 3,
          opening_credit: 60000,
          period_credit: 40000,
          closing_credit: 100000,
        }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateResultatrapport(q.supabase as any, 'company-1', 'period-1', {
      fromDate: '2026-06-01',
      toDate: '2026-06-30',
    })

    expect(report.groups[0].rows[0].current_period).toBe(40000)
    expect(report.net_result_current).toBe(40000)
  })
})

describe('shiftDateOneYearBack', () => {
  it('shifts a plain date one year back', () => {
    expect(shiftDateOneYearBack('2026-03-15')).toBe('2025-03-15')
    expect(shiftDateOneYearBack('2026-01-01')).toBe('2025-01-01')
    expect(shiftDateOneYearBack('2026-12-31')).toBe('2025-12-31')
  })

  it('clamps leap day to the last day of February', () => {
    expect(shiftDateOneYearBack('2028-02-29')).toBe('2027-02-28')
  })

  it('keeps Feb 29 when the target year is also a leap year divisible correctly', () => {
    // 2001 -> 2000 is a leap year (divisible by 400)
    expect(shiftDateOneYearBack('2001-02-28')).toBe('2000-02-28')
  })
})
