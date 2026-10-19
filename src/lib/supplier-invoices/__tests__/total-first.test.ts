import { describe, expect, it } from 'vitest'
import { isWholeKronaRoundingOf, rowNetFromInvoiceTotals } from '../total-first'
import { supplierInvoiceEditorAmounts } from '../editor-amounts'

const row = (amount: number, vat_rate: number) => ({ amount, account_number: '4010', vat_rate })

describe('rowNetFromInvoiceTotals', () => {
  it('takes the net from the invoice moms, leaving the rounding outside it', () => {
    // 15,00 + 3,75 moms, billed as 19,00.
    expect(rowNetFromInvoiceTotals({ total: 19, vat: 3.75, rate: 0.25, reverseCharge: false })).toBe(15)
  })

  it('splits the total by the sats when no moms is given', () => {
    expect(rowNetFromInvoiceTotals({ total: 125, vat: null, rate: 0.25, reverseCharge: false })).toBe(100)
    expect(rowNetFromInvoiceTotals({ total: 112, vat: null, rate: 0.12, reverseCharge: false })).toBe(100)
    expect(rowNetFromInvoiceTotals({ total: 19, vat: null, rate: 0.25, reverseCharge: false })).toBe(15.2)
  })

  it('books the whole invoice as the net under reverse charge, at 0 % and with zero moms', () => {
    expect(rowNetFromInvoiceTotals({ total: 1000, vat: null, rate: 0.25, reverseCharge: true })).toBe(1000)
    expect(rowNetFromInvoiceTotals({ total: 1000, vat: 250, rate: 0.25, reverseCharge: true })).toBe(1000)
    expect(rowNetFromInvoiceTotals({ total: 1000, vat: null, rate: 0, reverseCharge: false })).toBe(1000)
    expect(rowNetFromInvoiceTotals({ total: 1000, vat: 0, rate: 0.25, reverseCharge: false })).toBe(1000)
  })

  it('keeps the sign of a credit keyed in as an invoice', () => {
    expect(rowNetFromInvoiceTotals({ total: -19, vat: -3.75, rate: 0.25, reverseCharge: false })).toBe(-15)
  })

  it.each([0.25, 0.12, 0.06])('reproduces every invoice moms to the öre at %s', (rate) => {
    // Every moms from 0,01 to 2 000,00 kr: the net it yields, run through
    // the editor's own per-row moms, gives that moms back exactly.
    for (let ore = 1; ore <= 200_000; ore++) {
      const vat = ore / 100
      const net = rowNetFromInvoiceTotals({ total: 0, vat, rate, reverseCharge: false })
      const { totalVat } = supplierInvoiceEditorAmounts([row(net, rate)], 'SEK', false, false)
      if (totalVat !== vat) throw new Error(`moms ${vat} at ${rate} came back as ${totalVat} (net ${net})`)
    }
  })
})

describe('isWholeKronaRoundingOf', () => {
  it('recognises a total rounded up or down to whole kronor', () => {
    expect(isWholeKronaRoundingOf(18.75, 19, 'SEK')).toBe(true)
    expect(isWholeKronaRoundingOf(20056.25, 20056, 'SEK')).toBe(true)
    expect(isWholeKronaRoundingOf(-18.75, -19, 'SEK')).toBe(true)
  })

  it('rounds half a krona away from zero, like the booked rounding', () => {
    expect(isWholeKronaRoundingOf(18562.5, 18563, 'SEK')).toBe(true)
    expect(isWholeKronaRoundingOf(18562.5, 18562, 'SEK')).toBe(false)
  })

  it('is not rounding when the rows already make a whole total', () => {
    expect(isWholeKronaRoundingOf(19, 19, 'SEK')).toBe(false)
  })

  it('is not rounding when the difference is anything else', () => {
    expect(isWholeKronaRoundingOf(18.75, 20, 'SEK')).toBe(false)
    expect(isWholeKronaRoundingOf(18.75, 18.8, 'SEK')).toBe(false)
    expect(isWholeKronaRoundingOf(18.75, null, 'SEK')).toBe(false)
  })

  it('only applies to SEK', () => {
    expect(isWholeKronaRoundingOf(18.75, 19, 'EUR')).toBe(false)
  })

  it('makes the payable equal the invoice total once switched on', () => {
    const rows = [row(15, 0.25)]
    const exact = supplierInvoiceEditorAmounts(rows, 'SEK', false, false)
    expect(isWholeKronaRoundingOf(exact.total, 19, 'SEK')).toBe(true)
    const rounded = supplierInvoiceEditorAmounts(rows, 'SEK', false, true)
    expect(rounded.figures.toPay).toBe(19)
    expect(rounded.roundingItem).toMatchObject({ amount: 0.25, account_number: '3740', vat_rate: 0 })
  })
})
