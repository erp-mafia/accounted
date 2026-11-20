/**
 * payment-fee.ts: the rule for a payment provider's fee withheld from a
 * customer payment (crm#1364), shared by the match plan and both payment
 * builders.
 */
import { describe, it, expect } from 'vitest'
import {
  PAYMENT_FEE_ACCOUNT,
  isPaymentFeeAccount,
  paymentFeeAllowed,
  paymentFeeLine,
  paymentFeeShortfall,
} from '../payment-fee'

describe('PAYMENT_FEE_ACCOUNT', () => {
  it('is the payment_fees role: 6570 Bankkostnader in the SE pack', () => {
    expect(PAYMENT_FEE_ACCOUNT).toBe('6570')
  })
})

describe('paymentFeeShortfall', () => {
  it('is what the bank moved short of what was owed, from a krona up', () => {
    expect(paymentFeeShortfall(34429.04, 33773.05)).toBe(655.99)
    expect(paymentFeeShortfall(100, 99)).toBe(1)
  })

  it('is 0 for an exact, overpaid or öre-rounded settlement', () => {
    expect(paymentFeeShortfall(100, 100)).toBe(0)
    expect(paymentFeeShortfall(100, 120)).toBe(0)
    expect(paymentFeeShortfall(812.4, 812)).toBe(0)
  })
})

describe('paymentFeeAllowed', () => {
  it('takes a fee on 6570 strictly under a tenth of what was owed', () => {
    expect(paymentFeeAllowed('6570', 655.99, 34429.04)).toBe(true)
    expect(paymentFeeAllowed('6570', 999.99, 10000)).toBe(true)
    expect(paymentFeeAllowed('6570', 1000, 10000)).toBe(false)
  })

  it('refuses any other account and a non-positive fee', () => {
    expect(paymentFeeAllowed('6064', 10, 1000)).toBe(false)
    expect(paymentFeeAllowed('6570', 0, 1000)).toBe(false)
    expect(isPaymentFeeAccount(PAYMENT_FEE_ACCOUNT)).toBe(true)
    expect(isPaymentFeeAccount(6570)).toBe(false)
  })
})

describe('paymentFeeLine', () => {
  it('debits the fee account, with no VAT line beside it', () => {
    expect(paymentFeeLine(655.99, '6570')).toEqual({
      account_number: '6570',
      debit_amount: 655.99,
      credit_amount: 0,
      line_description: 'Avgift betaltjänst',
    })
  })
})
