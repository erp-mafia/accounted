import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { generateIncomeStatement } from '../income-statement'
import { generateTrialBalance } from '../trial-balance'
import { roundOre } from '@/lib/money'
import type { TrialBalanceRow } from '@/types'

const mockTrialBalance = vi.mocked(generateTrialBalance)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = {} as any

beforeEach(() => {
  vi.clearAllMocks()
})

function makeRow(overrides: Partial<TrialBalanceRow>): TrialBalanceRow {
  return {
    account_number: '3001',
    account_name: 'Test Account',
    account_class: 3,
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: 0,
    closing_credit: 0,
    ...overrides,
  }
}

describe('generateIncomeStatement', () => {
  it('returns empty report when no rows', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    expect(report.revenue_sections).toEqual([])
    expect(report.expense_sections).toEqual([])
    expect(report.financial_sections).toEqual([])
    expect(report.net_result).toBe(0)
  })

  it('calculates revenue (class 3) with credit-normal balance', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '3001', account_name: 'Försäljning 25%', account_class: 3, closing_credit: 10000, closing_debit: 0 }),
        makeRow({ account_number: '3002', account_name: 'Försäljning 12%', account_class: 3, closing_credit: 5000, closing_debit: 0 }),
      ],
      totalDebit: 0,
      totalCredit: 15000,
      isBalanced: false,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    expect(report.revenue_sections).toHaveLength(1)
    expect(report.revenue_sections[0].title).toBe('Huvudintäkter')
    expect(report.revenue_sections[0].rows).toHaveLength(2)
    expect(report.revenue_sections[0].rows[0].amount).toBe(10000)
    expect(report.revenue_sections[0].rows[1].amount).toBe(5000)
    expect(report.total_revenue).toBe(15000)
  })

  it('calculates expenses (class 4-7) with debit-normal balance', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, closing_debit: 8000, closing_credit: 0 }),
        makeRow({ account_number: '6200', account_name: 'Telefon', account_class: 6, closing_debit: 2000, closing_credit: 0 }),
      ],
      totalDebit: 10000,
      totalCredit: 0,
      isBalanced: false,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    expect(report.expense_sections).toHaveLength(2)
    expect(report.expense_sections[0].title).toBe('Lokalkostnader')
    expect(report.expense_sections[0].rows[0].amount).toBe(8000)
    expect(report.expense_sections[1].title).toBe('Tele och post')
    expect(report.total_expenses).toBe(10000)
  })

  it('calculates financial items (class 8) with mixed balance', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '8310', account_name: 'Ränteintäkter', account_class: 8, closing_credit: 500, closing_debit: 0 }),
        makeRow({ account_number: '8410', account_name: 'Räntekostnader', account_class: 8, closing_debit: 300, closing_credit: 0 }),
      ],
      totalDebit: 300,
      totalCredit: 500,
      isBalanced: false,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    expect(report.financial_sections).toHaveLength(2)
    // Financial uses credit - debit
    const interestIncome = report.financial_sections.find(s => s.title === 'Ränteintäkter')!
    expect(interestIncome.rows[0].amount).toBe(500) // credit 500 - debit 0

    const interestExpense = report.financial_sections.find(s => s.title === 'Räntekostnader')!
    expect(interestExpense.rows[0].amount).toBe(-300) // credit 0 - debit 300
  })

  it('computes net_result = revenue - expenses + financial', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 20000, closing_debit: 0 }),
        makeRow({ account_number: '5010', account_name: 'Rent', account_class: 5, closing_debit: 8000, closing_credit: 0 }),
        makeRow({ account_number: '8310', account_name: 'Interest', account_class: 8, closing_credit: 1000, closing_debit: 0 }),
      ],
      totalDebit: 8000,
      totalCredit: 21000,
      isBalanced: false,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    expect(report.total_revenue).toBe(20000)
    expect(report.total_expenses).toBe(8000)
    expect(report.total_financial).toBe(1000)
    expect(report.net_result).toBe(13000) // 20000 - 8000 + 1000
  })

  it('filters rows with |amount| < 0.005', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 10000, closing_debit: 0 }),
        // This row has amount = 0.004, should be filtered
        makeRow({ account_number: '3002', account_name: 'Tiny', account_class: 3, closing_credit: 0.004, closing_debit: 0 }),
      ],
      totalDebit: 0,
      totalCredit: 10000.004,
      isBalanced: false,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    // Only the significant revenue row should appear
    const revenueSection = report.revenue_sections.find(s => s.title === 'Huvudintäkter')!
    expect(revenueSection.rows).toHaveLength(1)
    expect(revenueSection.rows[0].account_number).toBe('3001')
  })

  it('filters empty sections (no rows after zero-filtering)', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 5000, closing_debit: 0 }),
        // Section 36 will be empty after filtering
        makeRow({ account_number: '3601', account_name: 'Tiny side income', account_class: 3, closing_credit: 0.001, closing_debit: 0 }),
      ],
      totalDebit: 0,
      totalCredit: 5000.001,
      isBalanced: false,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    // Only the non-empty section should remain
    expect(report.revenue_sections).toHaveLength(1)
    expect(report.revenue_sections[0].title).toBe('Huvudintäkter')
  })

  it('rounding boundary: 0.004 rounds to 0 and is excluded, 0.005 rounds to 0.01 and is included', async () => {
    // Amounts go through Math.round(x * 100) / 100 before the > 0.005 filter.
    // 0.004 → Math.round(0.4) = 0 → excluded. 0.005 → Math.round(0.5+ε) = 1 → 0.01 → included.
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 10000, closing_debit: 0 }),
        makeRow({ account_number: '3002', account_name: 'Excluded', account_class: 3, closing_credit: 0.004, closing_debit: 0 }),
        makeRow({ account_number: '3003', account_name: 'Included', account_class: 3, closing_credit: 0.005, closing_debit: 0 }),
      ],
      totalDebit: 0,
      totalCredit: 10000.009,
      isBalanced: false,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    const section = report.revenue_sections.find(s => s.title === 'Huvudintäkter')!
    // 3001 and 3003 included; 3002 excluded
    expect(section.rows).toHaveLength(2)
    expect(section.rows.map(r => r.account_number)).toEqual(['3001', '3003'])
  })

  it('subtotal includes sub-threshold rows that are filtered from visible rows', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 10000, closing_debit: 0 }),
        // Amount 0.004: below threshold, filtered from rows but included in subtotal
        makeRow({ account_number: '3002', account_name: 'Micro', account_class: 3, closing_credit: 0.004, closing_debit: 0 }),
      ],
      totalDebit: 0,
      totalCredit: 10000.004,
      isBalanced: false,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    const section = report.revenue_sections.find(s => s.title === 'Huvudintäkter')!
    // Only the 10000 row is visible
    expect(section.rows).toHaveLength(1)
    // But subtotal includes both rows (Math.round((10000 + 0.004) * 100) / 100 = 10000)
    expect(section.subtotal).toBe(10000)
  })

  it('excludes account 8999 (Årets resultat closing) from financial section', async () => {
    // Regression: when a SIE import contains a year-end close voucher like
    // Bokio's "Yearly result" (debit 8999, credit 2099), 8999 holds a debit
    // balance equal to the computed profit. Including it as a financial item
    // cancels the revenue-vs-expense difference and drives net_result to ~0.
    // Matches the NE-bilaga behavior (which already ignores 8999).
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 370000, closing_debit: 0 }),
        makeRow({ account_number: '5010', account_name: 'Rent', account_class: 5, closing_debit: 149000, closing_credit: 0 }),
        // Year-end close posted the profit on 8999
        makeRow({ account_number: '8999', account_name: 'Årets resultat', account_class: 8, closing_debit: 221000, closing_credit: 0 }),
      ],
      totalDebit: 370000,
      totalCredit: 370000,
      isBalanced: true,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    expect(report.total_revenue).toBe(370000)
    expect(report.total_expenses).toBe(149000)
    // 8999 must not contribute: financial section should be empty
    expect(report.financial_sections).toEqual([])
    expect(report.total_financial).toBe(0)
    // Computed net result equals what Bokio / NE-bilaga shows
    expect(report.net_result).toBe(221000)
  })

  it('still includes legitimate class 8 accounts (8310 interest, 8410 interest expense)', async () => {
    // Sanity check the 8999 exclusion is narrow: other class 8 accounts
    // (interest income, interest expense, tax) must still appear.
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 100000, closing_debit: 0 }),
        makeRow({ account_number: '8310', account_name: 'Ränteintäkter', account_class: 8, closing_credit: 500, closing_debit: 0 }),
        makeRow({ account_number: '8410', account_name: 'Räntekostnader', account_class: 8, closing_debit: 200, closing_credit: 0 }),
        makeRow({ account_number: '8999', account_name: 'Årets resultat', account_class: 8, closing_debit: 100300, closing_credit: 0 }),
      ],
      totalDebit: 100500,
      totalCredit: 100500,
      isBalanced: true,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    const titles = report.financial_sections.map(s => s.title)
    expect(titles).toContain('Ränteintäkter')
    expect(titles).toContain('Räntekostnader')
    // 89xx section would have been populated by 8999 only: excluded
    expect(titles).not.toContain('Skatter och årets resultat')
    expect(report.total_financial).toBe(300) // 500 - 200
    expect(report.net_result).toBe(100300) // 100000 - 0 + 300
  })

  it('ignores class 1-2 accounts (balance sheet)', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 50000, closing_credit: 0 }),
        makeRow({ account_number: '2440', account_name: 'Leverantörsskulder', account_class: 2, closing_credit: 10000, closing_debit: 0 }),
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 40000, closing_debit: 0 }),
      ],
      totalDebit: 50000,
      totalCredit: 50000,
      isBalanced: true,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    // Only class 3 should appear
    expect(report.revenue_sections).toHaveLength(1)
    expect(report.expense_sections).toEqual([])
    expect(report.financial_sections).toEqual([])
    expect(report.total_revenue).toBe(40000)
  })

  it('includes energikostnader (group 53, e.g. 5310) in expenses and net_result: regression', async () => {
    // Regression: group '53' was missing from the expense label map, so 53xx
    // accounts (energy costs like 5310 El för drift) were silently dropped from
    // total_expenses and net_result. The Resultatrapport (which sums all class
    // 3-8 rows directly) stayed correct, which is how the discrepancy surfaced.
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 100000, closing_debit: 0 }),
        makeRow({ account_number: '5310', account_name: 'El för drift', account_class: 5, closing_debit: 18000, closing_credit: 0 }),
      ],
      totalDebit: 18000,
      totalCredit: 100000,
      isBalanced: false,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    expect(report.total_expenses).toBe(18000) // was 0 before the fix
    expect(report.net_result).toBe(82000) // was 100000 before the fix
    const expenseAccounts = report.expense_sections.flatMap((s) => s.rows.map((r) => r.account_number))
    expect(expenseAccounts).toContain('5310')
  })

  it('routes accounts from every unmapped group (48, 53, 67) into a catch-all, never dropping them', async () => {
    mockTrialBalance.mockResolvedValue({
      rows: [
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 100000, closing_debit: 0 }),
        makeRow({ account_number: '4810', account_name: 'Energi råvara', account_class: 4, closing_debit: 1000, closing_credit: 0 }),
        makeRow({ account_number: '5310', account_name: 'El för drift', account_class: 5, closing_debit: 2000, closing_credit: 0 }),
        makeRow({ account_number: '6710', account_name: 'Lämnade bidrag', account_class: 6, closing_debit: 3000, closing_credit: 0 }),
      ],
      totalDebit: 6000,
      totalCredit: 100000,
      isBalanced: false,
    })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    // All three expense accounts must be counted, regardless of label coverage.
    expect(report.total_expenses).toBe(6000)
    expect(report.net_result).toBe(94000)
    const expenseAccounts = report.expense_sections.flatMap((s) => s.rows.map((r) => r.account_number))
    expect(expenseAccounts).toEqual(expect.arrayContaining(['4810', '5310', '6710']))
  })

  it('total_expenses equals the signed sum of every class 4-7 row (no silent drops)', async () => {
    // Structural invariant guarding the whole class of "missing group label"
    // bug: the sum of expense-section subtotals must equal Σ(debit - credit)
    // over all class 4-7 rows, mixing mapped (50, 70) and unmapped (48, 53, 67)
    // groups.
    const rows = [
      makeRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, closing_debit: 8000, closing_credit: 0 }),
      makeRow({ account_number: '5310', account_name: 'El för drift', account_class: 5, closing_debit: 2500, closing_credit: 0 }),
      makeRow({ account_number: '4810', account_name: 'Energi', account_class: 4, closing_debit: 1500, closing_credit: 0 }),
      makeRow({ account_number: '6710', account_name: 'Bidrag', account_class: 6, closing_debit: 500, closing_credit: 0 }),
      makeRow({ account_number: '7010', account_name: 'Löner', account_class: 7, closing_debit: 40000, closing_credit: 0 }),
    ]
    mockTrialBalance.mockResolvedValue({ rows, totalDebit: 52500, totalCredit: 0, isBalanced: false })

    const report = await generateIncomeStatement(supabase, 'company-1', 'period-1')

    const expectedTotal = rows.reduce((sum, r) => sum + (r.closing_debit - r.closing_credit), 0)
    const sectionSum = report.expense_sections.reduce((sum, s) => sum + s.subtotal, 0)
    expect(report.total_expenses).toBe(expectedTotal) // 52500
    expect(roundOre(sectionSum)).toBe(expectedTotal)
  })
})
