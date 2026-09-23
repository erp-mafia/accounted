/**
 * Coverage for the per-currency totalling behind the "Bokför valda" underlag
 * dialog. The dialog itself is never rendered here (Vitest runs in the `node`
 * environment, no component tests in this repo), which is exactly why the rule
 * was extracted into a pure module.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeUnderlagCurrency,
  summarizeUnderlagTotals,
  type UnderlagTotalsItem,
} from '../bulk-book-inbox-totals'
import type { InvoiceExtractionResult } from '@/types'

/** Minimal extraction shaped like the real one; only the read fields matter. */
function item(total: number | null, currency?: string | null): UnderlagTotalsItem {
  return {
    extracted_data: {
      supplier: { name: null, orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null },
      // `currency` is typed non-nullable on InvoiceExtractionResult, but rows
      // written before the field existed really do arrive without it, so the
      // cast reproduces the shape the dialog actually receives at runtime.
      invoice: {
        invoiceNumber: null,
        invoiceDate: null,
        dueDate: null,
        paymentReference: null,
        currency: currency as string,
      },
      lineItems: [],
      totals: { subtotal: null, vatAmount: null, total },
      vatBreakdown: [],
      confidence: 1,
    } as InvoiceExtractionResult,
  }
}

describe('normalizeUnderlagCurrency', () => {
  it('passes through a well-formed code, uppercased', () => {
    expect(normalizeUnderlagCurrency('EUR')).toBe('EUR')
    expect(normalizeUnderlagCurrency('eur')).toBe('EUR')
    expect(normalizeUnderlagCurrency(' usd ')).toBe('USD')
  })

  it('treats a missing currency as SEK (legacy extractions predate the field)', () => {
    expect(normalizeUnderlagCurrency(null)).toBe('SEK')
    expect(normalizeUnderlagCurrency(undefined)).toBe('SEK')
    expect(normalizeUnderlagCurrency('')).toBe('SEK')
    expect(normalizeUnderlagCurrency('   ')).toBe('SEK')
  })

  it('falls back to SEK on a malformed code rather than letting Intl throw', () => {
    // formatCurrency() -> Intl.NumberFormat raises RangeError on these, and the
    // value comes from AI extraction of a PDF, so it is not trustworthy input.
    expect(normalizeUnderlagCurrency('Euro')).toBe('SEK')
    expect(normalizeUnderlagCurrency('kr')).toBe('SEK')
    expect(normalizeUnderlagCurrency('12')).toBe('SEK')
  })
})

describe('summarizeUnderlagTotals: single-currency selections still work', () => {
  it('sums a plain SEK selection into one entry', () => {
    const totals = summarizeUnderlagTotals([
      item(1000, 'SEK'),
      item(250.5, 'SEK'),
      item(99.25, 'SEK'),
    ])
    expect(totals).toEqual([{ currency: 'SEK', total: 1349.75 }])
  })

  it('keeps a homogeneous foreign selection in its own currency, not SEK', () => {
    // The old code rendered this through formatCurrency() with the SEK
    // default, so 3 000 EUR read as "3 000 kr".
    const totals = summarizeUnderlagTotals([item(1000, 'EUR'), item(2000, 'EUR')])
    expect(totals).toEqual([{ currency: 'EUR', total: 3000 }])
  })

  it('rounds to öre with Math.round(x * 100) / 100, never toFixed', () => {
    const totals = summarizeUnderlagTotals([item(0.1, 'SEK'), item(0.2, 'SEK')])
    expect(totals).toEqual([{ currency: 'SEK', total: 0.3 }])
  })
})

describe('summarizeUnderlagTotals: a legacy NULL + SEK batch is NOT a currency mix', () => {
  it('groups a missing currency with SEK instead of reporting two currencies', () => {
    const totals = summarizeUnderlagTotals([
      item(500, null),
      item(300, 'SEK'),
      item(200, undefined),
      item(100, ''),
    ])
    expect(totals).toHaveLength(1)
    expect(totals).toEqual([{ currency: 'SEK', total: 1100 }])
  })

  it('does not split lowercase sek away from SEK', () => {
    const totals = summarizeUnderlagTotals([item(10, 'sek'), item(20, 'SEK')])
    expect(totals).toEqual([{ currency: 'SEK', total: 30 }])
  })
})

describe('summarizeUnderlagTotals: mixed selections report per-currency subtotals', () => {
  it('never collapses two currencies into one scalar', () => {
    const totals = summarizeUnderlagTotals([
      item(100, 'SEK'),
      item(100, 'EUR'),
      item(50, 'SEK'),
    ])
    expect(totals).toEqual([
      { currency: 'EUR', total: 100 },
      { currency: 'SEK', total: 150 },
    ])
    // The old scalar would have been 250, a number denominated in nothing.
    expect(totals.reduce((s, t) => s + t.total, 0)).not.toBe(totals[0]!.total)
  })

  it('sorts by currency code so the list is stable across renders', () => {
    const totals = summarizeUnderlagTotals([item(1, 'USD'), item(1, 'EUR'), item(1, 'SEK')])
    expect(totals.map((t) => t.currency)).toEqual(['EUR', 'SEK', 'USD'])
  })

  it('separates a legacy NULL (SEK) from a genuine foreign underlag', () => {
    const totals = summarizeUnderlagTotals([item(400, null), item(600, 'EUR')])
    expect(totals).toEqual([
      { currency: 'EUR', total: 600 },
      { currency: 'SEK', total: 400 },
    ])
  })
})

describe('summarizeUnderlagTotals: items without an extracted amount', () => {
  it('returns an empty list when nothing was extracted', () => {
    expect(summarizeUnderlagTotals([])).toEqual([])
    expect(summarizeUnderlagTotals([{ extracted_data: null }])).toEqual([])
    expect(summarizeUnderlagTotals([item(null, 'SEK')])).toEqual([])
  })

  it('skips a null total instead of counting it as zero in that currency', () => {
    const totals = summarizeUnderlagTotals([item(null, 'EUR'), item(100, 'SEK')])
    expect(totals).toEqual([{ currency: 'SEK', total: 100 }])
  })

  it('ignores a non-finite total rather than poisoning the subtotal with NaN', () => {
    const totals = summarizeUnderlagTotals([item(Number.NaN, 'SEK'), item(100, 'SEK')])
    expect(totals).toEqual([{ currency: 'SEK', total: 100 }])
  })
})
