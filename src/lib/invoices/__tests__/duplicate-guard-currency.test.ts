import { describe, it, expect } from 'vitest'
import {
  currencyRowFilter,
  invoiceAmountSek,
  magnitudesWithinTolerance,
  normalizeCurrencyCode,
  planAmountSweeps,
  toleranceBand,
} from '@/lib/invoices/duplicate-guard-currency'

const PCT = 0.02

describe('normalizeCurrencyCode', () => {
  it('treats null/undefined/empty as SEK (the column default)', () => {
    expect(normalizeCurrencyCode(null)).toBe('SEK')
    expect(normalizeCurrencyCode(undefined)).toBe('SEK')
    expect(normalizeCurrencyCode('')).toBe('SEK')
  })

  it('upper-cases', () => {
    expect(normalizeCurrencyCode('eur')).toBe('EUR')
  })
})

describe('currencyRowFilter', () => {
  it('accepts NULL as kronor for SEK', () => {
    expect(currencyRowFilter('SEK')).toBe('currency.is.null,currency.eq.SEK')
  })

  it('is an exact match for a foreign code', () => {
    expect(currencyRowFilter('EUR')).toBe('currency.eq.EUR')
  })
})

describe('toleranceBand', () => {
  it('is symmetric around the magnitude and sign-agnostic', () => {
    expect(toleranceBand(10000, PCT)).toEqual({ low: 9800, high: 10200 })
    expect(toleranceBand(-10000, PCT)).toEqual({ low: 9800, high: 10200 })
  })
})

describe('planAmountSweeps', () => {
  it('SEK reference: exactly one sweep, band unchanged, no blind spot flagged', () => {
    const { sweeps, crossCurrencyUnverifiable } = planAmountSweeps(
      { amount: 12500, currency: 'SEK', sek: 12500 },
      PCT,
    )
    expect(sweeps).toEqual([
      {
        currencyFilter: 'currency.is.null,currency.eq.SEK',
        currency: 'SEK',
        low: 12250,
        high: 12750,
      },
    ])
    expect(crossCurrencyUnverifiable).toBe(false)
  })

  it('foreign reference with a SEK value: own-currency sweep plus a SEK sweep', () => {
    const { sweeps, crossCurrencyUnverifiable } = planAmountSweeps(
      { amount: 1000, currency: 'EUR', sek: 11500 },
      PCT,
    )
    expect(sweeps).toHaveLength(2)
    expect(sweeps[0]).toEqual({
      currencyFilter: 'currency.eq.EUR',
      currency: 'EUR',
      low: 980,
      high: 1020,
    })
    expect(sweeps[1]).toEqual({
      currencyFilter: 'currency.is.null,currency.eq.SEK',
      currency: 'SEK',
      low: 11270,
      high: 11730,
    })
    expect(crossCurrencyUnverifiable).toBe(false)
  })

  it('foreign reference without a SEK value: only the same-currency sweep, flagged', () => {
    const { sweeps, crossCurrencyUnverifiable } = planAmountSweeps(
      { amount: 1000, currency: 'EUR', sek: null },
      PCT,
    )
    expect(sweeps).toHaveLength(1)
    expect(sweeps[0].currency).toBe('EUR')
    expect(crossCurrencyUnverifiable).toBe(true)
  })

  it('refuses to build a filter from a non-ISO code', () => {
    const { sweeps, crossCurrencyUnverifiable } = planAmountSweeps(
      { amount: 1000, currency: 'SEK,FAKE.EQ.TRUE', sek: null },
      PCT,
    )
    expect(sweeps).toHaveLength(0)
    expect(crossCurrencyUnverifiable).toBe(true)
  })
})

describe('magnitudesWithinTolerance', () => {
  it('same currency: compares raw magnitudes, sign-agnostic', () => {
    expect(
      magnitudesWithinTolerance(
        { amount: 10000, currency: 'SEK', sek: 10000 },
        { amount: -10000, currency: 'SEK', sek: 10000 },
        PCT,
      ),
    ).toBe(true)
    expect(
      magnitudesWithinTolerance(
        { amount: 10000, currency: 'SEK', sek: 10000 },
        { amount: -10500, currency: 'SEK', sek: 10500 },
        PCT,
      ),
    ).toBe(false)
  })

  it('cross currency: a 1000 EUR reference does NOT match a 1000 SEK row', () => {
    expect(
      magnitudesWithinTolerance(
        { amount: 1000, currency: 'EUR', sek: 11500 },
        { amount: -1000, currency: 'SEK', sek: 1000 },
        PCT,
      ),
    ).toBe(false)
  })

  it('cross currency: a 1000 EUR reference matches the 11 500 SEK row that paid it', () => {
    expect(
      magnitudesWithinTolerance(
        { amount: 1000, currency: 'EUR', sek: 11500 },
        { amount: -11500, currency: 'SEK', sek: 11500 },
        PCT,
      ),
    ).toBe(true)
  })

  it('cross currency with no SEK value on either side: excluded, never compared raw', () => {
    expect(
      magnitudesWithinTolerance(
        { amount: 1000, currency: 'EUR', sek: null },
        { amount: -1000, currency: 'SEK', sek: 1000 },
        PCT,
      ),
    ).toBe(false)
    expect(
      magnitudesWithinTolerance(
        { amount: 1000, currency: 'EUR', sek: 11500 },
        { amount: -11500, currency: 'USD', sek: null },
        PCT,
      ),
    ).toBe(false)
  })
})

describe('invoiceAmountSek', () => {
  it('SEK invoice: the amount itself, as a magnitude', () => {
    expect(invoiceAmountSek({ amount: -12500, currency: 'SEK' })).toBe(12500)
  })

  it('foreign invoice: pro-rates total_sek down to the remaining amount', () => {
    // 1 000 EUR invoice booked at 11 500 SEK, 400 EUR still unpaid.
    expect(
      invoiceAmountSek({ amount: 400, currency: 'EUR', total: 1000, totalSek: 11500 }),
    ).toBe(4600)
  })

  it('foreign invoice: falls back to the stored exchange rate', () => {
    expect(
      invoiceAmountSek({ amount: 1000, currency: 'EUR', total: 1000, totalSek: null, exchangeRate: 11.5 }),
    ).toBe(11500)
  })

  it('treats total_sek = 0 as not stored (the invoices column DEFAULTs to 0)', () => {
    expect(
      invoiceAmountSek({ amount: 1000, currency: 'EUR', total: 1000, totalSek: 0, exchangeRate: 11.5 }),
    ).toBe(11500)
    expect(
      invoiceAmountSek({ amount: 1000, currency: 'EUR', total: 1000, totalSek: 0, exchangeRate: null }),
    ).toBeNull()
  })

  it('returns null rather than the raw foreign number when nothing converts it', () => {
    expect(invoiceAmountSek({ amount: 1000, currency: 'EUR' })).toBeNull()
    expect(
      invoiceAmountSek({ amount: 1000, currency: 'EUR', total: 1000, totalSek: null, exchangeRate: 0 }),
    ).toBeNull()
  })
})
