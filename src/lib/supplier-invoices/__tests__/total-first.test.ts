import { describe, expect, it } from 'vitest'
import {
  invoiceTotalsCrosscheck,
  isInputVatAccountRow,
  isWholeKronaRoundingOf,
  rowNetFromInvoiceTotals,
  rowsAgainstInvoiceTotals,
  totalFirstFill,
  vatGuidanceApplies,
} from '../total-first'
import { supplierInvoiceEditorAmounts } from '../editor-amounts'
import { bookLimitedDeduction } from '../limited-deduction'
import { roundOre } from '@/lib/money'

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

describe('invoiceTotalsCrosscheck', () => {
  // crm#1954: leasing 3 995 + fee 50 at 25 %, 499,37 of the moms booked as cost.
  const rows = { invoiceTotal: 5056.25, toPay: 5056.25, totalVat: 1011.25, deductibleVat: 511.88 }

  it('matches the moms the invoice charges and the moms the rows deduct', () => {
    expect(invoiceTotalsCrosscheck({ ...rows, invoiceVat: 1011.25 })).toMatchObject({ totalMatches: true, vatMatches: true })
    expect(invoiceTotalsCrosscheck({ ...rows, invoiceVat: 511.88 })).toMatchObject({ totalMatches: true, vatMatches: true })
  })

  it('still flags any other moms, against what the invoice charges', () => {
    expect(invoiceTotalsCrosscheck({ ...rows, invoiceVat: 500 })).toMatchObject({ vatDiff: -511.25, vatMatches: false })
    const { deductibleVat: _omit, ...withoutDeduction } = rows
    expect(invoiceTotalsCrosscheck({ ...withoutDeduction, invoiceVat: 511.88 })).toMatchObject({ vatDiff: -499.37, vatMatches: false })
  })

  it('has no moms difference when the invoice states no moms', () => {
    expect(invoiceTotalsCrosscheck({ ...rows, invoiceVat: null })).toMatchObject({ vatDiff: null, vatMatches: true })
  })

  it('says the rows carry no moms when the invoice states moms and rows with amounts carry none', () => {
    const handTyped = { invoiceTotal: 4900, toPay: 4900, totalVat: 0, deductibleVat: 0 }
    expect(invoiceTotalsCrosscheck({ ...handTyped, invoiceVat: 1000 })).toMatchObject({
      totalMatches: true,
      vatDiff: 1000,
      vatMatches: false,
      rowsCarryNoVat: true,
    })
  })

  it('leaves every other moms difference to the general line', () => {
    // Rows that carry moms, however far off, and the matching cases.
    expect(invoiceTotalsCrosscheck({ ...rows, invoiceVat: 500 }).rowsCarryNoVat).toBe(false)
    expect(invoiceTotalsCrosscheck({ ...rows, invoiceVat: 1011.25 }).rowsCarryNoVat).toBe(false)
    // No moms on the invoice: nothing is missing from the rows.
    const zeroRows = { invoiceTotal: 4900, toPay: 4900, totalVat: 0, deductibleVat: 0 }
    expect(invoiceTotalsCrosscheck({ ...zeroRows, invoiceVat: null }).rowsCarryNoVat).toBe(false)
    expect(invoiceTotalsCrosscheck({ ...zeroRows, invoiceVat: 0 }).rowsCarryNoVat).toBe(false)
    expect(invoiceTotalsCrosscheck({ ...zeroRows, invoiceVat: -1000 }).rowsCarryNoVat).toBe(false)
    // Rows without amounts are still being filled in.
    expect(invoiceTotalsCrosscheck({ invoiceTotal: 5000, invoiceVat: 1000, toPay: 0, totalVat: 0 }).rowsCarryNoVat).toBe(false)
  })
})

describe('isInputVatAccountRow', () => {
  it('is a row on the account a moms sats books ingående moms on, without a moms sats', () => {
    expect(isInputVatAccountRow({ account_number: '2641', vat_rate: 0 })).toBe(true)
    expect(isInputVatAccountRow({ account_number: '2641' })).toBe(true)
  })

  it('leaves the other ruta 48 accounts: a moms sats on the cost row would not book what they carry', () => {
    // Reverse charge (beräknad ingående moms), frivillig skattskyldighet,
    // uthyrning, blandad verksamhet, and the group account.
    for (const account of ['2645', '2647', '2642', '2646', '2649', '2640']) {
      expect(isInputVatAccountRow({ account_number: account, vat_rate: 0 })).toBe(false)
    }
  })

  it('is no other row', () => {
    expect(isInputVatAccountRow({ account_number: '2641', vat_rate: 0.25 })).toBe(false)
    expect(isInputVatAccountRow({ account_number: '5615', vat_rate: 0 })).toBe(false)
    expect(isInputVatAccountRow({ account_number: '2611', vat_rate: 0 })).toBe(false)
    expect(isInputVatAccountRow({ account_number: '2650', vat_rate: 0 })).toBe(false)
    expect(isInputVatAccountRow({ account_number: '2648', vat_rate: 0 })).toBe(false)
    expect(isInputVatAccountRow({ account_number: '', vat_rate: 0 })).toBe(false)
  })
})

