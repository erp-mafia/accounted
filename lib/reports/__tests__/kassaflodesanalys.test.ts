import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock trial-balance and income-statement so we can plant deterministic
// inputs into the cash-flow generator. The generator is pure logic over
// (TB rows, IS totals) — testing it in isolation avoids re-creating the
// Supabase mock surface for two layered generators.
vi.mock('../trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

vi.mock('../income-statement', () => ({
  generateIncomeStatement: vi.fn(),
}))

import { generateKassaflodesanalys } from '../kassaflodesanalys'
import { generateTrialBalance } from '../trial-balance'
import { generateIncomeStatement } from '../income-statement'
import type { TrialBalanceRow, IncomeStatementReport } from '@/types'

const mockTrialBalance = vi.mocked(generateTrialBalance)
const mockIncomeStatement = vi.mocked(generateIncomeStatement)

function makeSupabase(period: { period_start: string; period_end: string } | null) {
  // Lightweight chainable mock — kassaflodesanalys only calls
  // supabase.from('fiscal_periods').select().eq().eq().single()
  const builder: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) {
    builder[m] = vi.fn().mockReturnValue(builder)
  }
  builder.single = vi.fn().mockResolvedValue(
    period ? { data: period, error: null } : { data: null, error: null }
  )
  return {
    from: vi.fn().mockReturnValue(builder),
  } as unknown as Parameters<typeof generateKassaflodesanalys>[0]
}

function makeRow(overrides: Partial<TrialBalanceRow>): TrialBalanceRow {
  return {
    account_number: '0000',
    account_name: 'X',
    account_class: 0,
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: 0,
    closing_credit: 0,
    ...overrides,
  }
}

