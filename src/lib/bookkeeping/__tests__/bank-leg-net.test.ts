/**
 * crm#1136: which lines of a verifikat are the bank side of a batch of bank
 * rows. bulk_book_transactions measures its bank net with this rule (migration
 * 20261010200000, pinned against real Postgres in
 * tests/pg/bulk-book-cash-account-ledger.pg.test.ts); bankNetAccountTest is the
 * same rule for the dialog that previews it. Counting 1900-1999 alone made a
 * cash account outside 19xx (a Stripe balance on 1686) impossible to bulk-book.
 */
import { describe, it, expect } from 'vitest'
import { bankNetAccountTest } from '../bank-leg'

type Line = [account: string, debit: number, credit: number]

/** The bank net the RPC compares with the rows' sum. */
function bankNet(settlementLedgers: string[], lines: Line[]): number {
  const isBankLine = bankNetAccountTest(settlementLedgers)
  return lines
    .filter(([account]) => isBankLine(account))
    .reduce((sum, [, debit, credit]) => sum + debit - credit, 0)
}

describe('bankNetAccountTest', () => {
  it('counts the whole 1900-1999 range for rows on a 19xx ledger, as before', () => {
    const isBankLine = bankNetAccountTest(['1930'])
    expect(['1900', '1930', '1931', '1940', '1999'].every(isBankLine)).toBe(true)
    expect(['1686', '1510', '2440', '3001', '2000', '1899'].some(isBankLine)).toBe(false)
  })

  it('never takes a malformed account for a bank line', () => {
    const isBankLine = bankNetAccountTest(['1930'])
    expect(['193', '19300', '19ab', ''].some(isBankLine)).toBe(false)
  })

  it('counts a ledger outside 19xx on that ledger alone', () => {
    const isBankLine = bankNetAccountTest(['1686'])
    expect(isBankLine('1686')).toBe(true)
    expect(['1930', '1940', '1680', '1687'].some(isBankLine)).toBe(false)
  })

  it('counts both for a batch across a 19xx ledger and another', () => {
    const isBankLine = bankNetAccountTest(['1930', '1686'])
    expect(['1686', '1930', '1940'].every(isBankLine)).toBe(true)
    expect(isBankLine('3001')).toBe(false)
  })

  it('counts nothing without rows', () => {
    expect(bankNetAccountTest([])('1930')).toBe(false)
  })
})

describe('the bank net of a verifikat, as bulk_book_transactions measures it', () => {
  it('a charge on the Stripe balance: the 1686 debit is the row', () => {
    expect(bankNet(['1686'], [['1686', 125, 0], ['3001', 0, 100], ['2611', 0, 25]])).toBe(125)
  })

  it('a payout from the Stripe balance: the 1930 debit is the other end, not the row', () => {
    const payout: Line[] = [['1930', 1000, 0], ['1686', 0, 1000]]
    // The row on 1686 left the balance...
    expect(bankNet(['1686'], payout)).toBe(-1000)
    // ...and the row on 1930 is the same money arriving at the bank.
    expect(bankNet(['1930'], payout)).toBe(1000)
  })

  it('a 1686 row booked on 1930 does not move its ledger at all', () => {
    expect(bankNet(['1686'], [['1930', 125, 0], ['3001', 0, 125]])).toBe(0)
  })

  it('rows on 19xx ledgers net over the range: a line on another 19xx account still counts (unchanged)', () => {
    expect(bankNet(['1930'], [['1940', 125, 0], ['3001', 0, 125]])).toBe(125)
    expect(bankNet(['1930'], [['1940', 100, 0], ['1930', 0, 100]])).toBe(0)
  })
})
