/**
 * The quantity cell on the invoice PDF (crm#1480 follow-up). The unit already
 * follows the quantity ("2 dagar"); the quantity itself was printed raw, so a
 * Swedish invoice read "1.5 dagar" beside amounts written "1 500,00".
 */
import { describe, expect, it } from 'vitest'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { formatPdfQuantity } from '@/lib/invoices/pdf/format'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { treeElements, treeTextLeaves } from './pdf-tree'
import type { InvoiceItem } from '@/types'

function row(overrides: Partial<InvoiceItem>): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Konsultdag',
    quantity: 1,
    unit: 'dag',
    unit_price: 8000,
    line_total: 8000,
    vat_rate: 25,
    vat_amount: 2000,
    created_at: '2026-10-30T00:00:00Z',
    ...overrides,
  }
}

/** Every cell of the rendered invoice as the text it prints, its leaves joined. */
function cells(items: InvoiceItem[], language: 'sv' | 'en' = 'sv'): string[] {
  const tree = InvoicePDF({
    invoice: makeInvoice({ id: 'inv-1', status: 'sent', invoice_number: '1001', total: 10000 }),
    customer: makeCustomer({ language }),
    items,
    company: makeCompanySettings(),
    paymentQr: null,
  })
  return treeElements(tree).map((el) => treeTextLeaves(el).join(''))
}

describe('formatPdfQuantity', () => {
  it('writes a Swedish decimal comma and an English decimal point', () => {
    expect(formatPdfQuantity(1.5, 'sv')).toBe('1,5')
    expect(formatPdfQuantity(1.5, 'en')).toBe('1.5')
    expect(formatPdfQuantity(0.25)).toBe('0,25')
  })

  it('prints a whole quantity exactly as before', () => {
    expect(formatPdfQuantity(2, 'sv')).toBe('2')
    expect(formatPdfQuantity(2, 'en')).toBe('2')
  })

  it('keeps every stored decimal and groups no digits, so the column keeps its width', () => {
    expect(formatPdfQuantity(1.333333, 'sv')).toBe('1,333333')
    expect(formatPdfQuantity(12500, 'sv')).toBe('12500')
    expect(formatPdfQuantity(1250.75, 'sv')).toBe('1250,75')
  })

  it('signs a credit note row with the ASCII minus a standard PDF font can draw', () => {
    expect(formatPdfQuantity(-1.5, 'sv')).toBe('-1,5')
    expect(formatPdfQuantity(-1.5, 'sv')).not.toContain('−')
  })

  it('prints nothing for a missing quantity', () => {
    expect(formatPdfQuantity(null, 'sv')).toBe('')
    expect(formatPdfQuantity(undefined, 'en')).toBe('')
  })
})

describe('quantity cell on the invoice PDF', () => {
  it('prints a fractional Swedish quantity with a comma and the unit in the plural', () => {
    expect(cells([row({ quantity: 1.5, line_total: 12000 })])).toContain('1,5 dagar')
  })

  it('prints the same row in English with a point', () => {
    const printed = cells([row({ quantity: 1.5, line_total: 12000 })], 'en')
    expect(printed).toContain('1.5 days')
    expect(printed).not.toContain('1,5 days')
  })

  it('prints whole quantities and abbreviations as before', () => {
    expect(cells([row({ quantity: 2, line_total: 16000 })])).toContain('2 dagar')
    expect(cells([row({ quantity: 1 })])).toContain('1 dag')
    expect(cells([row({ quantity: 7.5, unit: 'tim', line_total: 7500 })])).toContain('7,5 tim')
  })

  it('prints a credited fractional row signed, with the comma', () => {
    expect(cells([row({ quantity: -1.5, line_total: -12000, vat_amount: -3000 })])).toContain('-1,5 dagar')
  })
})
