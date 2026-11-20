import { describe, expect, it } from 'vitest'
import { mapTrialBalancesToK2, type TrialBalanceRowLike } from '../../ixbrl/k2-mapper'
import { calculateSoliditet } from '../build-data'

function row(
  account: string,
  debit: number,
  credit: number,
): TrialBalanceRowLike {
  return {
    account_number: account,
    account_name: `Account ${account}`,
    closing_debit: debit,
    closing_credit: credit,
  }
}

describe('calculateSoliditet', () => {
  it('returns null when total assets are non-positive', () => {
    const mapping = mapTrialBalancesToK2({ full: [], preClosing: [] }, null)

    expect(calculateSoliditet(mapping)).toBeNull()
  })

  it('uses adjusted equity and the sign-reclassified balance-sheet total', () => {
    const full = [
      row('1630', 0, 22_985),
      row('1930', 17_428.36, 0),
      row('1940', 749_306.35, 0),
      row('2081', 0, 25_000),
      row('2099', 0, 469_542.21),
      row('2125', 0, 197_574),
      row('2512', 0, 123_180),
      row('2518', 101_970, 0),
      row('2641', 1_387.5, 0),
      row('2891', 0, 23_223),
      row('2893', 0, 8_588),
    ]
    const mapping = mapTrialBalancesToK2({ full, preClosing: full }, null)

    expect(mapping.br['OvrigaFordringarKortfristiga'].current).toBe(1_387)
    expect(mapping.br['KassaBankExklRedovisningsmedel'].current).toBe(766_735)
    expect(mapping.br['Skatteskulder'].current).toBe(44_195)
    expect(mapping.br['OvrigaKortfristigaSkulder'].current).toBe(31_811)
    expect(mapping.br['Periodiseringsfonder'].current).toBe(197_574)
    expect(mapping.totals.tillgangar.current).toBe(768_122)
    expect(mapping.totals.egetKapitalSkulder.current).toBe(768_122)
    expect(calculateSoliditet(mapping)).toBe(84.8)
  })

  it('counts the result of a prior year that was never closed in the books (crm#1080)', () => {
    // A flerårsöversikt year: 200 000 kr assets, 50 000 kr aktiekapital,
    // 100 000 kr liabilities and a 50 000 kr result still on the result
    // accounts. Equity is 100 000 kr, not the 50 000 kr that is booked.
    const rows = [
      row('1930', 200_000, 0),
      row('2081', 0, 50_000),
      row('2440', 0, 100_000),
      row('3010', 0, 50_000),
    ]
    const pair = { full: rows, preClosing: rows }

    expect(calculateSoliditet(mapTrialBalancesToK2(pair, null, { currentIsPriorYear: true }))).toBe(50)
    // The current year is never derived: its closing has to be booked.
    expect(calculateSoliditet(mapTrialBalancesToK2(pair, null))).toBe(25)
  })
})
