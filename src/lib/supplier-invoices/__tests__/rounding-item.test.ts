import { describe, expect, it } from 'vitest'
import { supplierInvoiceRoundingItem } from '../rounding-item'

// One rule for the zero-VAT 3740 adjustment the editor saves and the inbox
// tool stages (crm#110, feedback seq 753539).
describe('supplierInvoiceRoundingItem', () => {
  it('carries a positive gap as a debit on 3740 with no VAT', () => {
    // The invoice from feedback seq 753539: billed 444 192.00, lines incl. VAT 444 191.91.
    expect(supplierInvoiceRoundingItem(444192 - 444191.91, 'SEK')).toEqual({
      description: 'Öresavrundning',
      account_number: '3740',
      amount: 0.09,
      vat_rate: 0,
    })
  })

  it('carries a negative gap as a negative amount (a credit on 3740)', () => {
    expect(supplierInvoiceRoundingItem(-0.25, 'SEK')).toMatchObject({ account_number: '3740', amount: -0.25 })
  })

  it('stops at half a krona', () => {
    expect(supplierInvoiceRoundingItem(0.5, 'SEK')).toMatchObject({ amount: 0.5 })
    expect(supplierInvoiceRoundingItem(-0.5, 'SEK')).toMatchObject({ amount: -0.5 })
    expect(supplierInvoiceRoundingItem(0.51, 'SEK')).toBeNull()
    expect(supplierInvoiceRoundingItem(-0.51, 'SEK')).toBeNull()
  })

  it('has nothing to carry when the gap rounds to zero', () => {
    expect(supplierInvoiceRoundingItem(0, 'SEK')).toBeNull()
    expect(supplierInvoiceRoundingItem(0.004, 'SEK')).toBeNull()
  })

  it('never applies to a foreign-currency invoice', () => {
    expect(supplierInvoiceRoundingItem(0.09, 'EUR')).toBeNull()
    expect(supplierInvoiceRoundingItem(0.09, 'USD')).toBeNull()
  })
})
