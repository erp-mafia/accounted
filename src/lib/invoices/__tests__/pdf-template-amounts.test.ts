import { describe, expect, it } from 'vitest'
import type { InvoiceItem } from '@/types'
import { buildPdfVatBreakdown, formatPdfCurrency } from '@/lib/invoices/pdf-template'

function makeItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'invoice-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Invoice row',
    quantity: 1,
    unit: 'st',
    unit_price: 100,
    line_total: 100,
    vat_rate: 25,
    vat_amount: 25,
    ...overrides,
  }
}

describe('formatPdfCurrency', () => {
  it('uses a PDF-safe minus for Swedish negative amounts', () => {
    const formatted = formatPdfCurrency(-12.34, 'SEK', 'sv')

    expect(formatted).toBe('-12,34 SEK')
    expect(formatted).not.toContain('\u2212')
  })

  it('preserves English negative amount formatting', () => {
    expect(formatPdfCurrency(-12.34, 'SEK', 'en')).toBe('-12.34 SEK')
  })

  it('does not change positive Swedish amount formatting', () => {
    expect(formatPdfCurrency(18_992.2, 'SEK', 'sv')).toBe('18\u00a0992,20 SEK')
  })
})

describe('buildPdfVatBreakdown', () => {
  it('subtracts a negative adjustment from its VAT group', () => {
    const breakdown = buildPdfVatBreakdown([
      makeItem({ id: 'sale', line_total: 100, vat_amount: 25 }),
      makeItem({ id: 'deduction', line_total: -12.34, vat_amount: -3.09 }),
    ])

    expect(breakdown.get(25)).toEqual({ base: 87.66, vat: 21.91 })
  })

  it('keeps whole credit-note VAT groups negative', () => {
    const breakdown = buildPdfVatBreakdown([
      makeItem({ line_total: -100, vat_amount: -25 }),
    ])

    expect(breakdown.get(25)).toEqual({ base: -100, vat: -25 })
  })

  it('keeps mixed VAT rates signed and excludes text rows', () => {
    const breakdown = buildPdfVatBreakdown([
      makeItem({ id: 'rate-25', line_total: 200, vat_rate: 25, vat_amount: 50 }),
      makeItem({ id: 'rate-12', line_total: 100, vat_rate: 12, vat_amount: 12 }),
      makeItem({ id: 'rate-12-deduction', line_total: -20, vat_rate: 12, vat_amount: -2.4 }),
      makeItem({ id: 'text', line_type: 'text', line_total: 999, vat_rate: 25, vat_amount: 999 }),
    ])

    expect(breakdown.get(25)).toEqual({ base: 200, vat: 50 })
    expect(breakdown.get(12)).toEqual({ base: 80, vat: 9.6 })
  })
})
