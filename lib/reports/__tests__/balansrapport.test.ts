import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { generateBalansrapport } from '../balansrapport'
import { generateTrialBalance } from '../trial-balance'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { TrialBalanceRow } from '@/types'

const mockTrialBalance = vi.mocked(generateTrialBalance)

beforeEach(() => {
  vi.clearAllMocks()
})

function makeRow(overrides: Partial<TrialBalanceRow>): TrialBalanceRow {
  return {
    account_number: '1930',
    account_name: 'Bank',
    account_class: 1,
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: 0,
    closing_credit: 0,
    ...overrides,
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
      ib: 50000,
      ub: 75000,
      period_change: 25000,
    })
    expect(assets.subtotal_ib).toBe(60000)
    expect(assets.subtotal_ub).toBe(87500)

    // Equity & liabilities: debit-negative (Fortnox/Visma convention)
    const equity = report.groups[1]
    expect(equity.rows[0]).toEqual({
      account_number: '2099',
      account_name: 'Årets resultat',
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
      ib: 10000,
      ub: 0,
      period_change: -10000,
    })
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
})
