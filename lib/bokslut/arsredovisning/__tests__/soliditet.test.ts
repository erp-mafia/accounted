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
})
