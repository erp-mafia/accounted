import { describe, expect, it } from 'vitest'
import { pickPaymentAccount } from '../payment-account-choice'

const checking = { id: 'checking', ledger_account: '1930' }
const savings = { id: 'savings', ledger_account: '1931' }
const payable = [checking, savings]

describe('pickPaymentAccount', () => {
  it('opens a salary run on the account its verifikat credits, over the account a supplier payment used last (PH 220)', () => {
    expect(pickPaymentAccount(payable, { preferred: 'checking', remembered: 'savings' })).toBe(checking)
  })

  it('keeps the account paid from last time when the dialog has no preferred account', () => {
    expect(pickPaymentAccount(payable, { preferred: null, remembered: 'savings' })).toBe(savings)
  })

  it('passes over a preferred account that cannot pay: the remembered one, else the first payable', () => {
    expect(pickPaymentAccount(payable, { preferred: 'card-or-disabled', remembered: 'savings' })).toBe(savings)
    expect(pickPaymentAccount(payable, { preferred: 'card-or-disabled', remembered: null })).toBe(checking)
  })

  it('falls back to the first payable account, and to nothing without one', () => {
    expect(pickPaymentAccount(payable, {})).toBe(checking)
    expect(pickPaymentAccount([], { preferred: 'checking', remembered: 'savings' })).toBeUndefined()
  })
})