describe('vatGuidanceApplies', () => {
  const swedish = { vatRegistered: true, reverseCharge: false, selfBilled: false, supplierType: 'swedish_business' }

  it('applies to Swedish moms the company deducts from the rows', () => {
    expect(vatGuidanceApplies(swedish)).toBe(true)
    // Before a supplier is chosen.
    expect(vatGuidanceApplies({ ...swedish, supplierType: undefined })).toBe(true)
  })

  it('stays out where the invoice has no Swedish moms to deduct from its rows', () => {
    expect(vatGuidanceApplies({ ...swedish, vatRegistered: false })).toBe(false)
    expect(vatGuidanceApplies({ ...swedish, reverseCharge: true })).toBe(false)
    // A foreign supplier's moms is never Swedish ingående moms.
    expect(vatGuidanceApplies({ ...swedish, supplierType: 'eu_business' })).toBe(false)
    expect(vatGuidanceApplies({ ...swedish, supplierType: 'non_eu_business' })).toBe(false)
    // A self-billing invoice has no Begränsat momsavdrag.
    expect(vatGuidanceApplies({ ...swedish, selfBilled: true })).toBe(false)
  })
})

describe('a personbil lease invoice with a fee taken off after the moms', () => {
  // Made-up invoice: 4 000,00 + 1 000,00 moms = 5 000,00, a fee of 100,00
  // taken off after the moms, 4 900,00 to pay. Half the moms is deductible
  // (ML 2023:200 13 kap. 22 §).
  const invoiceTotal = 4900
  const invoiceVat = 1000
  type EditorRow = { account_number: string; amount: number; vat_rate: number; vat_deduction_share?: number }

  /** The cross-check as the editor composes it: rows as booked, moms as the invoice shows it. */
  function editorCrosscheck(items: EditorRow[]) {
    const { items: booked, nonDeductibleVat } = bookLimitedDeduction(items, true)
    const { amounts } = rowsAgainstInvoiceTotals({
      items: booked,
      currency: 'SEK',
      reverseCharge: false,
      invoiceTotal,
      invoiceVat,
    })
    const totalVat = roundOre(amounts.totalVat + nonDeductibleVat.reduce((sum, vat) => sum + vat, 0))
    return invoiceTotalsCrosscheck({
      invoiceTotal,
      invoiceVat,
      toPay: amounts.figures.toPay,
      totalVat,
      deductibleVat: amounts.totalVat,
    })
  }

  it('booked with the moms typed by hand on rows at 0 %: the rows carry no moms, and the moms row is flagged', () => {
    const handTyped: EditorRow[] = [
      { account_number: '5615', amount: 4400, vat_rate: 0 },
      { account_number: '2641', amount: 500, vat_rate: 0 },
    ]
    expect(editorCrosscheck(handTyped)).toMatchObject({ totalMatches: true, vatDiff: 1000, rowsCarryNoVat: true })
    expect(handTyped.map(isInputVatAccountRow)).toEqual([false, true])
  })

  it('booked with the moms sats on the cost row and half the moms deducted: everything matches', () => {
    const supported: EditorRow[] = [
      { account_number: '5615', amount: 4000, vat_rate: 0.25, vat_deduction_share: 0.5 },
      { account_number: '5615', amount: -100, vat_rate: 0 },
    ]
    expect(editorCrosscheck(supported)).toMatchObject({ totalMatches: true, vatMatches: true, rowsCarryNoVat: false })
    expect(supported.some(isInputVatAccountRow)).toBe(false)
  })

  it('booked with none of the moms deducted through Begränsat momsavdrag: everything matches', () => {
    // The car used only in ringa omfattning in the business (13 kap. 21 §).
    const nothingDeducted: EditorRow[] = [
      { account_number: '5615', amount: 4000, vat_rate: 0.25, vat_deduction_share: 0 },
      { account_number: '5615', amount: -100, vat_rate: 0 },
    ]
    expect(editorCrosscheck(nothingDeducted)).toMatchObject({ totalMatches: true, vatMatches: true, rowsCarryNoVat: false })
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
