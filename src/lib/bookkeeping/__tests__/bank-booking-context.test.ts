import { describe, it, expect } from 'vitest'
import { booksBankLineInBankDirection, booksForeignAmountAsKronor } from '../bank-booking-context'

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

describe('booksForeignAmountAsKronor (accounted#58)', () => {
  const noRate = { amount: -100, currency: 'EUR', amount_sek: null, exchange_rate: null }

  it('catches the prefill that books a rate-less EUR row 1:1 on the bank ledger', () => {
    expect(booksForeignAmountAsKronor([line('6200', 100, 0), line('1930', 0, 100)], '1930', noRate)).toBe(true)
    expect(booksForeignAmountAsKronor([line('1930', 250, 0), line('3001', 0, 250)], '1930', { ...noRate, amount: 250 })).toBe(true)
  })

  it('lets kronor typed from the bank statement through', () => {
    expect(booksForeignAmountAsKronor([line('6200', 1150, 0), line('1930', 0, 1150)], '1930', noRate)).toBe(false)
  })

  it('never fires for a row that carries a SEK value or is in SEK', () => {
    const lines = [line('6200', 100, 0), line('1930', 0, 100)]
    expect(booksForeignAmountAsKronor(lines, '1930', { ...noRate, amount_sek: -1150 })).toBe(false)
    expect(booksForeignAmountAsKronor(lines, '1930', { ...noRate, exchange_rate: 11.5 })).toBe(false)
    expect(booksForeignAmountAsKronor(lines, '1930', { ...noRate, currency: 'SEK' })).toBe(false)
    expect(booksForeignAmountAsKronor(lines, '1930', { ...noRate, currency: null })).toBe(false)
  })

  it('looks only at the bank ledger line', () => {
    expect(booksForeignAmountAsKronor([line('6200', 100, 0), line('1930', 0, 1150), line('3740', 0, -1050)], '1930', noRate)).toBe(false)
  })
})
