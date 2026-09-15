import { describe, expect, it } from 'vitest'
import { computePropertyBlock, taxationYearOf } from '../privatbostadsforetag'

function row(account: string, debit: number, credit: number) {
  return { account_number: account, closing_debit: debit, closing_credit: credit }
}

describe('computePropertyBlock (IL 39 kap. 25 §)', () => {
  const rows = [
    row('3020', 0, 2_400_000), // årsavgifter
    row('3012', 0, 300_000), // lokalhyra
    row('3901', 0, 5_000), // medlemsavgifter (class 3: property block for a BRF)
    row('4110', 150_000, 0),
    row('5191', 71_360, 0), // fastighetsavgift
    row('6310', 40_000, 0),
    row('7830', 900_000, 0), // avskrivning byggnad
    row('8311', 0, 12_000), // ränteintäkter bank: taxable
    row('8410', 800_000, 0), // räntekostnader fastighetslån
    row('8423', 500, 0), // räntekostnader skatter: separate detected item, never here
    row('8811', 100_000, 0), // periodiseringsfond: outside the block
    row('8910', 2_472, 0), // skatt: 4.3a, outside
    row('8999', 0, 12_000),
  ]

  it('splits the pre-closing books into the property block and the taxable residue', () => {
    const block = computePropertyBlock(rows)
    expect(block.propertyIncome).toBe(2_705_000)
    expect(block.propertyCosts).toBe(150_000 + 71_360 + 40_000 + 900_000 + 800_000)
    expect(block.taxableCapitalIncome).toBe(12_000)
    expect(block.costAccounts.map((a) => a.accountNumber)).not.toContain('8423')
    expect(block.costAccounts.map((a) => a.accountNumber)).not.toContain('8811')
    expect(block.costAccounts.map((a) => a.accountNumber)).not.toContain('8910')
    // The residue an äkta BRF is taxed on: bokfört resultat + costs − income.
    const bookedResult = 2_705_000 + 12_000 - block.propertyCosts - 500 - 100_000 - 2_472
    const residue = bookedResult + block.propertyCosts - block.propertyIncome
    expect(residue).toBe(12_000 - 500 - 100_000 - 2_472)
  })

  it('reads each account in its own direction and ignores contra balances', () => {
    const block = computePropertyBlock([
      row('3020', 50_000, 0), // a debit on a revenue account is not income
      row('3021', 0, 80_000),
      row('4110', 0, 10_000), // a credit on a cost account is not a cost
      row('6310', 25_000, 5_000),
      row('8500', 3_000, 0), // övriga finansiella kostnader: informational
    ])
    expect(block.propertyIncome).toBe(80_000)
    expect(block.propertyCosts).toBe(20_000)
    expect(block.otherFinancialCosts).toBe(3_000)
    expect(block.incomeAccounts).toEqual([{ accountNumber: '3021', amount: 80_000 }])
  })

  it('is empty for books without class 3-8 activity', () => {
    const block = computePropertyBlock([row('1930', 100, 0), row('2083', 0, 100)])
    expect(block).toMatchObject({ propertyIncome: 0, propertyCosts: 0, taxableCapitalIncome: 0 })
  })
})

describe('taxationYearOf', () => {
  it('is the calendar year the räkenskapsår ends in', () => {
    expect(taxationYearOf('2026-12-31')).toBe(2026)
    expect(taxationYearOf('2027-06-30')).toBe(2027)
  })
})
