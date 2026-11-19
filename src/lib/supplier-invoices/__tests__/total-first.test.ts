import { describe, expect, it } from 'vitest'
import { isWholeKronaRoundingOf, rowNetFromInvoiceTotals, totalFirstFill } from '../total-first'
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

describe('totalFirstFill', () => {
  const typed = { fromReading: false, reverseCharge: false }

  it('fills an empty single row with the net the totals give', () => {
    expect(totalFirstFill({ amount: 0, net: 908.8, filled: null, ...typed })).toBe(908.8)
  })

  it('follows while the row still holds what it put there, and rests when it already holds the net', () => {
    expect(totalFirstFill({ amount: 908.8, net: 1000, filled: 908.8, ...typed })).toBe(1000)
    expect(totalFirstFill({ amount: 908.8, net: 908.8, filled: 908.8, ...typed })).toBeNull()
  })

  it('never overwrites an amount the person typed, and does nothing without a Fakturabelopp', () => {
    expect(totalFirstFill({ amount: 750, net: 908.8, filled: 908.8, ...typed })).toBeNull()
    expect(totalFirstFill({ amount: 0, net: null, filled: null, ...typed })).toBeNull()
  })

  it('moves a row typed by hand to the whole Fakturabelopp when reverse charge is switched on, as before', () => {
    // Fakturabelopp 1 149,00 typed, a row born at 25 %: 919,20, then reverse charge.
    const net = rowNetFromInvoiceTotals({ total: 1149, vat: null, rate: 0.25, reverseCharge: true })
    expect(totalFirstFill({ amount: 919.2, net, filled: 919.2, fromReading: false, reverseCharge: true })).toBe(1149)
  })

  // Review round 1, finding 2: the supplier is picked after the reading. The
  // reading (919,20 + 229,80 = 1 149,00) made the row and handed it to the
  // fill; the foreign supplier then switches reverse charge on.
  it('leaves a row a reading made when reverse charge is switched on after it: the seller\'s moms stays a difference', () => {
    const net = rowNetFromInvoiceTotals({ total: 1149, vat: null, rate: 0.25, reverseCharge: true })
    expect(net).toBe(1149)
    expect(totalFirstFill({ amount: 919.2, net, filled: 919.2, fromReading: true, reverseCharge: true })).toBeNull()
    // Without reverse charge the reading's row follows the totals like any other.
    expect(totalFirstFill({ amount: 919.2, net: 1000, filled: 919.2, fromReading: true, reverseCharge: false })).toBe(1000)
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

describe('an inbox arrival whose Fakturabelopp is the extracted total (crm#1595)', () => {
  // The rows and the billed total of four supplier invoices that were
  // registered at the rows' total instead of what they bill, because the
  // inbox path left Fakturabelopp empty and öresavrundning stayed off.
  const cases = [
    { name: 'one 6 % row', rows: [row(4990, 0.06)], billed: 5289, exact: 5289.4, rounding: -0.4 },
    { name: 'two 25 % rows', rows: [row(1686.37, 0.25), row(2248.88, 0.25)], billed: 4919, exact: 4919.06, rounding: -0.06 },
    { name: 'one row rounded up', rows: [row(421.5, 0.25)], billed: 527, exact: 526.88, rounding: 0.12 },
    {
      name: 'ten 25 % rows',
      rows: [345.96, 81.84, 90.77, 331.08, 65.47, 82.58, 475.42, 341.5, 267.1, 241.8].map((amount) => row(amount, 0.25)),
      billed: 2904,
      exact: 2904.4,
      rounding: -0.4,
    },
  ]

  it.each(cases)('$name: öresavrundning turns on and the payable is what the invoice bills', ({ rows, billed, exact, rounding }) => {
    const exactAmounts = supplierInvoiceEditorAmounts(rows, 'SEK', false, false)
    expect(exactAmounts.total).toBe(exact)
    expect(isWholeKronaRoundingOf(exactAmounts.total, billed, 'SEK')).toBe(true)
    const rounded = supplierInvoiceEditorAmounts(rows, 'SEK', false, true)
    expect(rounded.figures.toPay).toBe(billed)
    expect(rounded.roundingItem).toMatchObject({ account_number: '3740', amount: rounding, vat_rate: 0 })
  })

  it('stays off without a Fakturabelopp: the registration then books the rows', () => {
    expect(isWholeKronaRoundingOf(5289.4, null, 'SEK')).toBe(false)
  })
})
