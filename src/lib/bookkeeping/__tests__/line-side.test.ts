import { describe, it, expect } from 'vitest'
import { creditNatural, debitNatural } from '../line-side'

describe('line-side: signed amount to one-sided line amounts', () => {
  it('debitNatural books a positive amount as debit', () => {
    expect(debitNatural(16000)).toEqual({ debit_amount: 16000, credit_amount: 0 })
  })

  it('debitNatural flips a negative amount to the credit side (öresavrundning on 3740)', () => {
    expect(debitNatural(-0.25)).toEqual({ debit_amount: 0, credit_amount: 0.25 })
  })

  it('creditNatural books a positive amount as credit', () => {
    expect(creditNatural(1000)).toEqual({ debit_amount: 0, credit_amount: 1000 })
  })

  it('creditNatural flips a negative amount to the debit side', () => {
    expect(creditNatural(-0.5)).toEqual({ debit_amount: 0.5, credit_amount: 0 })
  })

  it('rounds to öre on both sides and keeps zero as 0/0', () => {
    expect(debitNatural(10.005)).toEqual({ debit_amount: 10.01, credit_amount: 0 })
    expect(creditNatural(-10.004)).toEqual({ debit_amount: 10, credit_amount: 0 })
    expect(debitNatural(0)).toEqual({ debit_amount: 0, credit_amount: 0 })
  })

  it('never returns a negative side', () => {
    for (const n of [-1234.56, -0.01, 0, 0.01, 1234.56]) {
      for (const fn of [debitNatural, creditNatural]) {
        const r = fn(n)
        expect(r.debit_amount).toBeGreaterThanOrEqual(0)
        expect(r.credit_amount).toBeGreaterThanOrEqual(0)
        const net = Math.round((r.debit_amount - r.credit_amount) * 100) / 100
        const expected = Math.round(n * 100) / 100
        expect(net + 0).toBe((fn === debitNatural ? expected : -expected) + 0)
      }
    }
  })
})
