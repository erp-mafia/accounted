import { describe, expect, it } from 'vitest'
import { supplierInvoiceEditorAmounts } from '../editor-amounts'

const item = { description: 'Purchase', amount: 16045, account_number: '6110', vat_rate: 0.25 }

describe('supplierInvoiceEditorAmounts', () => {
  it('keeps VAT and derives the billed whole-krona amount', () => {
    expect(supplierInvoiceEditorAmounts([item], 'SEK', false, true)).toMatchObject({
      subtotal: 16045, totalVat: 4011.25, total: 20056.25,
      figures: { toPay: 20056 },
      roundingItem: { amount: -0.25, account_number: '3740', vat_rate: 0 },
    })
  })

  it.each([['SEK', false], ['EUR', true], ['USD', true]])('keeps exact amounts for %s, rounding %s', (currency, enabled) => {
    expect(supplierInvoiceEditorAmounts([item], currency, false, enabled)).toMatchObject({
      figures: { toPay: 20056.25 }, roundingItem: null,
    })
  })

  it('does not duplicate an existing explicit rounding item', () => {
    const first = supplierInvoiceEditorAmounts([item], 'SEK', false, true)
    const items = [item, { ...first.roundingItem!, description: 'Rounding' }]
    expect(supplierInvoiceEditorAmounts(items, 'SEK', false, true)).toMatchObject({
      totalVat: 4011.25, total: 20056, roundingItem: null,
    })
  })

  it('does not create a zero-amount rounding item', () => {
    expect(supplierInvoiceEditorAmounts([{ ...item, amount: 100 }], 'SEK', false, true).roundingItem).toBeNull()
  })

  it('keeps reverse-charge rounding out of the self-assessed VAT base', () => {
    const purchase = { ...item, amount: 100.4, vat_rate: 0, reverse_charge_rate: 0.12 }
    const first = supplierInvoiceEditorAmounts([purchase], 'SEK', true, true)
    expect(first).toMatchObject({ totalVat: 12.05, total: 100.4, roundingItem: { amount: -0.4 } })
    expect(supplierInvoiceEditorAmounts([purchase, first.roundingItem!], 'SEK', true, true)).toMatchObject({
      totalVat: 12.05, total: 100, roundingItem: null,
    })
  })

  it('matches the endpoint per-line VAT normalization at a half-öre', () => {
    expect(supplierInvoiceEditorAmounts([{ ...item, amount: 4.02 }], 'SEK', false, true)).toMatchObject({
      totalVat: 1,
      roundingItem: { amount: -0.02 },
    })
  })
})
