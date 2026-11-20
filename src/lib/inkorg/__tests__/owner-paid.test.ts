import { describe, expect, it } from 'vitest'
import { ownerPaidLines, templateCostAccount } from '../owner-paid'
import { reading } from './fixtures'

const RECEIPT = reading({ documentKind: 'receipt', supplier: { name: 'Clas Ohlson' }, totals: { total: 1249, vatAmount: 249.8 } })

describe('ownerPaidLines', () => {
  it('books the cost and the input VAT the receipt states, paid from the owner\'s account', () => {
    expect(ownerPaidLines(RECEIPT, '2018', true)).toEqual([
      { account_number: '', debit_amount: 999.2, credit_amount: 0, description: 'Clas Ohlson' },
      { account_number: '2641', debit_amount: 249.8, credit_amount: 0, description: 'Clas Ohlson' },
      { account_number: '2018', debit_amount: 0, credit_amount: 1249, description: 'Clas Ohlson' },
    ])
  })

  it('balances to the öre', () => {
    const lines = ownerPaidLines(reading({ totals: { total: 10.07, vatAmount: 2.01 } }), '2018', true)
    const debit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const credit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(Math.abs(debit - credit)).toBeLessThan(0.005)
  })

  it('keeps the whole total on the cost for a company that is not VAT-registered', () => {
    expect(ownerPaidLines(RECEIPT, '2018', false)).toEqual([
      { account_number: '', debit_amount: 1249, credit_amount: 0, description: 'Clas Ohlson' },
      { account_number: '2018', debit_amount: 0, credit_amount: 1249, description: 'Clas Ohlson' },
    ])
  })

  it('a foreign receipt gets no amounts (its kronor are typed), and still the owner\'s account', () => {
    const foreign = reading({ invoice: { currency: 'EUR' }, totals: { total: 100, vatAmount: 20 } })
    expect(ownerPaidLines(foreign, '2018', true)).toEqual([
      { account_number: '', debit_amount: 0, credit_amount: 0, description: '' },
      { account_number: '2018', debit_amount: 0, credit_amount: 0, description: '' },
    ])
  })

  it('puts the supplier\'s learned cost account on the cost line', () => {
    expect(ownerPaidLines(RECEIPT, '2018', true, '5410').map((l) => l.account_number)).toEqual(['5410', '2641', '2018'])
  })

  it('without a reading the payment side is still the owner\'s account', () => {
    expect(ownerPaidLines(null, '2018').map((l) => l.account_number)).toEqual(['', '2018'])
  })
})

describe('templateCostAccount', () => {
  const match = (debit: string, credit: string, confidence = 0.8) => ({ confidence, template: { debit_account: debit, credit_account: credit } })

  it('takes a cost account the company booked the supplier on against the bank', () => {
    expect(templateCostAccount(match('5410', '1930'))).toBe('5410')
  })

  it('never takes a template that is unsure, private or on the balance sheet', () => {
    expect(templateCostAccount(match('5410', '1930', 0.4))).toBeNull()
    expect(templateCostAccount(match('2013', '1930'))).toBeNull()
    expect(templateCostAccount(match('1220', '1930'))).toBeNull()
    expect(templateCostAccount(match('5410', '2440'))).toBeNull()
    expect(templateCostAccount(match('3041', '1930'))).toBeNull()
    expect(templateCostAccount(null)).toBeNull()
    expect(templateCostAccount({ confidence: 0.9, template: null })).toBeNull()
  })
})
