import { describe, it, expect } from 'vitest'
import { buildStornoLines, creditNatural, debitNatural } from '../line-side'

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

describe('buildStornoLines', () => {
  // Parity: for every well-formed line (one positive side) the storno equals
  // the plain swap correctEntry used to write itself.
  it('swaps the sides of well-formed lines, like the plain swap', () => {
    const lines = [
      { debit_amount: 1000, credit_amount: 0, amount_in_currency: 90.5 },
      { debit_amount: 0, credit_amount: 1000, amount_in_currency: null },
      { debit_amount: 0.01, credit_amount: 0 },
      { debit_amount: 0, credit_amount: 12345.67 },
    ]
    for (const storno of buildStornoLines(lines)) {
      expect({ debit: storno.debit_amount, credit: storno.credit_amount }).toEqual({
        debit: Math.round((Number(storno.line.credit_amount) || 0) * 100) / 100,
        credit: Math.round((Number(storno.line.debit_amount) || 0) * 100) / 100,
      })
    }
    expect(buildStornoLines(lines).map((s) => s.amount_in_currency)).toEqual([-90.5, null, null, null])
  })

  // A line booked before the non-negative CHECK: debit -0.25 is a credit of
  // 0.25 in effect. The plain swap wrote credit -0.25, which the CHECK refuses,
  // so the rättelse of such a verifikat failed while storno succeeded.
  it('reverses a legacy negative-side line to a positive line on the opposite side', () => {
    const [storno] = buildStornoLines([{ debit_amount: -0.25, credit_amount: 0 }])
    expect(storno).toMatchObject({ debit_amount: 0.25, credit_amount: 0 })
    const [other] = buildStornoLines([{ debit_amount: 0, credit_amount: -12.5 }])
    expect(other).toMatchObject({ debit_amount: 0, credit_amount: 12.5 })
  })

  it('reads numeric strings and nulls', () => {
    const [storno] = buildStornoLines([{ debit_amount: '100.10', credit_amount: null }])
    expect(storno).toMatchObject({ debit_amount: 0, credit_amount: 100.1 })
  })
})
