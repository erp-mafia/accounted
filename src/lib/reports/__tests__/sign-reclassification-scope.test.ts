/**
 * WHERE sign reclassification applies, pinned in both directions.
 *
 * A skattekonto (1630) with a credit balance is money owed to Skatteverket, and
 * a momsavräkningskonto (2641) with a debit balance is money owed back. ÅRL 3
 * kap. and K2 present a post by the substance of its balance, so the STATUTORY
 * surfaces move them. The ACCOUNT-ORIENTED surfaces deliberately do not.
 *
 * Both halves are asserted here on purpose:
 *
 *   - The statutory half stops the reclassification silently disappearing from
 *     one surface again. It shipped in the K2 mapper on 2026-07-23 and was
 *     missing from INK2R until 2026-07-29, which is exactly how a customer came
 *     to be comparing two of our own reports against each other.
 *
 *   - The operational half stops a future sweep "fixing" Balansräkning and
 *     Balansrapport into disagreeing with their own documented contract. Those
 *     two are organised BY ACCOUNT NUMBER under BAS-prefix headings, and
 *     balansrapport.ts states an invariant that depends on every row staying
 *     debit-positive where it was booked: moving konto 1630 into a liability
 *     section would break the add-the-rows-to-verify-the-balance property and
 *     hide the account from anyone looking for it by number.
 *
 * See DECISIONS.md for the scope decision. If a new STATUTORY presentation is
 * added, it belongs in the first half of this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateBalanceSheet } from '../balance-sheet'
import { mapTrialBalancesToK2 } from '@/lib/bokslut/ixbrl/k2-mapper'
import { CLOSED_ROWS, EXPECTED, PRE_CLOSING_ROWS, rowsForMode } from './closed-year-fixture'

const COMPANY_ID = 'company-1'
const PERIOD_ID = 'period-1'

function findRow(
  sections: Array<{ title: string; rows: Array<{ account_number: string; amount: number }> }>,
  accountNumber: string,
) {
  for (const section of sections) {
    for (const row of section.rows) {
      if (row.account_number === accountNumber) return { section: section.title, amount: row.amount }
    }
  }
  return null
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(generateTrialBalance).mockImplementation(async (_s, _c, _p, opts) => ({
    rows: rowsForMode(opts.closingEntry),
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  }))
})

describe('statutory surfaces reclassify by sign', () => {
  it('the K2 årsredovisning moves a credit 1630 into Skatteskulder', () => {
    const k2 = mapTrialBalancesToK2({ full: CLOSED_ROWS, preClosing: PRE_CLOSING_ROWS }, null)

    expect(k2.br['Skatteskulder'].current).toBe(10_000 + EXPECTED.taxAccountCredit)
    expect(k2.br['OvrigaFordringarKortfristiga'].current).toBe(EXPECTED.inputVatDebit)
  })

  it('and says so in a warning rather than moving money silently', () => {
    const k2 = mapTrialBalancesToK2({ full: CLOSED_ROWS, preClosing: PRE_CLOSING_ROWS }, null)

    expect(k2.warnings.some((w) => w.includes('1630-1659'))).toBe(true)
    expect(k2.warnings.some((w) => w.includes('2610-2659'))).toBe(true)
  })
})

describe('account-oriented surfaces deliberately do NOT reclassify', () => {
  it('Balansräkning keeps konto 1630 under its own BAS heading', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalanceSheet({} as any, COMPANY_ID, PERIOD_ID)

    const taxAccount = findRow(report.asset_sections, '1630')
    expect(taxAccount).not.toBeNull()
    expect(taxAccount!.section).toBe('Övriga kortfristiga fordringar')
    // Shown debit-positive, so a credit balance renders negative. That is the
    // documented convention for this report, not a bug to reclassify away.
    expect(taxAccount!.amount).toBe(-EXPECTED.taxAccountCredit)
  })

  it('Balansräkning keeps konto 2641 under Moms och punktskatter', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalanceSheet({} as any, COMPANY_ID, PERIOD_ID)

    const inputVat = findRow(report.equity_liability_sections, '2641')
    expect(inputVat).not.toBeNull()
    expect(inputVat!.section).toBe('Moms och punktskatter')
    // Credit-positive on the liability side, so a debit balance renders negative.
    expect(inputVat!.amount).toBe(-EXPECTED.inputVatDebit)
  })

  it('and still ties out, because nothing moved across the split', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalanceSheet({} as any, COMPANY_ID, PERIOD_ID)

    expect(report.total_assets).toBe(report.total_equity_liabilities)
  })
})
