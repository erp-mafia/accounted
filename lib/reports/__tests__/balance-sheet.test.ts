import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

vi.mock('../imbalance-diagnosis', () => ({
  findUntransferredResults: vi.fn(),
  buildImbalanceDiagnosis: vi.fn(),
}))

import { generateBalanceSheet } from '../balance-sheet'
import { generateTrialBalance } from '../trial-balance'
import { findUntransferredResults, buildImbalanceDiagnosis } from '../imbalance-diagnosis'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { TrialBalanceRow } from '@/types'

const mockTrialBalance = vi.mocked(generateTrialBalance)
const mockFindUntransferred = vi.mocked(findUntransferredResults)
const mockBuildDiagnosis = vi.mocked(buildImbalanceDiagnosis)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = {} as any

beforeEach(() => {
  vi.clearAllMocks()
})

function makeRow(overrides: Partial<TrialBalanceRow>): TrialBalanceRow {
  return {
    account_number: '1930',
    account_name: 'Test Account',
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

describe('generateBalanceSheet', () => {
  it('returns empty report when no rows', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })

    const report = await generateBalanceSheet(supabase, 'company-1', 'period-1')

    expect(report.asset_sections).toEqual([])
    expect(report.equity_liability_sections).toEqual([])
    expect(report.total_assets).toBe(0)
    expect(report.total_equity_liabilities).toBe(0)
  })

  it('calculates assets (class 1) with debit-normal balance', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '1510', account_name: 'Kundfordringar', account_class: 1, closing_debit: 15000, closing_credit: 0 }),
        makeRow({ account_number: '1930', account_name: 'Företagskonto', account_class: 1, closing_debit: 50000, closing_credit: 0 }),
      ],
      totalDebit: 65000,
      totalCredit: 0,
      isBalanced: false,
    })

    const report = await generateBalanceSheet(supabase, 'company-1', 'period-1')

    expect(report.asset_sections).toHaveLength(2)
    expect(report.asset_sections[0].title).toBe('Kundfordringar')
    expect(report.asset_sections[0].rows[0].amount).toBe(15000) // debit - credit
    expect(report.asset_sections[1].title).toBe('Kassa och bank')
    expect(report.asset_sections[1].rows[0].amount).toBe(50000)
    expect(report.total_assets).toBe(65000)
  })

  it('calculates equity/liabilities (class 2) with credit-normal balance', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '2010', account_name: 'Eget kapital', account_class: 2, closing_credit: 30000, closing_debit: 0 }),
        makeRow({ account_number: '2440', account_name: 'Leverantörsskulder', account_class: 2, closing_credit: 10000, closing_debit: 0 }),
      ],
      totalDebit: 0,
      totalCredit: 40000,
      isBalanced: false,
    })

    const report = await generateBalanceSheet(supabase, 'company-1', 'period-1')

    expect(report.equity_liability_sections).toHaveLength(2)
    expect(report.equity_liability_sections[0].title).toBe('Eget kapital')
    expect(report.equity_liability_sections[0].rows[0].amount).toBe(30000) // credit - debit
    expect(report.equity_liability_sections[1].title).toBe('Kortfristiga skulder')
    expect(report.total_equity_liabilities).toBe(40000)
  })

  it('filters rows with |amount| < 0.005', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 50000, closing_credit: 0 }),
        // This row has amount = 0.003, should be filtered
        makeRow({ account_number: '1940', account_name: 'Tiny', account_class: 1, closing_debit: 0.003, closing_credit: 0 }),
      ],
      totalDebit: 50000.003,
      totalCredit: 0,
      isBalanced: false,
    })

    const report = await generateBalanceSheet(supabase, 'company-1', 'period-1')

    const bankSection = report.asset_sections.find(s => s.title === 'Kassa och bank')!
    expect(bankSection.rows).toHaveLength(1)
    expect(bankSection.rows[0].account_number).toBe('1930')
  })

  it('filters empty sections after zero-filtering', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 50000, closing_credit: 0 }),
        // Section 10 (Immateriella) will be empty after filtering
        makeRow({ account_number: '1010', account_name: 'Goodwill', account_class: 1, closing_debit: 0.001, closing_credit: 0 }),
      ],
      totalDebit: 50000.001,
      totalCredit: 0,
      isBalanced: false,
    })

    const report = await generateBalanceSheet(supabase, 'company-1', 'period-1')

    expect(report.asset_sections).toHaveLength(1)
    expect(report.asset_sections[0].title).toBe('Kassa och bank')
  })

  it('groups by two-digit prefix (1510 + 1520 under 15)', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '1510', account_name: 'Kundfordringar', account_class: 1, closing_debit: 10000, closing_credit: 0 }),
        makeRow({ account_number: '1520', account_name: 'Osäkra kundfordringar', account_class: 1, closing_debit: 2000, closing_credit: 0 }),
      ],
      totalDebit: 12000,
      totalCredit: 0,
      isBalanced: false,
    })

    const report = await generateBalanceSheet(supabase, 'company-1', 'period-1')

    expect(report.asset_sections).toHaveLength(1)
    expect(report.asset_sections[0].title).toBe('Kundfordringar')
    expect(report.asset_sections[0].rows).toHaveLength(2)
    expect(report.asset_sections[0].subtotal).toBe(12000)
  })

  it('ignores class 3-8 accounts (income statement)', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 50000, closing_credit: 0 }),
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 40000, closing_debit: 0 }),
        makeRow({ account_number: '5010', account_name: 'Rent', account_class: 5, closing_debit: 8000, closing_credit: 0 }),
        makeRow({ account_number: '8310', account_name: 'Interest', account_class: 8, closing_credit: 500, closing_debit: 0 }),
      ],
      totalDebit: 58000,
      totalCredit: 40500,
      isBalanced: false,
    })

    const report = await generateBalanceSheet(supabase, 'company-1', 'period-1')

    expect(report.asset_sections).toHaveLength(1) // Only 1930
    // Class 3-8 accounts are not included as balance sheet rows, but their
    // net result (credit - debit = 40000 + 500 - 8000 = 32500) appears as
    // "Årets resultat" in equity so the balance sheet can balance.
    expect(report.equity_liability_sections).toHaveLength(1)
    expect(report.equity_liability_sections[0].title).toBe('Årets resultat')
    expect(report.equity_liability_sections[0].subtotal).toBe(32500)
    expect(report.total_assets).toBe(50000)
    expect(report.total_equity_liabilities).toBe(32500)
  })

  it('handles negative asset balance (net credit on class 1 account)', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 50000, closing_credit: 0 }),
        // Receivables with net credit (customer overpayment)
        makeRow({ account_number: '1510', account_name: 'Kundfordringar', account_class: 1, closing_debit: 0, closing_credit: 5000 }),
      ],
      totalDebit: 50000,
      totalCredit: 5000,
      isBalanced: false,
    })

    const report = await generateBalanceSheet(supabase, 'company-1', 'period-1')

    const receivables = report.asset_sections.find(s => s.rows.some(r => r.account_number === '1510'))
    expect(receivables).toBeDefined()
    expect(receivables!.rows.find(r => r.account_number === '1510')!.amount).toBe(-5000)
    expect(report.total_assets).toBe(45000) // 50000 - 5000
  })

  it('rounding boundary: 0.004 rounds to 0 and is excluded, 0.005 rounds to 0.01 and is included', async () => {
    // Amounts go through Math.round(x * 100) / 100 before the > 0.005 filter.
    // Due to IEEE 754, 0.005 * 100 is slightly above 0.5, so Math.round rounds UP to 1,
    // giving 0.01 which passes > 0.005. Meanwhile 0.004 rounds to 0.
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 1000, closing_credit: 0 }),
        makeRow({ account_number: '1940', account_name: 'Excluded', account_class: 1, closing_debit: 0.004, closing_credit: 0 }),
        makeRow({ account_number: '1950', account_name: 'Included', account_class: 1, closing_debit: 0.005, closing_credit: 0 }),
      ],
      totalDebit: 1000.009,
      totalCredit: 0,
      isBalanced: false,
    })

    const report = await generateBalanceSheet(supabase, 'company-1', 'period-1')

    const bankSection = report.asset_sections.find(s => s.title === 'Kassa och bank')!
    // 1930 (1000) and 1950 (0.005 → rounds to 0.01) are included; 1940 (0.004 → rounds to 0) is excluded
    expect(bankSection.rows).toHaveLength(2)
    expect(bankSection.rows.map(r => r.account_number)).toEqual(['1930', '1950'])
  })

  it('attaches imbalance_diagnosis when the report does not balance', async () => {
    const q = createQueuedMockSupabase()
    // Period fetch inside the diagnosis path
    q.enqueue({ data: { period_start: '2025-03-01' } })

    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '1930', account_class: 1, closing_debit: 1097 }),
        makeRow({ account_number: '2440', account_class: 2, closing_credit: 1000 }),
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
    const report = await generateBalanceSheet(q.supabase as any, 'company-1', 'period-3')

    expect(report.total_assets - report.total_equity_liabilities).toBe(97)
    expect(mockFindUntransferred).toHaveBeenCalledWith(q.supabase, 'company-1', {
      beforePeriodStart: '2025-03-01',
    })
    expect(mockBuildDiagnosis).toHaveBeenCalledWith([culprit], 97)
    expect(report.imbalance_diagnosis).toEqual(diagnosis)
  })

  it('omits imbalance_diagnosis when the report balances', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '1930', account_class: 1, closing_debit: 1000 }),
        makeRow({ account_number: '2440', account_class: 2, closing_credit: 1000 }),
      ],
      totalDebit: 1000,
      totalCredit: 1000,
      isBalanced: true,
    })

    const report = await generateBalanceSheet(supabase, 'company-1', 'period-1')

    expect(report.imbalance_diagnosis).toBeUndefined()
    expect(mockFindUntransferred).not.toHaveBeenCalled()
  })

  it('still returns the report when the diagnosis lookup fails', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: { period_start: '2025-03-01' } })

    mockTrialBalance.mockResolvedValue({
      rows: [makeRow({ account_number: '1930', account_class: 1, closing_debit: 500 })],
      totalDebit: 500,
      totalCredit: 0,
      isBalanced: false,
    })
    mockFindUntransferred.mockRejectedValue(new Error('boom'))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalanceSheet(q.supabase as any, 'company-1', 'period-1')

    expect(report.total_assets).toBe(500)
    expect(report.imbalance_diagnosis).toBeUndefined()
  })

  it('uses Math.round for monetary precision on subtotals', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 33.33, closing_credit: 0 }),
        makeRow({ account_number: '1940', account_name: 'Kassa', account_class: 1, closing_debit: 33.33, closing_credit: 0 }),
        makeRow({ account_number: '1950', account_name: 'Annan bank', account_class: 1, closing_debit: 33.34, closing_credit: 0 }),
      ],
      totalDebit: 100,
      totalCredit: 0,
      isBalanced: false,
    })

    const report = await generateBalanceSheet(supabase, 'company-1', 'period-1')

    // All three are in group '19' (Kassa och bank)
    const section = report.asset_sections.find(s => s.title === 'Kassa och bank')!
    expect(section.subtotal).toBe(100)
    expect(report.total_assets).toBe(100)
  })
})
