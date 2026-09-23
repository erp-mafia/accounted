import { describe, it, expect } from 'vitest'
import { supplierInvoiceDisplayFigures } from '../display-figures'

describe('supplierInvoiceDisplayFigures', () => {
  it('rounds a SEK total to whole kronor when the per-invoice flag is on', () => {
    const f = supplierInvoiceDisplayFigures({ total: 1234.37, currency: 'SEK', ore_rounding: true })
    expect(f.exactTotal).toBe(1234.37)
    expect(f.toPay).toBe(1234)
    expect(f.rounding).toEqual({ displayed: 1234, roundingDelta: -0.37, applies: true })
  })

  it('rounds up past the half krona', () => {
    const f = supplierInvoiceDisplayFigures({ total: 99.5, currency: 'SEK', ore_rounding: true })
    expect(f.toPay).toBe(100)
    expect(f.rounding.roundingDelta).toBe(0.5)
    expect(f.rounding.applies).toBe(true)
  })

  it('keeps the exact total untouched by rounding', () => {
    const f = supplierInvoiceDisplayFigures({ total: 1234.37, currency: 'SEK', ore_rounding: true })
    expect(f.exactTotal).toBe(1234.37)
    expect(f.toPay - f.exactTotal).toBeCloseTo(f.rounding.roundingDelta, 2)
  })

  it('does not apply when the total is already whole kronor', () => {
    const f = supplierInvoiceDisplayFigures({ total: 500, currency: 'SEK', ore_rounding: true })
    expect(f.toPay).toBe(500)
    expect(f.rounding).toEqual({ displayed: 500, roundingDelta: 0, applies: false })
  })

  it('resolves a null flag to off: supplier invoices never had a company-wide setting', () => {
    const f = supplierInvoiceDisplayFigures({ total: 1234.37, currency: 'SEK', ore_rounding: null })
    expect(f.toPay).toBe(1234.37)
    expect(f.rounding.applies).toBe(false)
  })

  it('resolves an absent flag to off', () => {
    const f = supplierInvoiceDisplayFigures({ total: 1234.37, currency: 'SEK' })
    expect(f.toPay).toBe(1234.37)
    expect(f.rounding.applies).toBe(false)
  })

  it('is off when the flag is explicitly false', () => {
    const f = supplierInvoiceDisplayFigures({ total: 1234.37, currency: 'SEK', ore_rounding: false })
    expect(f.toPay).toBe(1234.37)
    expect(f.rounding.applies).toBe(false)
  })

  it('never rounds a foreign-currency total', () => {
    const f = supplierInvoiceDisplayFigures({ total: 1234.37, currency: 'EUR', ore_rounding: true })
    expect(f.toPay).toBe(1234.37)
    expect(f.rounding).toEqual({ displayed: 1234.37, roundingDelta: 0, applies: false })
  })

  it('keeps the rounding delta strictly under one krona (the 3740 settlement band)', () => {
    for (let ore = 1; ore < 100; ore++) {
      const total = Math.round((250 * 100 + ore)) / 100
      const f = supplierInvoiceDisplayFigures({ total, currency: 'SEK', ore_rounding: true })
      expect(Math.abs(f.rounding.roundingDelta)).toBeLessThan(1)
      expect(Number.isInteger(f.toPay)).toBe(true)
    }
  })
})