function makeIs(overrides: Partial<IncomeStatementReport> = {}): IncomeStatementReport {
  return {
    revenue_sections: [],
    total_revenue: 0,
    expense_sections: [],
    total_expenses: 0,
    financial_sections: [],
    total_financial: 0,
    net_result: 0,
    period: { start: '2024-01-01', end: '2024-12-31' },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('generateKassaflodesanalys', () => {
  const PERIOD = { period_start: '2024-01-01', period_end: '2024-12-31' }

  it('returns all-zero sections for an empty period', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    mockIncomeStatement.mockResolvedValue(makeIs())

    const report = await generateKassaflodesanalys(
      makeSupabase(PERIOD),
      'company-1',
      'period-1'
    )

    expect(report.lopande.total).toBe(0)
    expect(report.investerings.total).toBe(0)
    expect(report.finansierings.total).toBe(0)
    expect(report.total_cash_flow).toBe(0)
    expect(report.reconciliation.is_reconciled).toBe(true)
    expect(report.reconciliation.opening_cash_1xxx).toBe(0)
    expect(report.reconciliation.closing_cash_1xxx).toBe(0)
    expect(report.reconciliation.delta_actual).toBe(0)
    expect(report.reconciliation.delta_calculated).toBe(0)
  })

  it('adds back avskrivningar (100 000 kr) to löpande verksamhet', async () => {
    // Setup: 100 000 kr depreciation booked: debit 7832, credit 1219 (ack avskr).
    // Expected: avskrivningar = 100 000, added back to resultat efter finansiella.
    // For reconciliation: bank moved 0 because depreciation is non-cash; the
    // fixed-asset NET delta is 1219 going up in credit (i.e. asset side down),
    // which surfaces as avyttring (debit-side negative) -> +100 000 in investing.
    //
    // To keep this test focused on the "add back" behavior, we plant zero
    // movement on classes 1-3,4-6,8 except 78xx (depreciation expense) and
    // the offsetting 1219 (ack avskr). Result before fin: -100 000 (only
    // expense). Add back +100 000. Net cash flow from operating: 0.
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({
          account_number: '7832',
          account_class: 7,
          period_debit: 100000,
          closing_debit: 100000,
        }),
        // 1219 = ack avskr inventarier (contra-asset, credit-normal). Increases
        // by 100 000 over the period.
        makeRow({
          account_number: '1219',
          account_class: 1,
          period_credit: 100000,
          closing_credit: 100000,
        }),
      ],
      totalDebit: 100000,
      totalCredit: 100000,
      isBalanced: true,
    })
    mockIncomeStatement.mockResolvedValue(
      makeIs({
        total_expenses: 100000,
        net_result: -100000,
      })
    )

    const report = await generateKassaflodesanalys(
      makeSupabase(PERIOD),
      'company-1',
      'period-1'
    )

    expect(report.lopande.resultat_efter_finansiella_poster).toBe(-100000)
    expect(report.lopande.avskrivningar).toBe(100000)
    // Result + add-back depreciation = 0 löpande
    expect(report.lopande.total).toBe(0)
    // 1219 sits in 12xx range (investing), credit went up = debit-side delta
    // is negative -> avyttring path. This is acceptable behavior; the
    // reconciliation invariant is what protects us. Verify it holds:
    // total_cash_flow should equal delta_actual on 19xx (which is 0).
    expect(report.reconciliation.delta_actual).toBe(0)
    // The mock setup ensures investing offsets to make the reconciliation
    // balance against 0 cash movement.
    expect(report.reconciliation.is_reconciled).toBe(true)
  })

  it('reconciles when a 50 000 kr deposit hits the bank (1930)', async () => {
    // Setup: customer pays an invoice 50 000 net of VAT for simplicity.
    // 1930 (bank) debit 50 000; 1510 (kundfordringar) credit 50 000.
    // No P&L impact (already booked at invoice creation).
    //
    // Expected:
    //   Δ kortfristiga fordringar = -(-50 000) = +50 000 (receivables down → cash in)
    //   Result efter fin = 0
    //   Lopande total = +50 000
    //   delta_actual = 50 000 (closing 19xx = 50 000)
    //   delta_calculated = 50 000
    //   is_reconciled = true
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({
          account_number: '1930',
          account_class: 1,
          period_debit: 50000,
          closing_debit: 50000,
        }),
        makeRow({
          account_number: '1510',
          account_class: 1,
          opening_debit: 50000,
          period_credit: 50000,
          closing_debit: 50000,
          closing_credit: 50000,
        }),
      ],
      totalDebit: 100000,
      totalCredit: 50000,
      isBalanced: false,
    })
    mockIncomeStatement.mockResolvedValue(makeIs())

    const report = await generateKassaflodesanalys(
      makeSupabase(PERIOD),
      'company-1',
      'period-1'
    )

    // 1510 net debit-side delta = (50000-50000) - (50000-0) = -50000
    // delta_kortfristiga_fordringar = -(-50000) = +50000
    expect(report.lopande.delta_kortfristiga_fordringar).toBe(50000)
    expect(report.lopande.total).toBe(50000)
    expect(report.reconciliation.opening_cash_1xxx).toBe(0)
    expect(report.reconciliation.closing_cash_1xxx).toBe(50000)
    expect(report.reconciliation.delta_actual).toBe(50000)
    expect(report.reconciliation.delta_calculated).toBe(50000)
    expect(report.reconciliation.is_reconciled).toBe(true)
  })

  it('records asset purchase (200 000 kr) as investing outflow', async () => {
    // Setup: buy inventarie for 200 000: debit 1220, credit 1930.
    //   1930 (bank): credit 200 000 → closing -200 000
    //   1220 (inventarier): debit 200 000 → closing +200 000
    //
    // Expected:
    //   forvarv_anlaggningar = -200 000
    //   delta_actual = -200 000 (bank went down)
    //   delta_calculated = -200 000
    //   is_reconciled = true
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({
          account_number: '1930',
          account_class: 1,
          period_credit: 200000,
          closing_credit: 200000,
        }),
        makeRow({
          account_number: '1220',
          account_class: 1,
          period_debit: 200000,
          closing_debit: 200000,
        }),
      ],
      totalDebit: 200000,
      totalCredit: 200000,
      isBalanced: true,
    })
    mockIncomeStatement.mockResolvedValue(makeIs())

    const report = await generateKassaflodesanalys(
      makeSupabase(PERIOD),
      'company-1',
      'period-1'
    )

    expect(report.investerings.forvarv_anlaggningar).toBe(-200000)
    expect(report.investerings.avyttring_anlaggningar).toBe(0)
    expect(report.investerings.total).toBe(-200000)
    expect(report.reconciliation.delta_actual).toBe(-200000)
    expect(report.reconciliation.delta_calculated).toBe(-200000)
    expect(report.reconciliation.is_reconciled).toBe(true)
  })

  it('records loan increase (500 000 kr) as financing inflow', async () => {
    // Setup: take out a 500 000 long-term loan: debit 1930, credit 2350.
    //   1930 (bank): debit 500 000 → closing +500 000
    //   2350 (långfristiga lån): credit 500 000 → closing -500 000 on debit side
    //
    // Expected:
    //   delta_lan = 500 000 (loans went up, cash in)
    //   delta_actual = 500 000
    //   is_reconciled = true
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({
          account_number: '1930',
          account_class: 1,
          period_debit: 500000,
          closing_debit: 500000,
        }),
        makeRow({
          account_number: '2350',
          account_class: 2,
          period_credit: 500000,
          closing_credit: 500000,
        }),
      ],
      totalDebit: 500000,
      totalCredit: 500000,
      isBalanced: true,
    })
    mockIncomeStatement.mockResolvedValue(makeIs())

    const report = await generateKassaflodesanalys(
      makeSupabase(PERIOD),
      'company-1',
      'period-1'
    )

    expect(report.finansierings.delta_lan).toBe(500000)
    expect(report.finansierings.total).toBe(500000)
    expect(report.reconciliation.delta_actual).toBe(500000)
    expect(report.reconciliation.delta_calculated).toBe(500000)
    expect(report.reconciliation.is_reconciled).toBe(true)
  })

  it('detects mismatch when a cash movement has no balancing classification', async () => {
    // Plant an invariant violation: 1930 went up by 10 000 but no offsetting
    // entry on any tracked account class. This is the kind of bug a real
    // bookkeeping error would surface as.
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({
          account_number: '1930',
          account_class: 1,
          period_debit: 10000,
          closing_debit: 10000,
        }),
        // The "offset" is in account 9999 (out-of-range). The cash flow
        // generator doesn't see it. is_reconciled must flag false.
        makeRow({
          account_number: '9999',
          account_class: 9,
          period_credit: 10000,
          closing_credit: 10000,
        }),
      ],
      totalDebit: 10000,
      totalCredit: 10000,
      isBalanced: true,
    })
    mockIncomeStatement.mockResolvedValue(makeIs())

    const report = await generateKassaflodesanalys(
      makeSupabase(PERIOD),
      'company-1',
      'period-1'
    )

    expect(report.reconciliation.delta_actual).toBe(10000)
    expect(report.reconciliation.delta_calculated).toBe(0)
    expect(report.reconciliation.mismatch_amount).toBe(10000)
    expect(report.reconciliation.is_reconciled).toBe(false)
  })

  it('throws when fiscal period is not found', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    mockIncomeStatement.mockResolvedValue(makeIs())

    await expect(
      generateKassaflodesanalys(makeSupabase(null), 'company-1', 'period-1')
    ).rejects.toThrow('Fiscal period not found')
  })

  it('uses Math.round for monetary precision (no toFixed)', async () => {
    // Plant fractional cents in the inputs; result must be rounded to 2dp,
    // never via toFixed which would return a string.
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({
          account_number: '1930',
          account_class: 1,
          period_debit: 33.337,
          closing_debit: 33.337,
        }),
        makeRow({
          account_number: '7832',
          account_class: 7,
          period_debit: 33.337,
          closing_debit: 33.337,
        }),
      ],
      totalDebit: 66.674,
      totalCredit: 0,
      isBalanced: false,
    })
    mockIncomeStatement.mockResolvedValue(
      makeIs({ total_expenses: 33.337, net_result: -33.337 })
    )

    const report = await generateKassaflodesanalys(
      makeSupabase(PERIOD),
      'company-1',
      'period-1'
    )

    // resultat = revenue - expenses + non-tax-financial = 0 - 33.337 + 0 = -33.34
    expect(report.lopande.resultat_efter_finansiella_poster).toBe(-33.34)
    expect(report.lopande.avskrivningar).toBe(33.34)
    // No bare toFixed return values — these must be numbers, not strings.
    expect(typeof report.lopande.total).toBe('number')
  })
})
