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

  it('matches the endpoint at a half-öre: 4,02 x 25 % = 1,005 books 1,01 (roundOre), not a float 1,00', () => {
    expect(supplierInvoiceEditorAmounts([{ ...item, amount: 4.02 }], 'SEK', false, true)).toMatchObject({
      totalVat: 1.01,
      roundingItem: { amount: -0.03 },
    })
  })

  // crm#1367: the editor shows the VAT the create endpoints book, per rate on
  // the summed base (SF-CE-202608: 3 864,11, not 3 864,12 line by line).
  it('computes VAT per rate on the summed base, as the endpoints book it', () => {
    const lines = [
      { ...item, amount: 17564.15 },
      { ...item, amount: -2107.7 },
    ]
    const amounts = supplierInvoiceEditorAmounts(lines, 'SEK', false, false)
    expect(amounts.totalVat).toBe(3864.11)
    expect(amounts.itemTotals.map((t) => t.vatAmount).reduce((a, b) => a + b, 0)).toBeCloseTo(3864.11, 2)
    expect(amounts.statedVatAccepted).toBe(false)
  })

  it('shows the invoice\'s own VAT when it fits the lines, and the summed base when it does not', () => {
    const lines = [
      { ...item, amount: 17564.15 },
      { ...item, amount: -2107.7 },
    ]
    const fits = supplierInvoiceEditorAmounts(lines, 'SEK', false, false, [{ rate: 0.25, vatAmount: 3864.12 }])
    expect(fits).toMatchObject({ totalVat: 3864.12, statedVatAccepted: true })
    const off = supplierInvoiceEditorAmounts(lines, 'SEK', false, false, [{ rate: 0.25, vatAmount: 3870 }])
    expect(off).toMatchObject({ totalVat: 3864.11, statedVatAccepted: false })
  })
})
