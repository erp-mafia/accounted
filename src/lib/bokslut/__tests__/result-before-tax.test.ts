/**
 * readYearResult: the one definition of the result the bolagsskatt and the
 * periodiseringsfond's 25 % cap rest on. The agreement with INK2 on a real
 * ledger is tests/tool-pg/tax-base.tool.test.ts; here, the rule itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrialBalanceRow } from '@/types'

vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { readYearResult } from '../tax-provision/result-before-tax'

/** One account's closing balance, debit positive. */
function row(account_number: string, balance: number): TrialBalanceRow {
  return {
    account_number,
    account_name: `Konto ${account_number}`,
    account_class: Number(account_number[0]),
    opening_debit: 0,
    opening_credit: 0,
    period_debit: Math.max(balance, 0),
    period_credit: Math.max(-balance, 0),
    closing_debit: Math.max(balance, 0),
    closing_credit: Math.max(-balance, 0),
  }
}

function ledger(rows: TrialBalanceRow[]) {
  vi.mocked(generateTrialBalance).mockResolvedValue({ rows, totalDebit: 0, totalCredit: 0, isBalanced: true })
  return readYearResult({} as never, 'company-1', 'period-1')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('readYearResult', () => {
  it('reads the trial balance without the resultatavslut, the view the declaration reads', async () => {
    await ledger([])
    expect(generateTrialBalance).toHaveBeenCalledWith({}, 'company-1', 'period-1', expect.objectContaining({ closingEntry: 'exclude-final' }))
  })

  it('counts every result account, whichever voucher booked it', async () => {
    const result = await ledger([
      row('3001', -300_000), // sales
      row('3010', -25_000), // pågående arbeten, year_end
      row('4960', 40_000), // stock count, year_end
      row('5010', 200_000),
      row('6991', 7_000), // a correction's own account
      row('7533', 5_000), // SLP
      row('7832', 10_000), // depreciation, year_end
      row('8410', 1_000), // interest
    ])
    expect(result.beforeDispositions).toBe(62_000)
    expect(result.beforeTax).toBe(62_000)
  })

  it('leaves out the balance sheet, the income tax and årets resultat', async () => {
    const result = await ledger([
      row('1930', 999_999),
      row('2099', -999_999),
      row('3001', -100_000),
      row('8910', 20_000),
      row('8920', 1_000),
      row('8930', -500),
      row('8940', 3_000),
      row('8980', 100),
      row('8990', 80_000), // an omföring by hand
      row('8999', 80_000),
    ])
    expect(result).toEqual({ beforeDispositions: 100_000, beforeTax: 100_000 })
  })

  it('keeps the dispositions apart: in resultat före skatt, not before them', async () => {
    const result = await ledger([
      row('3001', -100_000),
      row('8811', 25_000), // avsättning
      row('8819', -10_000), // återföring
      row('8853', 5_000), // överavskrivning
    ])
    expect(result).toEqual({ beforeDispositions: 100_000, beforeTax: 80_000 })
  })

  it('reads a loss as negative and adds in öre', async () => {
    const result = await ledger([row('3001', -0.1), row('3010', -0.2), row('5010', 1_000.15)])
    expect(result).toEqual({ beforeDispositions: -999.85, beforeTax: -999.85 })
  })

  it('reads an empty year as zero', async () => {
    await expect(ledger([])).resolves.toEqual({ beforeDispositions: 0, beforeTax: 0 })
  })
})
