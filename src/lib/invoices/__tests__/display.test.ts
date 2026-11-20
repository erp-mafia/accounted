import { describe, it, expect } from 'vitest'
import { invoiceDisplayNumber, isTextLikeLine } from '@/lib/invoices/display'

describe('isTextLikeLine', () => {
  it('is true for explicit text rows regardless of amounts', () => {
    expect(isTextLikeLine({ line_type: 'text', quantity: 0, unit_price: 0 })).toBe(true)
    expect(isTextLikeLine({ line_type: 'text', quantity: 2, unit_price: 100 })).toBe(true)
  })

  it('is true for product rows with no amounts (issue #1053 free-text line)', () => {
    expect(isTextLikeLine({ line_type: 'product', quantity: 0, unit_price: 0 })).toBe(true)
    expect(isTextLikeLine({ quantity: 0, unit_price: 0 })).toBe(true)
    expect(isTextLikeLine({ quantity: null, unit_price: null })).toBe(true)
    expect(isTextLikeLine({})).toBe(true)
  })

  it('is false as soon as the row carries a quantity or a price', () => {
    expect(isTextLikeLine({ line_type: 'product', quantity: 1, unit_price: 0 })).toBe(false)
    expect(isTextLikeLine({ line_type: 'product', quantity: 0, unit_price: 250 })).toBe(false)
    expect(isTextLikeLine({ line_type: 'product', quantity: 0, unit_price: -250 })).toBe(false)
    expect(isTextLikeLine({ quantity: 3, unit_price: 99.5 })).toBe(false)
  })
})

describe('invoiceDisplayNumber', () => {
  it('shows a received self-billing invoice by the customer number, not as a draft (crm#1375)', () => {
    expect(invoiceDisplayNumber({ invoice_number: null, external_invoice_number: 'S2263' })).toBe('S2263')
  })

  it('shows our own number when there is one', () => {
    expect(invoiceDisplayNumber({ invoice_number: 'F-1042', external_invoice_number: null })).toBe('F-1042')
  })

  it('shows the draft label when there is no number at all', () => {
    expect(invoiceDisplayNumber({ invoice_number: null, external_invoice_number: null })).toBe('(Utkast)')
    expect(invoiceDisplayNumber({ invoice_number: null })).toBe('(Utkast)')
  })
})
