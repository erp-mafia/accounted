import { describe, it, expect } from 'vitest'
import { creditConfirmNumber, isTextLikeLine } from '@/lib/invoices/display'

describe('creditConfirmNumber', () => {
  it('uses our own invoice number when present', () => {
    expect(
      creditConfirmNumber({ invoice_number: 'F-2026010', external_invoice_number: null }),
    ).toBe('F-2026010')
  })

  it('falls back to the external number for self-billed invoices (issue #1820)', () => {
    expect(
      creditConfirmNumber({ invoice_number: null, external_invoice_number: 'SB-2026-17' }),
    ).toBe('SB-2026-17')
  })

  it('returns null when the invoice carries no number at all', () => {
    expect(creditConfirmNumber({ invoice_number: null, external_invoice_number: null })).toBeNull()
    expect(creditConfirmNumber({})).toBeNull()
  })
})

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
