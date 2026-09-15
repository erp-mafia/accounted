import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

vi.mock('../imbalance-diagnosis', () => ({
  findUntransferredResults: vi.fn(),
  buildImbalanceDiagnosis: vi.fn(),
}))

// Mocked rather than fed through the queued Supabase stub: the queue resolves
// in strict call order, so an extra real query inside the engine would shift
// every enqueued response in this file.
vi.mock('../latest-vouchers', () => ({
  getLatestPostedVouchers: vi.fn(),
}))

import { generateBalansrapport } from '../balansrapport'
import { generateTrialBalance } from '../trial-balance'
import { findUntransferredResults, buildImbalanceDiagnosis } from '../imbalance-diagnosis'
import { getLatestPostedVouchers } from '../latest-vouchers'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { TrialBalanceRow } from '@/types'

const mockTrialBalance = vi.mocked(generateTrialBalance)
const mockFindUntransferred = vi.mocked(findUntransferredResults)
const mockBuildDiagnosis = vi.mocked(buildImbalanceDiagnosis)
const mockLatestVouchers = vi.mocked(getLatestPostedVouchers)

beforeEach(() => {
  vi.clearAllMocks()
  mockLatestVouchers.mockResolvedValue([])
})

function makeRow(overrides: Partial<TrialBalanceRow>): TrialBalanceRow {
  const row = {
    account_number: '1930',
    account_name: 'Bank',
    account_class: 1,
    opening_debit: 0,
    opening_credit: 0,
    year_opening_debit: 0,
    year_opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: 0,
    closing_credit: 0,
    ...overrides,
  }
  // Full-period default: with no narrowed window the trial balance rolls
  // nothing forward, so the fiscal-year opening IS the window opening. Tests
  // that narrow the window state year_opening_* explicitly.
  return {
    ...row,
    year_opening_debit: overrides.year_opening_debit ?? row.opening_debit,
    year_opening_credit: overrides.year_opening_credit ?? row.opening_credit,
  }
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

describe('generateBalansrapport', () => {
  it('groups balance accounts into class 1 (assets) and class 2 (equity & liabilities)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({
          account_number: '1930',
          account_name: 'Bank',
          account_class: 1,
          opening_debit: 50000,
          opening_credit: 0,
          closing_debit: 75000,
          closing_credit: 0,
        }),
        makeRow({
          account_number: '1510',
          account_name: 'Kundfordringar',
          account_class: 1,
          opening_debit: 10000,
          opening_credit: 0,
          closing_debit: 12500,
          closing_credit: 0,
        }),
        makeRow({
          account_number: '2440',
          account_name: 'Lev.skulder',
          account_class: 2,
          opening_credit: 8000,
          opening_debit: 0,
          closing_credit: 15000,
          closing_debit: 0,
        }),
        makeRow({
          account_number: '2099',
          account_name: 'Årets resultat',
          account_class: 2,
          opening_credit: 52000,
          opening_debit: 0,
          closing_credit: 72500,
          closing_debit: 0,
        }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups).toHaveLength(2)
    expect(report.groups[0].class).toBe(1)
    expect(report.groups[1].class).toBe(2)

    // Assets sorted by account number
    const assets = report.groups[0]
    expect(assets.rows.map((r) => r.account_number)).toEqual(['1510', '1930'])
    expect(assets.rows[1]).toEqual({
      account_number: '1930',
      account_name: 'Bank',
      year_ib: 50000,
      ib: 50000,
      ub: 75000,
      period_change: 25000,
    })
    expect(assets.subtotal_year_ib).toBe(60000)
    expect(assets.subtotal_ib).toBe(60000)
    expect(assets.subtotal_ub).toBe(87500)

    // Equity & liabilities: debit-negative (Fortnox/Visma convention)
    const equity = report.groups[1]
    expect(equity.rows[0]).toEqual({
      account_number: '2099',
      account_name: 'Årets resultat',
      year_ib: -52000,
      ib: -52000,
      ub: -72500,
      period_change: -20500,
    })
    expect(equity.subtotal_ub).toBe(-87500)

    expect(report.total_assets_ub).toBe(87500)
    expect(report.total_equity_liabilities_ub).toBe(-87500)
    // 2099 already absorbs prior+current result, residual is 0
    expect(report.beraknat_resultat).toBe(0)
    expect(report.is_balanced).toBe(true)
  })

  it('beräknat resultat equals total_assets - total_eq_liab during running year', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })

    // Mid-year, before any 2099 update: assets 80 000, liabs 30 000.
    // P&L (3001 - 5010) = 50 000 sits in P&L accounts and equals the residual.
    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 80000 }),
        makeRow({ account_number: '2440', account_name: 'Lev.skuld', account_class: 2, closing_credit: 30000 }),
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 70000 }),
        makeRow({ account_number: '5010', account_name: 'Rent', account_class: 5, closing_debit: 20000 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.total_assets_ub).toBe(80000)
    expect(report.total_equity_liabilities_ub).toBe(-30000)
    expect(report.beraknat_resultat).toBe(50000)
    // Trial balance still balances: double-entry guarantees this.
    expect(report.is_balanced).toBe(true)
  })

  it('renders class 2 rows with negative sign (god redovisningssed convention)', async () => {
    // Regression test: every Swedish accounting tool (Fortnox, Visma, Bokio,
    // Briox, BL) renders class 2 debit-negative on Balansrapport so that
    // assets + eq_liab = beräknat resultat. Pin this convention.
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({
          account_number: '1930',
          account_name: 'Bank',
          account_class: 1,
          opening_debit: 100000,
          closing_debit: 120000,
        }),
        makeRow({
          account_number: '2440',
          account_name: 'Lev.skulder',
          account_class: 2,
          opening_credit: 40000,
          closing_credit: 50000,
        }),
        makeRow({
          account_number: '2350',
          account_name: 'Banklån',
          account_class: 2,
          opening_credit: 30000,
          closing_credit: 25000,
        }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    const equity = report.groups.find((g) => g.class === 2)!
    // Strict < 0: every fixture row has a nonzero credit balance, so the
    // convention requires every row to be strictly negative.
    expect(equity.rows.every((r) => r.ib < 0)).toBe(true)
    expect(equity.rows.every((r) => r.ub < 0)).toBe(true)
    expect(equity.subtotal_ib).toBeLessThan(0)
    expect(equity.subtotal_ub).toBeLessThan(0)
    expect(report.total_equity_liabilities_ub).toBeLessThan(0)
    // Sum of both sides equals beräknat resultat (here: profit residual)
    expect(report.total_assets_ub + report.total_equity_liabilities_ub).toBe(
      report.beraknat_resultat
    )
  })

  it('is_balanced reflects trial balance balance state', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })

    // Manually construct an unbalanced trial balance (in practice the DB
    // trigger prevents this, but a continuity break or missing IB row would
    // surface here).
    mockTrialBalance.mockResolvedValueOnce({
      rows: [
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 80000 }),
        makeRow({ account_number: '2440', account_name: 'Lev.skuld', account_class: 2, closing_credit: 70000 }),
      ],
      totalDebit: 80000,
      totalCredit: 70000,
      isBalanced: false,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.is_balanced).toBe(false)
  })

  it('attaches imbalance_diagnosis when the trial balance does not balance', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2025-03-01', period_end: '2026-02-28' },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce({
      rows: [
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 1097 }),
        makeRow({ account_number: '2440', account_name: 'Lev.skuld', account_class: 2, closing_credit: 1000 }),
      ],
      totalDebit: 1097,
      totalCredit: 1000,
      isBalanced: false,
    })

    const culprit = {
      fiscal_period_id: 'p2',
      period_name: 'Räkenskapsår 2024/2025',
      pl_net: 97,
    }
    const diagnosis = {
      differens: 97,
      untransferred_results: [culprit],
      message: 'Differensen beror på att resultatet för Räkenskapsår 2024/2025 …',
    }
    mockFindUntransferred.mockResolvedValue([culprit])
    mockBuildDiagnosis.mockReturnValue(diagnosis)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-3')

    expect(mockFindUntransferred).toHaveBeenCalledWith(q.supabase, 'company-1', {
      beforePeriodStart: '2025-03-01',
    })
    expect(mockBuildDiagnosis).toHaveBeenCalledWith([culprit], 97)
    expect(report.imbalance_diagnosis).toEqual(diagnosis)
  })

  it('omits imbalance_diagnosis when the trial balance balances', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 1000 }),
        makeRow({ account_number: '2440', account_name: 'Lev.skuld', account_class: 2, closing_credit: 1000 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.imbalance_diagnosis).toBeUndefined()
    expect(mockFindUntransferred).not.toHaveBeenCalled()
  })

  it('ignores P&L accounts (class 3-8)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 10000 }),
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 50000 }),
        makeRow({ account_number: '5010', account_name: 'Rent', account_class: 5, closing_debit: 8000 }),
        makeRow({ account_number: '8410', account_name: 'Räntekostnad', account_class: 8, closing_debit: 100 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups).toHaveLength(1)
    expect(report.groups[0].class).toBe(1)
    expect(report.groups[0].rows.map((r) => r.account_number)).toEqual(['1930'])
  })

  it('drops accounts where both IB and UB are zero', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 10000 }),
        makeRow({ account_number: '1940', account_name: 'Inactive', account_class: 1 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups[0].rows).toHaveLength(1)
    expect(report.groups[0].rows[0].account_number).toBe('1930')
  })

  it('handles accounts that closed during the period (UB=0, IB>0)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({
          account_number: '1510',
          account_name: 'Kundfordran (betald)',
          account_class: 1,
          opening_debit: 10000,
          period_credit: 10000,
          closing_debit: 10000,
          closing_credit: 10000,
        }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups[0].rows[0]).toEqual({
      account_number: '1510',
      account_name: 'Kundfordran (betald)',
      year_ib: 10000,
      ib: 10000,
      ub: 0,
      period_change: -10000,
    })
  })

  // ── Fiscal-year opening column ───────────────────────────────────
  // Fortnox prints four amount columns: Ing balans (fiscal-year start),
  // Ing saldo (window start), Period, Utg balans. year_ib carries the first.

  it('reports year_ib apart from ib when the window starts after period_start', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({
          account_number: '1930',
          account_name: 'Bank',
          account_class: 1,
          // 40 000 at 2026-01-01, 50 000 by the window start, 75 000 at the end.
          year_opening_debit: 40000,
          opening_debit: 50000,
          closing_debit: 75000,
        }),
      ])
    )

    const report = await generateBalansrapport(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.supabase as any,
      'company-1',
      'period-1',
      { fromDate: '2026-04-01', toDate: '2026-12-31' }
    )

    expect(report.groups[0].rows[0]).toEqual({
      account_number: '1930',
      account_name: 'Bank',
      year_ib: 40000,
      ib: 50000,
      ub: 75000,
      period_change: 25000,
    })
    expect(report.groups[0].subtotal_year_ib).toBe(40000)
    expect(report.groups[0].subtotal_ib).toBe(50000)
    // The window is what `period` reports; `fiscal_year` keeps the räkenskapsår.
    expect(report.period).toEqual({ start: '2026-04-01', end: '2026-12-31' })
    expect(report.fiscal_year).toEqual({ start: '2026-01-01', end: '2026-12-31' })
  })

  it('keeps a row that was settled before the window but has a year IB', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        // Paid off in Q1, so both ib and ub are zero inside a Q2 window. It
        // still opened the year at 10 000 and Fortnox prints that row.
        makeRow({
          account_number: '1510',
          account_name: 'Kundfordran (betald)',
          account_class: 1,
          year_opening_debit: 10000,
          year_opening_credit: 0,
          opening_debit: 10000,
          opening_credit: 10000,
          closing_debit: 10000,
          closing_credit: 10000,
        }),
      ])
    )

    const report = await generateBalansrapport(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.supabase as any,
      'company-1',
      'period-1',
      { fromDate: '2026-04-01', toDate: '2026-06-30' }
    )

    expect(report.groups[0].rows).toHaveLength(1)
    expect(report.groups[0].rows[0]).toEqual({
      account_number: '1510',
      account_name: 'Kundfordran (betald)',
      year_ib: 10000,
      ib: 0,
      ub: 0,
      period_change: 0,
    })
  })

  it('still drops a row that is empty in every column', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 10000 }),
        makeRow({ account_number: '1940', account_name: 'Inactive', account_class: 1 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups[0].rows.map((r) => r.account_number)).toEqual(['1930'])
  })

  it('reports fiscal_year equal to period for a full-period report', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(
      tb([makeRow({ account_number: '1930', account_class: 1, closing_debit: 10000 })])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.fiscal_year).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    expect(report.fiscal_year).toEqual(report.period)
    // No roll-forward, so the two opening columns agree.
    expect(report.groups[0].rows[0].year_ib).toBe(report.groups[0].rows[0].ib)
  })

  it('throws when fiscal period not found', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: null, error: null })

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generateBalansrapport(q.supabase as any, 'company-1', 'missing')
    ).rejects.toThrow('Fiscal period not found')
  })

  it('returns empty groups when there are no balance accounts at all', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: { period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })

    mockTrialBalance.mockResolvedValueOnce(tb([]))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups).toEqual([])
    expect(report.total_assets_ub).toBe(0)
    expect(report.total_equity_liabilities_ub).toBe(0)
    expect(report.beraknat_resultat).toBe(0)
    expect(report.is_balanced).toBe(true)
  })

  describe('latest_vouchers header line', () => {
    function enqueuePeriod(q: ReturnType<typeof createQueuedMockSupabase>) {
      q.enqueue({
        data: { period_start: '2026-01-01', period_end: '2026-12-31' },
        error: null,
      })
      mockTrialBalance.mockResolvedValueOnce(tb([]))
    }

    it('carries the last posted voucher per series', async () => {
      const q = createQueuedMockSupabase()
      enqueuePeriod(q)
      mockLatestVouchers.mockResolvedValueOnce([
        { series: 'A', last_number: 214 },
        { series: 'B', last_number: 37 },
      ])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

      expect(report.latest_vouchers).toEqual([
        { series: 'A', last_number: 214 },
        { series: 'B', last_number: 37 },
      ])
    })

    it('omits the field entirely when the period has no vouchers', async () => {
      const q = createQueuedMockSupabase()
      enqueuePeriod(q)
      mockLatestVouchers.mockResolvedValueOnce([])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

      expect('latest_vouchers' in report).toBe(false)
    })

    it('still returns the report when the lookup fails', async () => {
      const q = createQueuedMockSupabase()
      enqueuePeriod(q)
      mockLatestVouchers.mockRejectedValueOnce(new Error('boom'))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

      expect(report.latest_vouchers).toBeUndefined()
      expect(report.is_balanced).toBe(true)
    })

    it('bounds the window at the as-of date with no lower bound (accumulating report)', async () => {
      const q = createQueuedMockSupabase()
      enqueuePeriod(q)

      await generateBalansrapport(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        q.supabase as any,
        'company-1',
        'period-1',
        { fromDate: '2026-02-01', toDate: '2026-03-31' }
      )

      // fromDate narrows the report's own period label, but a balansrapport
      // accumulates from the fiscal-year start, so the voucher window must not
      // inherit that lower bound.
      expect(mockLatestVouchers).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'period-1',
        { toDate: '2026-03-31' }
      )
    })
  })
})
