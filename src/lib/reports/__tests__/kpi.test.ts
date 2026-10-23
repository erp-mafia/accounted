import { describe, it, expect } from 'vitest'
import { createReskontraClient, type ReskontraTables } from '@/tests/reskontra-rpc-port'
import {
  calculateGrossMargin,
  calculateCashPosition,
  calculateExpenseRatio,
  averagePaymentDays,
  calculateVatLiability,
  fetchTopSupplierInvoices,
  fetchPaymentDaysInRange,
  kpiReceivablesAsOf,
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

  it('uses the account override instead of 19xx when one is set', () => {
    const rows = [
      makeTrialBalanceRow({ account_number: '1930', closing_debit: 50000 }),
      makeTrialBalanceRow({ account_number: '1940', closing_debit: 10000 }),
      makeTrialBalanceRow({ account_number: '1680', closing_debit: 700 }),
    ]
    expect(calculateCashPosition(rows, ['1930', '1680'])).toBe(50700)
  })

  it('treats an empty override list as no override', () => {
    const rows = [makeTrialBalanceRow({ account_number: '1930', closing_debit: 50000 })]
    expect(calculateCashPosition(rows, [])).toBe(50000)
  })
})

describe('kpiReceivablesAsOf', () => {
  it('returns the range end when it has passed', () => {
    expect(kpiReceivablesAsOf('2025-12-31', '2026-09-26')).toBe('2025-12-31')
  })

  it('returns undefined (live state) for a range ending today or later', () => {
    expect(kpiReceivablesAsOf('2026-09-26', '2026-09-26')).toBeUndefined()
    expect(kpiReceivablesAsOf('2026-12-31', '2026-09-26')).toBeUndefined()
  })
})

describe('fetchPaymentDaysInRange', () => {
  // get_paid_invoice_days, answered from the rows by its JS port
  // (tests/reskontra-rpc-port.ts); the SQL is pinned in
  // tests/pg/reskontra-population-rpc.pg.test.ts.
  const paid = (invoice_date: string, paid_at: string, fields: Record<string, unknown> = {}) => ({
    status: 'paid', invoice_date, paid_at, ...fields,
  })

  it('counts the paid invoices whose payment landed in the range, end date inclusive', async () => {
    const books: ReskontraTables = {
      invoices: [
        paid('2025-12-01', '2025-12-31T10:00:00Z'), // 30 days, on the last day
        paid('2024-12-01', '2025-01-01T00:00:00Z'), // 31 days, on the first instant
        paid('2025-12-01', '2026-01-01T00:00:00Z'), // after the range
        paid('2025-03-10', '2025-03-05T12:00:00Z'), // paid before the invoice date: 0 days
        paid('2025-02-01', '2025-02-11T00:00:00Z', { status: 'sent' }), // not paid
      ],
    }
    const { supabase, calls } = createReskontraClient(() => books)

    const totals = await fetchPaymentDaysInRange(supabase, 'company-1', '2025-01-01', '2025-12-31')

    expect(totals).toEqual({ invoiceCount: 3, totalDays: 61 })
    // Exclusive next day, so a payment on the last day counts.
    expect(calls).toEqual([
      { name: 'get_paid_invoice_days', args: { p_company_id: 'company-1', p_from: '2025-01-01', p_paid_before: '2026-01-01' } },
    ])
  })

  it('throws when the read fails', async () => {
    const { supabase } = createReskontraClient(() => ({}), () => ({ get_paid_invoice_days: { message: 'boom' } }))
    await expect(fetchPaymentDaysInRange(supabase, 'company-1', '2025-01-01', '2025-12-31')).rejects.toThrow('boom')
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

  it('includes reduced-rate output VAT (12% and 6%) in the liability', () => {
    const rows = [
      makeTrialBalanceRow({ account_number: '2611', closing_credit: 25000 }),
      makeTrialBalanceRow({ account_number: '2621', closing_credit: 1200 }),
      makeTrialBalanceRow({ account_number: '2631', closing_credit: 600 }),
      makeTrialBalanceRow({ account_number: '2641', closing_debit: 10000 }),
    ]
    expect(calculateVatLiability(rows)).toBe(16800)
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
      '2640', '2641', '2642', '2645', '2646', '2647', '2648', '2649',
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

describe('fetchTopSupplierInvoices', () => {
  // get_kpi_supplier_invoices, answered from the rows by its JS port.
  const row = (fields: Record<string, unknown> = {}) => ({
    supplier_id: 'sup-1',
    supplier: { id: 'sup-1', name: 'Leverantören AB' },
    invoice_date: '2026-03-01',
    status: 'approved',
    total: 1,
    total_sek: null,
    currency: 'SEK',
    exchange_rate: null,
    ...fields,
  })

  it('reads every invoice of the period, past the 1000-row PostgREST cap, credited ones left out', async () => {
    // A company with 1003 supplier invoices in the period: awaiting a bare
    // query returned only the first 1000 and silently understated the totals.
    const books: ReskontraTables = {
      supplier_invoices: [
        ...Array.from({ length: 1003 }, () => row()),
        row({ status: 'credited' }),
        row({ invoice_date: '2025-12-31' }),
      ],
    }
    const { supabase, calls } = createReskontraClient(() => books)

    const { data, error } = await fetchTopSupplierInvoices(supabase, 'company-1', '2026-01-01', '2026-12-31')

    expect(error).toBeNull()
    expect(data).toHaveLength(1003)
    expect(data?.[0]).toEqual({
      supplier_id: 'sup-1',
      total: 1,
      total_sek: null,
      currency: 'SEK',
      exchange_rate: null,
      supplier: { id: 'sup-1', name: 'Leverantören AB' },
    })
    expect(calls).toEqual([
      { name: 'get_kpi_supplier_invoices', args: { p_company_id: 'company-1', p_from: '2026-01-01', p_to: '2026-12-31' } },
    ])
  })

  it('reads a supplier it cannot see as no supplier', async () => {
    const books: ReskontraTables = { supplier_invoices: [row({ supplier: null })] }
    const { supabase } = createReskontraClient(() => books)

    const { data } = await fetchTopSupplierInvoices(supabase, 'company-1', '2026-01-01', '2026-12-31')

    expect(data?.[0].supplier).toBeNull()
  })

  it('returns a { data: null, error } value on query failure, never throws', async () => {
    const { supabase } = createReskontraClient(() => ({}), () => ({ get_kpi_supplier_invoices: { message: 'connection reset' } }))

    const result = await fetchTopSupplierInvoices(supabase, 'company-1', '2026-01-01', '2026-12-31')

    expect(result.data).toBeNull()
    expect(result.error?.message).toBe('connection reset')
  })
})

describe('averagePaymentDays', () => {
  it('returns the rounded average for 5 or more invoices', () => {
    // (10 + 20 + 15 + 25 + 30) / 5 = 20
    expect(averagePaymentDays({ invoiceCount: 5, totalDays: 100 })).toBe(20)
    expect(averagePaymentDays({ invoiceCount: 6, totalDays: 101 })).toBe(17)
  })

  it('returns null for fewer than 5 invoices', () => {
    expect(averagePaymentDays({ invoiceCount: 4, totalDays: 100 })).toBeNull()
    expect(averagePaymentDays({ invoiceCount: 0, totalDays: 0 })).toBeNull()
  })
})
