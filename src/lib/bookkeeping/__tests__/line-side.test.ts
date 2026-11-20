import { describe, it, expect } from 'vitest'
import { amountInCurrencyToStore, buildStornoLines, creditNatural, debitNatural } from '../line-side'

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

  it('rounds exact öre halves up, where naive Math.round(x * 100) / 100 rounds them down', () => {
    expect(debitNatural(1.005)).toEqual({ debit_amount: 1.01, credit_amount: 0 })
    expect(creditNatural(2.675)).toEqual({ debit_amount: 0, credit_amount: 2.68 })
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

describe('amountInCurrencyToStore (#3517)', () => {
  // A revaluation leg on a USD cash account moves kronor and no dollars: it
  // must stay readable as 0 USD, or the account's reconciliation reports
  // gl_lines_missing_currency_amount for the whole period.
  it('keeps 0 on a line labelled with a foreign currency', () => {
    expect(amountInCurrencyToStore('USD', 0)).toBe(0)
    expect(amountInCurrencyToStore('EUR', '0')).toBe(0)
    expect(amountInCurrencyToStore('usd', 0)).toBe(0)
    expect(Object.is(amountInCurrencyToStore('USD', -0), 0)).toBe(true)
  })

  it('keeps null for 0 on a SEK or unlabelled line, as before', () => {
    expect(amountInCurrencyToStore('SEK', 0)).toBeNull()
    expect(amountInCurrencyToStore(' sek ', 0)).toBeNull()
    expect(amountInCurrencyToStore(undefined, 0)).toBeNull()
    expect(amountInCurrencyToStore(null, 0)).toBeNull()
    expect(amountInCurrencyToStore('', 0)).toBeNull()
  })

  it('keeps null for missing, empty and non-numeric input', () => {
    for (const currency of ['USD', 'SEK', undefined]) {
      expect(amountInCurrencyToStore(currency, null)).toBeNull()
      expect(amountInCurrencyToStore(currency, undefined)).toBeNull()
      expect(amountInCurrencyToStore(currency, '')).toBeNull()
      expect(amountInCurrencyToStore(currency, 'abc')).toBeNull()
      expect(amountInCurrencyToStore(currency, Number.NaN)).toBeNull()
    }
  })

  it('passes every non-zero amount through unchanged, whatever the label', () => {
    expect(amountInCurrencyToStore('USD', 1150.5)).toBe(1150.5)
    expect(amountInCurrencyToStore('USD', '-12.25')).toBe(-12.25)
    expect(amountInCurrencyToStore('SEK', 100)).toBe(100)
    expect(amountInCurrencyToStore(undefined, 90.5)).toBe(90.5)
  })
})

describe('buildStornoLines: amount_in_currency', () => {
  it('mirrors a kept 0 as 0 (not -0, not null) and negates the rest', () => {
    const stornos = buildStornoLines([
      { debit_amount: 812.4, credit_amount: 0, currency: 'USD', amount_in_currency: 0 },
      { debit_amount: 0, credit_amount: 812.4, currency: 'SEK', amount_in_currency: 0 },
      { debit_amount: 1000, credit_amount: 0, currency: 'EUR', amount_in_currency: '90.50' },
      { debit_amount: 0, credit_amount: 1000, currency: 'EUR', amount_in_currency: null },
    ])
    const amounts = stornos.map((s) => s.amount_in_currency)
    expect(amounts).toEqual([0, null, -90.5, null])
    expect(Object.is(amounts[0], 0)).toBe(true)
  })
})
