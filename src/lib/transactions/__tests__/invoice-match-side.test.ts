import { describe, it, expect } from 'vitest'
import { invoiceMatchSide } from '../invoice-match-side'

describe('invoiceMatchSide', () => {
  it('is the supplier side for a plain 244x payment out of a bank or cash account', () => {
    expect(invoiceMatchSide({ transaction: { amount: -500 }, debitAccount: '2440', creditAccount: '1930', isBusiness: true })).toBe('supplier')
    // 244x against something that is no bank or cash account is no supplier payment.
    expect(invoiceMatchSide({ transaction: { amount: -500 }, debitAccount: '2440', creditAccount: '2893', isBusiness: true })).toBeNull()
  })

  it('is the customer side for a plain 151x receipt on a 19xx account', () => {
    expect(invoiceMatchSide({ transaction: { amount: 500 }, debitAccount: '1930', creditAccount: '1510', isBusiness: true })).toBe('customer')
    expect(invoiceMatchSide({ transaction: { amount: 500 }, debitAccount: '1680', creditAccount: '1510', isBusiness: true })).toBeNull()
  })

  it('does not apply to other accounts, the wrong direction, or a private marking', () => {
    expect(invoiceMatchSide({ transaction: { amount: -500 }, debitAccount: '5410', creditAccount: '1930', isBusiness: true })).toBeNull()
    expect(invoiceMatchSide({ transaction: { amount: 500 }, debitAccount: '2440', creditAccount: '1930', isBusiness: true })).toBeNull()
    expect(invoiceMatchSide({ transaction: { amount: -500 }, debitAccount: '2440', creditAccount: '1930', isBusiness: false })).toBeNull()
  })
})
