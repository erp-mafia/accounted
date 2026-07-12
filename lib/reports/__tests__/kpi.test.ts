import { describe, it, expect } from 'vitest'
import {
  calculateGrossMargin,
  calculateCashPosition,
  calculateRevenueGrowth,
  calculateExpenseRatio,
  calculateAvgPaymentDays,
  calculateVatLiability,
} from '../kpi'
import { VAT_INPUT_ACCOUNTS, VAT_OUTPUT_ACCOUNTS } from '../vat-declaration'
import type { IncomeStatementReport, TrialBalanceRow } from '@/types'

function makeIncomeStatement(
  overrides: Partial<IncomeStatementReport> = {}
): IncomeStatementReport {
  return {
    revenue_sections: [],
    total_revenue: 100000,
    expense_sections: [],
    total_expenses: 60000,
    financial_sections: [],
    total_financial: 0,
    net_result: 40000,
    period: { start: '2025-01-01', end: '2025-12-31' },
    ...overrides,
  }
}

function makeTrialBalanceRow(
  overrides: Partial<TrialBalanceRow> = {}
): TrialBalanceRow {
  return {
    account_number: '1930',
    account_name: 'Företagskonto',
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

describe('calculateGrossMargin', () => {
  it('returns margin when revenue and COGS exist', () => {
    const stmt = makeIncomeStatement({
      total_revenue: 200000,
      expense_sections: [
        {
          title: 'Varor och material',
          rows: [{ account_number: '4010', account_name: 'Inköp', amount: 80000 }],
          subtotal: 80000,
        },
        {
          title: 'Lokalkostnader',
          rows: [{ account_number: '5010', account_name: 'Hyra', amount: 20000 }],
          subtotal: 20000,
        },
      ],
    })
    // (200000 - 80000) / 200000 * 100 = 60%
    expect(calculateGrossMargin(stmt)).toBe(60)
  })

  it('returns null when total_revenue is 0', () => {
    const stmt = makeIncomeStatement({ total_revenue: 0 })
    expect(calculateGrossMargin(stmt)).toBeNull()
  })

  it('returns 100% when no class 4 expenses', () => {
    const stmt = makeIncomeStatement({
      total_revenue: 50000,
      expense_sections: [
        {
          title: 'Lokalkostnader',
          rows: [{ account_number: '5010', account_name: 'Hyra', amount: 10000 }],
          subtotal: 10000,
        },
      ],
    })
    expect(calculateGrossMargin(stmt)).toBe(100)
  })
})

describe('calculateCashPosition', () => {
  it('sums closing balances for 19xx accounts', () => {
    const rows = [
      makeTrialBalanceRow({ account_number: '1930', closing_debit: 50000, closing_credit: 0 }),
      makeTrialBalanceRow({ account_number: '1931', closing_debit: 10000, closing_credit: 0 }),
      makeTrialBalanceRow({ account_number: '1510', closing_debit: 25000, closing_credit: 0 }),
    ]
    // Only 1930 + 1931 = 60000
    expect(calculateCashPosition(rows)).toBe(60000)
  })

  it('returns 0 for empty rows', () => {
    expect(calculateCashPosition([])).toBe(0)
  })

  it('handles credit balances on 19xx accounts', () => {
    const rows = [
      makeTrialBalanceRow({ account_number: '1930', closing_debit: 0, closing_credit: 5000 }),
    ]
    expect(calculateCashPosition(rows)).toBe(-5000)
  })
})

describe('calculateVatLiability', () => {
  it('returns positive liability for standard output VAT', () => {
    const rows = [
      makeTrialBalanceRow({ account_number: '2611', closing_credit: 25000 }),
      makeTrialBalanceRow({ account_number: '2641', closing_debit: 10000 }),
    ]
    expect(calculateVatLiability(rows)).toBe(15000)
  })

  it('nets EU reverse charge (2614 + 2645) to zero: issue #715', () => {
    const rows = [
      makeTrialBalanceRow({ account_number: '2614', closing_credit: 2500 }),
      makeTrialBalanceRow({ account_number: '2645', closing_debit: 2500 }),
    ]
    expect(calculateVatLiability(rows)).toBe(0)
  })

  it('nets domestic reverse charge (2614 + 2647) to zero', () => {
    const rows = [
      makeTrialBalanceRow({ account_number: '2614', closing_credit: 1200 }),
      makeTrialBalanceRow({ account_number: '2647', closing_debit: 1200 }),
    ]
    expect(calculateVatLiability(rows)).toBe(0)
  })

  it('nets import VAT (2615 + 2645) to zero', () => {
    const rows = [
      makeTrialBalanceRow({ account_number: '2615', closing_credit: 800 }),
      makeTrialBalanceRow({ account_number: '2645', closing_debit: 800 }),
    ]
    expect(calculateVatLiability(rows)).toBe(0)
  })

  it('reverse charge does not distort the net position alongside regular sales', () => {
    const rows = [
      makeTrialBalanceRow({ account_number: '2611', closing_credit: 5000 }),
      makeTrialBalanceRow({ account_number: '2641', closing_debit: 2000 }),
      makeTrialBalanceRow({ account_number: '2614', closing_credit: 1000 }),
      makeTrialBalanceRow({ account_number: '2645', closing_debit: 1000 }),
    ]
    // Old formula gave 5000 − (2000 + 1000) = 2000; correct is 3000
    expect(calculateVatLiability(rows)).toBe(3000)
  })

  it('returns negative for net VAT receivable', () => {
    const rows = [
      makeTrialBalanceRow({ account_number: '2611', closing_credit: 1000 }),
      makeTrialBalanceRow({ account_number: '2641', closing_debit: 4000 }),
    ]
    expect(calculateVatLiability(rows)).toBe(-3000)
  })

  it('ignores accounts outside the VAT declaration set', () => {
    const rows = [
      makeTrialBalanceRow({ account_number: '2650', closing_credit: 9000 }), // redovisningskonto för moms
      makeTrialBalanceRow({ account_number: '1930', closing_debit: 9000 }),
    ]
    expect(calculateVatLiability(rows)).toBe(0)
  })

  it('respects account overrides, splitting input/output on the 264x prefix', () => {
    const rows = [
      makeTrialBalanceRow({ account_number: '2611', closing_credit: 5000 }),
      makeTrialBalanceRow({ account_number: '2614', closing_credit: 1000 }),
      makeTrialBalanceRow({ account_number: '2641', closing_debit: 2000 }),
    ]
    // Override excludes 2614
    expect(calculateVatLiability(rows, ['2611', '2641'])).toBe(3000)
  })

  it('handles debit balances on output accounts (corrections)', () => {
    const rows = [
      makeTrialBalanceRow({ account_number: '2611', closing_credit: 5000, closing_debit: 500 }),
    ]
    expect(calculateVatLiability(rows)).toBe(4500)
  })
})

describe('VAT widget account lists (derived from ACCOUNT_RUTA)', () => {
  // Drift guard: an ACCOUNT_RUTA change that alters these lists changes the
  // dashboard widget's semantics: update this snapshot deliberately.
  it('output accounts cover rutor 10-12, 30-32 and 60-62', () => {
    expect([...VAT_OUTPUT_ACCOUNTS].sort()).toEqual([
      '2610', '2611', '2612', '2613', '2614', '2615', '2616', '2618',
      '2620', '2621', '2622', '2623', '2624', '2625', '2626', '2628',
      '2630', '2631', '2632', '2633', '2634', '2635', '2636', '2638',
    ])
  })

  it('input accounts cover ruta 48', () => {
    expect([...VAT_INPUT_ACCOUNTS].sort()).toEqual([
      '2640', '2641', '2642', '2645', '2646', '2647', '2649',
    ])
  })

  it('the prefix split used by calculateVatLiability is exact for the defaults', () => {
    for (const account of VAT_OUTPUT_ACCOUNTS) {
      expect(account.startsWith('26')).toBe(true)
      expect(account.startsWith('264')).toBe(false)
    }
    for (const account of VAT_INPUT_ACCOUNTS) {
      expect(account.startsWith('264')).toBe(true)
    }
  })
})

describe('calculateRevenueGrowth', () => {
  it('returns positive growth', () => {
    // (120000 - 100000) / 100000 * 100 = 20%
    expect(calculateRevenueGrowth(120000, 100000)).toBe(20)
  })

  it('returns negative growth (decline)', () => {
    // (80000 - 100000) / 100000 * 100 = -20%
    expect(calculateRevenueGrowth(80000, 100000)).toBe(-20)
  })

  it('returns null when previous revenue is null', () => {
    expect(calculateRevenueGrowth(100000, null)).toBeNull()
  })

  it('returns null when previous revenue is 0', () => {
    expect(calculateRevenueGrowth(100000, 0)).toBeNull()
  })
})

describe('calculateExpenseRatio', () => {
  it('returns ratio for normal data', () => {
    const stmt = makeIncomeStatement({ total_revenue: 200000, total_expenses: 120000 })
    // 120000 / 200000 * 100 = 60%
    expect(calculateExpenseRatio(stmt)).toBe(60)
  })

  it('returns null when total_revenue is 0', () => {
    const stmt = makeIncomeStatement({ total_revenue: 0, total_expenses: 5000 })
    expect(calculateExpenseRatio(stmt)).toBeNull()
  })
})

describe('calculateAvgPaymentDays', () => {
  it('returns average for >= 5 invoices', () => {
    const invoices = [
      { invoice_date: '2025-01-01', paid_at: '2025-01-11' }, // 10 days
      { invoice_date: '2025-02-01', paid_at: '2025-02-21' }, // 20 days
      { invoice_date: '2025-03-01', paid_at: '2025-03-16' }, // 15 days
      { invoice_date: '2025-04-01', paid_at: '2025-04-26' }, // 25 days
      { invoice_date: '2025-05-01', paid_at: '2025-05-31' }, // 30 days
    ]
    // avg = (10+20+15+25+30) / 5 = 20
    expect(calculateAvgPaymentDays(invoices)).toBe(20)
  })

  it('returns null for fewer than 5 invoices', () => {
    const invoices = [
      { invoice_date: '2025-01-01', paid_at: '2025-01-11' },
      { invoice_date: '2025-02-01', paid_at: '2025-02-21' },
    ]
    expect(calculateAvgPaymentDays(invoices)).toBeNull()
  })

  it('returns null for empty array', () => {
    expect(calculateAvgPaymentDays([])).toBeNull()
  })

  it('clamps negative days to 0', () => {
    const invoices = [
      { invoice_date: '2025-01-10', paid_at: '2025-01-05' }, // would be -5, clamped to 0
      { invoice_date: '2025-02-01', paid_at: '2025-02-11' }, // 10
      { invoice_date: '2025-03-01', paid_at: '2025-03-11' }, // 10
      { invoice_date: '2025-04-01', paid_at: '2025-04-11' }, // 10
      { invoice_date: '2025-05-01', paid_at: '2025-05-11' }, // 10
    ]
    // avg = (0+10+10+10+10) / 5 = 8
    expect(calculateAvgPaymentDays(invoices)).toBe(8)
  })
})
