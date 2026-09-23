import { describe, expect, it } from 'vitest'
import { getAmountToPay, getDisplayTotal } from '@/lib/invoices/rounding'

const inv = (total: number, currency: 'SEK' | 'EUR' = 'SEK') => ({ total, currency })
const co = (ore_rounding: boolean) => ({ ore_rounding })

describe('getDisplayTotal', () => {
  it('rounds SEK with rounding enabled and a non-integer total', () => {
    const r = getDisplayTotal(inv(1234.56), co(true))
    expect(r.applies).toBe(true)
    expect(r.displayed).toBe(1235)
    expect(r.roundingDelta).toBe(0.44)
  })

  it('rounds down when fractional part < 0.5', () => {
    const r = getDisplayTotal(inv(1234.4), co(true))
    expect(r.applies).toBe(true)
    expect(r.displayed).toBe(1234)
    expect(r.roundingDelta).toBe(-0.4)
  })

  it('does not apply when setting is disabled', () => {
    const r = getDisplayTotal(inv(1234.56), co(false))
    expect(r.applies).toBe(false)
    expect(r.displayed).toBe(1234.56)
    expect(r.roundingDelta).toBe(0)
  })

  it('does not apply for non-SEK currencies', () => {
    const r = getDisplayTotal(inv(1234.56, 'EUR'), co(true))
    expect(r.applies).toBe(false)
    expect(r.displayed).toBe(1234.56)
  })

  it('does not apply when total is already an integer', () => {
    const r = getDisplayTotal(inv(1235), co(true))
    expect(r.applies).toBe(false)
    expect(r.displayed).toBe(1235)
    expect(r.roundingDelta).toBe(0)
  })

  it('treats missing company settings as default-on', () => {
    const r = getDisplayTotal(inv(99.99), null)
    expect(r.applies).toBe(true)
    expect(r.displayed).toBe(100)
  })

  it('per-invoice flag (true) wins over a disabled company setting', () => {
    const r = getDisplayTotal({ total: 99.99, currency: 'SEK', ore_rounding: true }, co(false))
    expect(r.applies).toBe(true)
    expect(r.displayed).toBe(100)
  })

  it('per-invoice flag (false) wins over an enabled company setting', () => {
    const r = getDisplayTotal({ total: 99.99, currency: 'SEK', ore_rounding: false }, co(true))
    expect(r.applies).toBe(false)
    expect(r.displayed).toBe(99.99)
  })

  it('null per-invoice flag falls back to the company setting', () => {
    const r = getDisplayTotal({ total: 99.99, currency: 'SEK', ore_rounding: null }, co(true))
    expect(r.applies).toBe(true)
    expect(r.displayed).toBe(100)
  })

  it('null per-invoice flag with company-off resolves to off (supplier-invoice convention)', () => {
    const r = getDisplayTotal({ total: 99.99, currency: 'SEK', ore_rounding: null }, co(false))
    expect(r.applies).toBe(false)
    expect(r.displayed).toBe(99.99)
  })
})

describe('getAmountToPay', () => {
  it('equals the rounded display total when there is no deduction', () => {
    const r = getAmountToPay(inv(1234.56), co(true))
    expect(r.toPay).toBe(1235)
    expect(r.deductionApplies).toBe(false)
    expect(r.rounding.applies).toBe(true)
    expect(r.rounding.roundingDelta).toBe(0.44)
  })

  it('subtracts the ROT/RUT deduction from the ROUNDED total', () => {
    const r = getAmountToPay({ ...inv(1234.56), deduction_total: 500 }, co(true))
    expect(r.deductionApplies).toBe(true)
    expect(r.toPay).toBe(735)
  })

  it('subtracts the deduction from the raw total when rounding is off', () => {
    const r = getAmountToPay({ ...inv(1234.56), deduction_total: 500 }, co(false))
    expect(r.rounding.applies).toBe(false)
    expect(r.toPay).toBe(734.56)
  })

  it('keeps öre precision in the deduction subtraction', () => {
    // 1235 - 166.67 must not pick up float noise.
    const r = getAmountToPay({ ...inv(1234.56), deduction_total: 166.67 }, co(true))
    expect(r.toPay).toBe(1068.33)
  })

  it('ignores the deduction on credit notes (fakturamodellen does not apply)', () => {
    const r = getAmountToPay(
      { ...inv(-1234.56), deduction_total: 500, credited_invoice_id: 'inv-1' },
      co(true),
    )
    expect(r.deductionApplies).toBe(false)
    expect(r.toPay).toBe(-1235)
  })

  it('does not round non-SEK invoices but still applies the deduction', () => {
    const r = getAmountToPay({ ...inv(1234.56, 'EUR'), deduction_total: 100 }, co(true))
    expect(r.rounding.applies).toBe(false)
    expect(r.toPay).toBe(1134.56)
  })
})
