import { describe, it, expect } from 'vitest'
import { booksBankLineInBankDirection } from '../bank-booking-context'

const line = (account_number: string, debit_amount: number, credit_amount: number) =>
  ({ account_number, debit_amount, credit_amount })

describe('booksBankLineInBankDirection', () => {
  it('wants a credit on the bank ledger for a withdrawal', () => {
    expect(booksBankLineInBankDirection([line('6200', 500, 0), line('1930', 0, 500)], '1930', -500)).toBe(true)
    expect(booksBankLineInBankDirection([line('1930', 25000, 0), line('1933', 0, 25000)], '1930', -25000)).toBe(false)
  })

  it('wants a debit on the bank ledger for a deposit', () => {
    expect(booksBankLineInBankDirection([line('1930', 500, 0), line('3001', 0, 500)], '1930', 500)).toBe(true)
    expect(booksBankLineInBankDirection([line('6200', 500, 0), line('1930', 0, 500)], '1930', 500)).toBe(false)
  })

  it('refuses lines that never touch the bank ledger', () => {
    expect(booksBankLineInBankDirection([line('6200', 500, 0), line('1933', 0, 500)], '1930', -500)).toBe(false)
  })

  it('leaves a zero amount to the database', () => {
    expect(booksBankLineInBankDirection([line('6200', 0, 0)], '1930', 0)).toBe(true)
  })
})
