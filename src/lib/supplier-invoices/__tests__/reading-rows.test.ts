import { describe, expect, it } from 'vitest'
import type { InvoiceExtractionResult } from '@/types'
import { roundOre } from '@/lib/money'
import { netVat, splitGrossVat } from '@/lib/bookkeeping/gross-split'
import type { SupplierInvoiceLineItem } from '../form-payload'
import {
  accountCarriedFrom,
  reverseChargeRateCarriedFrom,
  rowsFromReading,
  rowsStandAsPut,
  type ReadingRow,
} from '../reading-rows'
import { invoiceTotalsCrosscheck, rowsAgainstInvoiceTotals } from '../total-first'

type Reading = Parameters<typeof rowsFromReading>[0]

const line = (lineTotal: number, vatRate: number | null, description = 'Rad') =>
  ({ description, quantity: 1, unitPrice: lineTotal, lineTotal, vatRate, accountSuggestion: null })

const reading = (
  totals: { total?: number | null; vatAmount?: number | null; subtotal?: number | null },
  lineItems: ReturnType<typeof line>[],
  currency = 'SEK',
  vatBreakdown: InvoiceExtractionResult['vatBreakdown'] = [],
): Reading => ({
  invoice: { currency } as InvoiceExtractionResult['invoice'],
  totals: { subtotal: null, vatAmount: null, total: null, ...totals },
  lineItems,
  vatBreakdown,
})

const REGISTERED = { vatRegistered: true, reverseCharge: false }

/** What the editor shows beside Fakturabelopp and Moms for these rows. */
function crosscheckOf(rows: ReadingRow[], total: number | null, vat: number | null, currency = 'SEK', reverseCharge = false) {
  const { amounts, oreRounding } = rowsAgainstInvoiceTotals({
    items: rows.map((row) => ({ ...row, account_number: '5010' })),
    currency,
    reverseCharge,
    invoiceTotal: total,
    invoiceVat: vat,
  })
  return {
    ...invoiceTotalsCrosscheck({ invoiceTotal: total, invoiceVat: vat, toPay: amounts.figures.toPay, totalVat: amounts.totalVat }),
    oreRounding,
    toPay: amounts.figures.toPay,
    totalVat: amounts.totalVat,
  }
}

describe('rowsFromReading', () => {
  describe('the reported reading: lines that stop short of the invoice total', () => {
    // A telecom invoice billing 1 136,00 with 227,20 moms. The read lines
    // are 769,00 net, 961,25 with their moms: 174,75 kr short.
    const reported = reading({ total: 1136, vatAmount: 227.2 }, [
      line(299, 25, 'Abonnemang'),
      line(250, 25, 'Surf'),
      line(220, 25, 'Samtal'),
    ])

    it('is the shape of the report: the read lines are 174,75 kr below the total', () => {
      const perLine = reported!.lineItems.map((li) => ({ description: li.description, amount: li.lineTotal, vat_rate: 0.25 }))
      expect(crosscheckOf(perLine, 1136, null).totalDiff).toBe(174.75)
    })

    it('opens with Fakturabelopp 1 136,00, Moms 227,20 and one row of 908,80 at 25 %', () => {
      const proposed = rowsFromReading(reported, REGISTERED)
      expect(proposed.invoiceTotal).toBe(1136)
      expect(proposed.invoiceVat).toBe(227.2)
      // The row carries the text of the largest read line.
      expect(proposed.rows).toEqual([{ description: 'Abonnemang', amount: 908.8, vat_rate: 0.25 }])
    })

    it('leaves the cross-check with nothing to say', () => {
      const proposed = rowsFromReading(reported, REGISTERED)
      const check = crosscheckOf(proposed.rows, proposed.invoiceTotal, proposed.invoiceVat)
      expect(check).toMatchObject({ totalDiff: 0, totalMatches: true, vatDiff: 0, oreRounding: false })
    })

    it('hands the row to the total-first fill and offers no split into lines that do not add up', () => {
      const proposed = rowsFromReading(reported, REGISTERED)
      expect(proposed.filledNet).toBe(908.8)
      expect(proposed.invoiceRows).toBeNull()
    })
  })

  describe('one moms sats', () => {
    it('sums lines that add up to the totals into one row and keeps them as a split', () => {
      const proposed = rowsFromReading(
        reading({ total: 1250, vatAmount: 250 }, [line(600, 25, 'Konsulttimmar'), line(400, 25, 'Resor')]),
        REGISTERED,
      )
      expect(proposed.rows).toEqual([{ description: 'Konsulttimmar', amount: 1000, vat_rate: 0.25 }])
      expect(proposed.filledNet).toBe(1000)
      expect(proposed.invoiceRows).toEqual([
        { description: 'Konsulttimmar', amount: 600, vat_rate: 0.25 },
        { description: 'Resor', amount: 400, vat_rate: 0.25 },
      ])
    })

    it('keeps the text of a single read line and has nothing to split', () => {
      const proposed = rowsFromReading(reading({ total: 1250, vatAmount: 250 }, [line(1000, 25, 'Årslicens')]), REGISTERED)
      expect(proposed.rows).toEqual([{ description: 'Årslicens', amount: 1000, vat_rate: 0.25 }])
      expect(proposed.invoiceRows).toBeNull()
    })

    it('reads an öresavrundning as one: the row is the net, the rounding goes to 3740 (crm#1595)', () => {
      // 4 990 + 299,40 moms, billed 5 289.
      const proposed = rowsFromReading(reading({ total: 5289, vatAmount: 299.4 }, [line(4990, 6, 'E-bok')]), REGISTERED)
      expect(proposed.rows).toEqual([{ description: 'E-bok', amount: 4990, vat_rate: 0.06 }])
      const check = crosscheckOf(proposed.rows, 5289, 299.4)
      expect(check).toMatchObject({ totalMatches: true, vatMatches: true, oreRounding: true, toPay: 5289 })
    })

    it('takes moms / sats when lines are missing and the total is rounded', () => {
      const proposed = rowsFromReading(reading({ total: 5289, vatAmount: 299.4 }, [line(2000, 6), line(1000, 6)]), REGISTERED)
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 4990, vat_rate: 0.06 }])
      expect(crosscheckOf(proposed.rows, 5289, 299.4)).toMatchObject({ totalMatches: true, vatMatches: true, oreRounding: true })
    })

    it('takes Fakturabelopp minus Moms when lines are missing and moms / sats is an öre off', () => {
      // 908,81 net: 227,2025 moms prints as 227,20, and 227,20 / 0,25 is 908,80.
      const proposed = rowsFromReading(reading({ total: 1136.01, vatAmount: 227.2 }, [line(299, 25), line(250, 25)]), REGISTERED)
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 908.81, vat_rate: 0.25 }])
      expect(crosscheckOf(proposed.rows, 1136.01, 227.2)).toMatchObject({ totalDiff: 0, vatDiff: 0, oreRounding: false })
      // Not the fill's 908,80: the editor leaves this row as it is.
      expect(proposed.filledNet).toBeNull()
    })

    it('takes the invoice net when lines are missing and moms / sats rounds to another krona', () => {
      // 4 990,12 + 299,41 moms is 5 289,53, billed 5 290. Moms / sats is
      // 4 990,17: 5 289,58, still 5 290. But 4 990,10 + 299,41 = 5 289,51 has
      // moms / sats 4 990,17 too, and the net printed on the invoice decides.
      const proposed = rowsFromReading(
        reading({ total: 5290, vatAmount: 299.41, subtotal: 4990.1 }, [line(2000, 6), line(1000, 6)]),
        REGISTERED,
      )
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 4990.1, vat_rate: 0.06 }])
      expect(crosscheckOf(proposed.rows, 5290, 299.41)).toMatchObject({ totalMatches: true, vatMatches: true, oreRounding: true })
    })

    it('does not trust a subtotal that is only the sum of the lines it read', () => {
      const proposed = rowsFromReading(
        reading({ total: 1136, vatAmount: 227.2, subtotal: 769 }, [line(299, 25), line(250, 25), line(220, 25)]),
        REGISTERED,
      )
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 908.8, vat_rate: 0.25 }])
    })

    it('keeps the lines themselves when only they can carry a moms the seller rounded per line', () => {
      // Eight lines of 0,58 kr: 0,15 moms each (1,20) against 1,16 on the sum.
      const lines = Array.from({ length: 8 }, (_, i) => line(0.58, 25, `Rad ${i + 1}`))
      const proposed = rowsFromReading(reading({ total: 5.84, vatAmount: 1.2 }, lines), REGISTERED)
      expect(proposed.rows).toHaveLength(8)
      expect(crosscheckOf(proposed.rows, 5.84, 1.2)).toMatchObject({ totalDiff: 0, vatDiff: 0 })
      expect(proposed.invoiceRows).toBeNull()
    })

    it('takes the net from the totals when the read lines carry no amounts', () => {
      const proposed = rowsFromReading(reading({ total: 1136, vatAmount: 227.2 }, [line(0, 25), line(0, 25)]), REGISTERED)
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 908.8, vat_rate: 0.25 }])
      expect(proposed.invoiceRows).toBeNull()
    })

    it('falls back to the totals row and lets the cross-check speak when nothing adds up', () => {
      // Moms 200 at 25 % is a net of 800: 1 000 with moms, 136 short of the total.
      const proposed = rowsFromReading(reading({ total: 1136, vatAmount: 200 }, [line(300, 25), line(250, 25)]), REGISTERED)
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 800, vat_rate: 0.25 }])
      expect(crosscheckOf(proposed.rows, 1136, 200)).toMatchObject({ totalDiff: 136, totalMatches: false, vatDiff: 0 })
      expect(proposed.invoiceRows).toBeNull()
    })

    it('keeps the summed lines when they give the total and only the read moms is off', () => {
      const proposed = rowsFromReading(reading({ total: 1000, vatAmount: 20 }, [line(500, 25), line(300, 25)]), REGISTERED)
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 800, vat_rate: 0.25 }])
      expect(crosscheckOf(proposed.rows, 1000, 20)).toMatchObject({ totalMatches: true, vatDiff: -180, vatMatches: false })
    })
  })

  describe('several moms satser', () => {
    const food = [line(600, 25, 'Lokalhyra'), line(400, 25, 'Teknik'), line(500, 12, 'Lunch')]

    it('groups lines that add up to the totals into one row per sats', () => {
      // 1 000 at 25 % and 500 at 12 %: 250 + 60 moms, 1 810 in all.
      const proposed = rowsFromReading(reading({ total: 1810, vatAmount: 310 }, food), REGISTERED)
      expect(proposed.rows).toEqual([
        { description: 'Lokalhyra', amount: 1000, vat_rate: 0.25 },
        { description: 'Lunch', amount: 500, vat_rate: 0.12 },
      ])
      expect(crosscheckOf(proposed.rows, 1810, 310)).toMatchObject({ totalDiff: 0, vatDiff: 0 })
      expect(proposed.filledNet).toBeNull()
      expect(proposed.invoiceRows).toHaveLength(3)
    })

    it('keeps a row per sats when a line was lost: with several satser the totals carry no split', () => {
      // The reading missed a 25 % line of 200: the totals say 1 200 + 500, moms 300 + 60.
      const proposed = rowsFromReading(reading({ total: 2060, vatAmount: 360 }, food), REGISTERED)
      expect(proposed.rows).toEqual([
        { description: 'Lokalhyra', amount: 1000, vat_rate: 0.25 },
        { description: 'Lunch', amount: 500, vat_rate: 0.12 },
      ])
      // The difference a row per line showed, and now the moms that is missing too.
      expect(crosscheckOf(proposed.rows, 2060, 360)).toMatchObject({ totalDiff: 250, totalMatches: false, vatDiff: 50 })
      expect(proposed.filledNet).toBeNull()
      expect(proposed.invoiceRows).toHaveLength(3)
    })

    it('takes each sats from the moms specification of the invoice when the lines do not add up', () => {
      const proposed = rowsFromReading(
        reading({ total: 2060, vatAmount: 360 }, food, 'SEK', [
          { rate: 25, base: 1200, amount: 300 },
          { rate: 12, base: 500, amount: 60 },
        ]),
        REGISTERED,
      )
      expect(proposed.rows).toEqual([
        { description: 'Lokalhyra', amount: 1200, vat_rate: 0.25 },
        { description: 'Lunch', amount: 500, vat_rate: 0.12 },
      ])
      expect(crosscheckOf(proposed.rows, 2060, 360)).toMatchObject({ totalDiff: 0, vatDiff: 0 })
      expect(proposed.invoiceRows).toBeNull()
    })

    it('takes the sats from the specification when the lines were read without one', () => {
      // A 12 % invoice whose lines carry no sats (25 % by default): 1 000 + 120.
      const proposed = rowsFromReading(
        reading({ total: 1120, vatAmount: 120 }, [line(600, null), line(400, null)], 'SEK', [{ rate: 12, base: 1000, amount: 120 }]),
        REGISTERED,
      )
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 1000, vat_rate: 0.12 }])
      expect(crosscheckOf(proposed.rows, 1120, 120)).toMatchObject({ totalDiff: 0, vatDiff: 0 })
    })

    it('does not trust a specification that is only the lines it read, or that does not add up', () => {
      const proposed = rowsFromReading(
        reading({ total: 2060, vatAmount: 360 }, food, 'SEK', [
          { rate: 25, base: 1000, amount: 250 },
          { rate: 12, base: 500, amount: 60 },
        ]),
        REGISTERED,
      )
      expect(proposed.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[1000, 0.25], [500, 0.12]])
    })

    it('puts a moms at a sats that is not Swedish on no row: the cross-check shows it', () => {
      // A foreign seller's 19 %: what it is for the books is a person's call.
      const proposed = rowsFromReading(
        reading({ total: 1190, vatAmount: 190 }, [line(600, 19, 'Hosting'), line(400, 19, 'Support')], 'EUR', [
          { rate: 19, base: 1000, amount: 190 },
        ]),
        REGISTERED,
      )
      expect(proposed.rows).toEqual([{ description: 'Hosting', amount: 1000, vat_rate: 0 }])
      expect(crosscheckOf(proposed.rows, 1190, 190, 'EUR')).toMatchObject({ totalDiff: 190, vatDiff: 190 })
    })

    it('still takes the whole total as a 0 % net when the invoice states moms 0 and a line was lost', () => {
      const proposed = rowsFromReading(reading({ total: 1000, vatAmount: 0 }, [line(600, 0), line(100, 0)]), REGISTERED)
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 1000, vat_rate: 0 }])
      expect(crosscheckOf(proposed.rows, 1000, 0)).toMatchObject({ totalDiff: 0, vatDiff: 0 })
    })

    it('books a 0 % part beside the moms-bearing row', () => {
      const proposed = rowsFromReading(
        reading({ total: 1310, vatAmount: 250 }, [line(1000, 25, 'Tjänst'), line(60, 0, 'Påminnelseavgift')]),
        REGISTERED,
      )
      expect(proposed.rows).toEqual([
        { description: 'Tjänst', amount: 1000, vat_rate: 0.25 },
        { description: 'Påminnelseavgift', amount: 60, vat_rate: 0 },
      ])
      expect(crosscheckOf(proposed.rows, 1310, 250)).toMatchObject({ totalDiff: 0, vatDiff: 0 })
    })

    it('takes the moms-bearing net from the totals when its lines fall short beside a 0 % part', () => {
      const proposed = rowsFromReading(
        reading({ total: 1310, vatAmount: 250 }, [line(400, 25), line(300, 25), line(60, 0, 'Påminnelseavgift')]),
        REGISTERED,
      )
      expect(proposed.rows).toEqual([
        { description: 'Rad', amount: 1000, vat_rate: 0.25 },
        { description: 'Påminnelseavgift', amount: 60, vat_rate: 0 },
      ])
      expect(crosscheckOf(proposed.rows, 1310, 250)).toMatchObject({ totalDiff: 0, vatDiff: 0 })
      expect(proposed.invoiceRows).toBeNull()
    })
  })

  describe('a reading with lines and no total', () => {
    it('keeps a row per read line, as read, and fills no Fakturabelopp', () => {
      const proposed = rowsFromReading(
        reading({}, [line(299, 25, 'Abonnemang'), line(250, 12, 'Frukost'), line(80, null, 'Avgift')]),
        REGISTERED,
      )
      expect(proposed).toEqual({
        invoiceTotal: null,
        invoiceVat: null,
        rows: [
          { description: 'Abonnemang', amount: 299, vat_rate: 0.25 },
          { description: 'Frukost', amount: 250, vat_rate: 0.12 },
          // No sats read: 25 %, as before.
          { description: 'Avgift', amount: 80, vat_rate: 0.25 },
        ],
        filledNet: null,
        invoiceRows: null,
      })
    })

    it('treats a total of zero the same way', () => {
      const proposed = rowsFromReading(reading({ total: 0, vatAmount: 0 }, [line(299, 25), line(250, 25)]), {
        vatRegistered: false,
        reverseCharge: false,
      })
      // Not momsregistrerad: each line's gross at 0 %.
      expect(proposed.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[373.75, 0], [312.5, 0]])
      expect(proposed.invoiceRows).toBeNull()
    })

    it('gives a company that is not momsregistrerad each line with its moms as cost: the gross at 0 %', () => {
      const lines = [line(299, 25), line(250, 12), line(80, 0)]
      const proposed = rowsFromReading(reading({}, lines), { vatRegistered: false, reverseCharge: false })
      expect(proposed.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[373.75, 0], [280, 0], [80, 0]])
      // What the editor's own zeroing made of a row per line before: amount + moms on it, to the öre.
      expect(proposed.rows.map((row) => row.amount)).toEqual(
        lines.map((li) => roundOre(li.lineTotal + netVat(li.lineTotal, (li.vatRate ?? 0) / 100))),
      )
    })
  })

  describe('a total without a moms', () => {
    it('sums the lines per sats and leaves Moms empty', () => {
      const proposed = rowsFromReading(reading({ total: 1250 }, [line(600, 25), line(400, 25)]), REGISTERED)
      expect(proposed.invoiceTotal).toBe(1250)
      expect(proposed.invoiceVat).toBeNull()
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 1000, vat_rate: 0.25 }])
      expect(crosscheckOf(proposed.rows, 1250, null)).toMatchObject({ totalDiff: 0, vatDiff: null })
      expect(proposed.invoiceRows).toHaveLength(2)
    })

    it('never splits the total by a sats the invoice did not state: the difference stays visible', () => {
      // A document with no moms whose lines carry no sats: the rows keep the
      // sums the lines had, and the cross-check says they are 250 too many.
      const proposed = rowsFromReading(reading({ total: 1000 }, [line(600, null), line(400, null)]), REGISTERED)
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 1000, vat_rate: 0.25 }])
      expect(crosscheckOf(proposed.rows, 1000, null)).toMatchObject({ totalDiff: -250, totalMatches: false })
      expect(proposed.filledNet).toBeNull()
      // The lines are no worse than the rows: they stay a choice.
      expect(proposed.invoiceRows).toHaveLength(2)
    })

    it('gives the same cross-check as a row per line gave', () => {
      const lines = [line(299, 25), line(250, 25), line(220, 12), line(15.5, 0)]
      const proposed = rowsFromReading(reading({ total: 1200 }, lines), REGISTERED)
      const perLine = lines.map((li) => ({ description: li.description, amount: li.lineTotal, vat_rate: (li.vatRate ?? 25) / 100 }))
      expect(proposed.rows).toHaveLength(3)
      expect(crosscheckOf(proposed.rows, 1200, null).totalDiff).toBe(crosscheckOf(perLine, 1200, null).totalDiff)
    })

    it('reads a moms of zero beside lines that charge moms as no figure', () => {
      const proposed = rowsFromReading(reading({ total: 1250, vatAmount: 0 }, [line(600, 25), line(400, 25)]), REGISTERED)
      expect(proposed.invoiceVat).toBeNull()
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 1000, vat_rate: 0.25 }])
    })

    it('takes a moms of zero as stated when no line charges moms', () => {
      const proposed = rowsFromReading(reading({ total: 500, vatAmount: 0 }, [line(300, 0), line(200, 0)]), REGISTERED)
      expect(proposed.invoiceVat).toBe(0)
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 500, vat_rate: 0 }])
      expect(proposed.filledNet).toBe(500)
    })
  })

  describe('a credit note', () => {
    it('carries the signs through: one negative row that adds up to the negative totals', () => {
      const proposed = rowsFromReading(
        reading({ total: -1136, vatAmount: -227.2 }, [line(-299, 25), line(-250, 25), line(-220, 25)]),
        REGISTERED,
      )
      expect(proposed.invoiceTotal).toBe(-1136)
      expect(proposed.invoiceVat).toBe(-227.2)
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: -908.8, vat_rate: 0.25 }])
      expect(roundOre(proposed.rows[0].amount + -227.2)).toBe(-1136)
      expect(crosscheckOf(proposed.rows, -1136, -227.2)).toMatchObject({ totalDiff: 0, vatDiff: 0 })
    })

    it('sums credited lines that add up, and rounds the way the invoice did', () => {
      const proposed = rowsFromReading(reading({ total: -19, vatAmount: -3.75 }, [line(-10, 25), line(-5, 25)]), REGISTERED)
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: -15, vat_rate: 0.25 }])
      expect(crosscheckOf(proposed.rows, -19, -3.75)).toMatchObject({ totalMatches: true, vatMatches: true, oreRounding: true })
    })
  })

  describe('a company that is not momsregistrerad', () => {
    const NOT_REGISTERED = { vatRegistered: false, reverseCharge: false }

    it('books the whole Fakturabelopp as the cost, on one row at 0 %', () => {
      const proposed = rowsFromReading(
        reading({ total: 1136, vatAmount: 227.2 }, [line(299, 25), line(250, 25), line(220, 25)]),
        NOT_REGISTERED,
      )
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 1136, vat_rate: 0 }])
      expect(proposed.filledNet).toBe(1136)
      expect(crosscheckOf(proposed.rows, 1136, null)).toMatchObject({ totalDiff: 0, totalMatches: true })
      expect(proposed.invoiceRows).toBeNull()
    })

    it('is the sum the old row-per-line prefill reached after the editor grossed each line up', () => {
      const lines = [line(600, 25), line(400, 25)]
      const proposed = rowsFromReading(reading({ total: 1250, vatAmount: 250 }, lines), NOT_REGISTERED)
      const grossedUp = roundOre(lines.reduce((sum, li) => sum + roundOre(li.lineTotal + netVat(li.lineTotal, 0.25)), 0))
      expect(proposed.rows[0].amount).toBe(grossedUp)
      // The lines add up, so they stay a choice: each with its moms as cost.
      expect(proposed.invoiceRows?.map((row) => [row.amount, row.vat_rate])).toEqual([[750, 0], [500, 0]])
    })
  })

  describe('a foreign currency', () => {
    it('adds up in the document currency', () => {
      const proposed = rowsFromReading(reading({ total: 125, vatAmount: 25 }, [line(60, 25), line(40, 25)], 'EUR'), REGISTERED)
      expect(proposed.rows).toEqual([{ description: 'Rad', amount: 100, vat_rate: 0.25 }])
      expect(crosscheckOf(proposed.rows, 125, 25, 'EUR')).toMatchObject({ totalDiff: 0, vatDiff: 0 })
    })

    it('knows no öresavrundning: a rounded total is a difference the cross-check shows', () => {
      const sek = rowsFromReading(reading({ total: 19, vatAmount: 3.75 }, [line(10, 25), line(5, 25)]), REGISTERED)
      expect(crosscheckOf(sek.rows, 19, 3.75)).toMatchObject({ totalMatches: true, oreRounding: true })
      const eur = rowsFromReading(reading({ total: 19, vatAmount: 3.75 }, [line(10, 25), line(5, 25)], 'EUR'), REGISTERED)
      expect(eur.rows).toEqual([{ description: 'Rad', amount: 15, vat_rate: 0.25 }])
      expect(crosscheckOf(eur.rows, 19, 3.75, 'EUR')).toMatchObject({ totalDiff: 0.25, totalMatches: false, oreRounding: false })
    })
  })

  describe('a reading without lines', () => {
    it('proposes no rows and still hands over the totals', () => {
      expect(rowsFromReading(reading({ total: 1136, vatAmount: 227.2 }, []), REGISTERED)).toEqual({
        invoiceTotal: 1136,
        invoiceVat: 227.2,
        rows: [],
        filledNet: null,
        invoiceRows: null,
      })
    })

    it('is nothing at all without a reading', () => {
      expect(rowsFromReading(null, REGISTERED)).toEqual({ invoiceTotal: null, invoiceVat: null, rows: [], filledNet: null, invoiceRows: null })
    })
  })

  // Review round 1 on PR #189: each of these opened wrong before the fix.
  describe('several satser that are an öre or a line off: a row per sats, never one totals row', () => {
    it('keeps both rows of a receipt priced incl. moms (Lunch 129,50 at 12 %, Öl 69,00 at 25 %)', () => {
      // The receipt takes each moms from the gross (13,88 + 13,80); the
      // editor takes it on the net (13,87 + 13,80): one öre apart.
      const receipt = [line(115.62, 12, 'Lunch'), line(55.2, 25, 'Öl')]
      for (const specification of [[], [{ rate: 12, base: 115.62, amount: 13.88 }, { rate: 25, base: 55.2, amount: 13.8 }]]) {
        const proposed = rowsFromReading(reading({ total: 198.5, vatAmount: 27.68 }, receipt, 'SEK', specification), REGISTERED)
        expect(proposed.rows).toEqual([
          { description: 'Lunch', amount: 115.62, vat_rate: 0.12 },
          { description: 'Öl', amount: 55.2, vat_rate: 0.25 },
        ])
        // What a row per line showed before, to the öre.
        expect(crosscheckOf(proposed.rows, 198.5, 27.68)).toMatchObject({ totalDiff: 0.01, vatDiff: 0.01 })
        expect(proposed.filledNet).toBeNull()
      }
    })

    it('keeps the satser when the seller rounds moms per line', () => {
      // Three lines of 10,04 at 12 % (1,20 each, 3,61 on the sum) and 100 at 25 %.
      const lines = [line(10.04, 12, 'Kaffe'), line(10.04, 12, 'Te'), line(10.04, 12, 'Mjölk'), line(100, 25, 'Disk')]
      for (const currency of ['SEK', 'EUR']) {
        const proposed = rowsFromReading(reading({ total: 158.72, vatAmount: 28.6 }, lines, currency), REGISTERED)
        expect(proposed.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[30.12, 0.12], [100, 0.25]])
        expect(crosscheckOf(proposed.rows, 158.72, 28.6, currency).totalDiff).toBe(-0.01)
        // The rows are the lines' own sums: the lines stay a choice.
        expect(proposed.invoiceRows).toHaveLength(4)
      }
    })

    it('keeps the satser of a credit note that mirrors its invoice', () => {
      // -100,02 at 25 % is -25,01 on the note and -25,00 by the editor's rounding.
      const proposed = rowsFromReading(
        reading({ total: -181.03, vatAmount: -31.01 }, [line(-100.02, 25, 'Retur'), line(-50, 12, 'Retur mat')]),
        REGISTERED,
      )
      expect(proposed.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[-100.02, 0.25], [-50, 0.12]])
      expect(crosscheckOf(proposed.rows, -181.03, -31.01).totalDiff).toBe(-0.01)
    })

    it('keeps the lines\' sums when the invoice spreads a freight line over both satser, and takes its specification when that was read', () => {
      const lines = [line(1000, 12, 'Mat'), line(500, 25, 'Disk'), line(90, 25, 'Frakt')]
      const without = rowsFromReading(reading({ total: 1849.7, vatAmount: 259.7 }, lines), REGISTERED)
      expect(without.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[1000, 0.12], [590, 0.25]])
      expect(crosscheckOf(without.rows, 1849.7, 259.7).totalDiff).toBe(-7.8)

      const specified = rowsFromReading(
        reading({ total: 1849.7, vatAmount: 259.7 }, lines, 'SEK', [{ rate: 12, base: 1060, amount: 127.2 }, { rate: 25, base: 530, amount: 132.5 }]),
        REGISTERED,
      )
      expect(specified.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[1060, 0.12], [530, 0.25]])
      expect(crosscheckOf(specified.rows, 1849.7, 259.7)).toMatchObject({ totalDiff: 0, vatDiff: 0 })
    })

    it('never takes a specification that states fewer satser than the lines charge', () => {
      // A specification of one sats that happens to add up: 1 448 + 362 = 1 810.
      const proposed = rowsFromReading(
        reading({ total: 1810, vatAmount: 362 }, [line(1000, 25), line(500, 12)], 'SEK', [{ rate: 25, base: 1448, amount: 362 }]),
        REGISTERED,
      )
      expect(proposed.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[1000, 0.25], [500, 0.12]])
    })
  })

  describe('lines and totals of opposite signs', () => {
    it('takes nothing from the totals when negative lines stand above a positive amount', () => {
      // A credit note that prints its lines negative and "Er tillgodo 1 250,00".
      const proposed = rowsFromReading(reading({ total: 1250, vatAmount: 250 }, [line(-600, 25), line(-400, 25)]), REGISTERED)
      expect(proposed.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[-1000, 0.25]])
      // The difference a row per line showed before.
      expect(crosscheckOf(proposed.rows, 1250, 250)).toMatchObject({ totalDiff: 2500, totalMatches: false })
      expect(proposed.filledNet).toBeNull()
    })

    it('does the same at two satser', () => {
      const proposed = rowsFromReading(reading({ total: 1810, vatAmount: 310 }, [line(-1000, 25), line(-500, 12)]), REGISTERED)
      expect(proposed.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[-1000, 0.25], [-500, 0.12]])
      expect(crosscheckOf(proposed.rows, 1810, 310).totalDiff).toBe(3620)
    })

    it('does the same for positive lines under a negative total', () => {
      const proposed = rowsFromReading(reading({ total: -1250, vatAmount: -250 }, [line(600, 25), line(400, 25)]), REGISTERED)
      expect(proposed.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[1000, 0.25]])
      expect(crosscheckOf(proposed.rows, -1250, -250).totalDiff).toBe(-2500)
    })

    it('does the same for a company that is not momsregistrerad: the lines as cost, not the Fakturabelopp', () => {
      const proposed = rowsFromReading(reading({ total: 1250, vatAmount: 250 }, [line(-600, 25), line(-400, 25)]), {
        vatRegistered: false,
        reverseCharge: false,
      })
      expect(proposed.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[-1250, 0]])
      expect(crosscheckOf(proposed.rows, 1250, null).totalDiff).toBe(2500)
      expect(proposed.filledNet).toBeNull()
    })
  })

  describe('reverse charge: nothing is taken from the totals', () => {
    const REVERSE = { vatRegistered: true, reverseCharge: true }
    const perLineOf = (lines: ReturnType<typeof line>[]) =>
      lines.map((li) => ({ description: li.description, amount: li.lineTotal, vat_rate: (li.vatRate ?? 25) / 100 }))

    it('shows what a row per line showed when the seller charged moms anyway: the lines\' net, and the rest as a difference', () => {
      // 919,20 + 229,80 billed as 1 149,00 by a foreign seller.
      const lines = [line(919.2, 25, 'Licens')]
      const proposed = rowsFromReading(reading({ total: 1149, vatAmount: 229.8 }, lines, 'EUR'), REVERSE)
      expect(proposed.rows).toEqual([{ description: 'Licens', amount: 919.2, vat_rate: 0.25 }])
      const now = crosscheckOf(proposed.rows, 1149, null, 'EUR', true)
      expect(now.totalDiff).toBe(229.8)
      expect(now.totalDiff).toBe(crosscheckOf(perLineOf(lines), 1149, null, 'EUR', true).totalDiff)
      // Never the total-first fill's row: it stands as read.
      expect(proposed.filledNet).toBeNull()
    })

    it('gives one answer for two lines, combined or split', () => {
      const lines = [line(600, 25, 'Hosting'), line(400, 25, 'Support')]
      const proposed = rowsFromReading(reading({ total: 1250, vatAmount: 250 }, lines, 'EUR'), REVERSE)
      expect(proposed.rows).toEqual([{ description: 'Hosting', amount: 1000, vat_rate: 0.25 }])
      expect(proposed.filledNet).toBeNull()
      expect(proposed.invoiceRows).toHaveLength(2)
      const combined = crosscheckOf(proposed.rows, 1250, null, 'EUR', true).totalDiff
      expect(combined).toBe(250)
      expect(crosscheckOf(proposed.invoiceRows ?? [], 1250, null, 'EUR', true).totalDiff).toBe(combined)
      expect(crosscheckOf(perLineOf(lines), 1250, null, 'EUR', true).totalDiff).toBe(combined)
    })

    it('keeps the lines\' sum when a line was lost, as a row per line did', () => {
      const lines = [line(299, 25), line(250, 25), line(220, 25)]
      const proposed = rowsFromReading(reading({ total: 1136, vatAmount: 227.2 }, lines), REVERSE)
      expect(proposed.rows.map((row) => row.amount)).toEqual([769])
      expect(crosscheckOf(proposed.rows, 1136, null, 'SEK', true).totalDiff).toBe(367)
      expect(proposed.filledNet).toBeNull()
    })

    it('is the whole invoice when the seller charged no moms', () => {
      const proposed = rowsFromReading(reading({ total: 1000, vatAmount: 0 }, [line(700, 0), line(300, 0)], 'EUR'), REVERSE)
      expect(proposed.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[1000, 0]])
      expect(crosscheckOf(proposed.rows, 1000, null, 'EUR', true)).toMatchObject({ totalDiff: 0, totalMatches: true })
      expect(proposed.filledNet).toBeNull()
      expect(proposed.invoiceRows).toHaveLength(2)
    })

    // This pins the function's answer, which is not what the editor ends on.
    // For a company that is not momsregistrerad the function folds no moms
    // into the cost under reverse charge (sellerVatIsCost), so the rows keep
    // the sats they were read with. The form's own zeroing effect then
    // grosses every row with a sats up by it, reverse charge or not, exactly
    // as on main: the editor shows main's figures, in either order.
    it('gives a company that is not momsregistrerad its rows at their read sats: the form\'s zeroing effect then makes main\'s figures of them', () => {
      const notRegistered = { vatRegistered: false, reverseCharge: true }
      // The zeroing effect as it stands in NewSupplierInvoiceForm: amount + moms on it, at 0 %.
      const afterTheFormsZeroing = (rows: ReadingRow[]) =>
        rows.map((row) => (row.vat_rate === 0 ? row.amount : roundOre(row.amount + netVat(row.amount, row.vat_rate))))

      // 919,20 + 229,80 = 1 149,00: the editor ends on 1 149,00 at 0 % and
      // "Stämmer", as main does. The seller's moms is in the row, not a difference.
      const charged = rowsFromReading(reading({ total: 1149, vatAmount: 229.8 }, [line(919.2, 25)], 'EUR'), notRegistered)
      expect(charged.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[919.2, 0.25]])
      expect(afterTheFormsZeroing(charged.rows)).toEqual([1149])

      // No moms charged, lines read without a sats (25 % by default), total
      // 1 000,00: the editor ends on 1 250,00 and "Diff -250,00", as main
      // does (875,00 + 375,00).
      const lines = [line(700, null), line(300, null)]
      const unrated = rowsFromReading(reading({ total: 1000, vatAmount: 0 }, lines, 'EUR'), notRegistered)
      expect(unrated.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[1000, 0.25]])
      expect(afterTheFormsZeroing(unrated.rows)).toEqual([1250])
      expect(afterTheFormsZeroing(lines.map((li) => ({ description: li.description, amount: li.lineTotal, vat_rate: 0.25 })))).toEqual([875, 375])
      // When the foreign supplier is picked after the reading, the same
      // reading has opened on the whole Fakturabelopp first, and is replaced
      // by the rows above once reverse charge is on.
      const before = rowsFromReading(reading({ total: 1000, vatAmount: 0 }, lines, 'EUR'), { vatRegistered: false, reverseCharge: false })
      expect(before.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[1000, 0]])
    })
  })

  describe('the text of a row', () => {
    it('is the text of its largest line when it sums several, so it is never left empty', () => {
      const proposed = rowsFromReading(
        reading({ total: 1250, vatAmount: 250 }, [line(150, 25, 'Frakt'), line(600, 25, 'Konsulttimmar'), line(250, 25, 'Resor')]),
        REGISTERED,
      )
      expect(proposed.rows).toEqual([{ description: 'Konsulttimmar', amount: 1000, vat_rate: 0.25 }])
    })

    it('is a read line\'s text also on a row from the totals, and on a sats no line was read at', () => {
      const lost = rowsFromReading(reading({ total: 1136, vatAmount: 227.2 }, [line(299, 25, 'Abonnemang'), line(250, 25, 'Surf')]), REGISTERED)
      expect(lost.rows).toEqual([{ description: 'Abonnemang', amount: 908.8, vat_rate: 0.25 }])
      const specified = rowsFromReading(
        reading({ total: 1120, vatAmount: 120 }, [line(400, null, 'Frukost'), line(600, null, 'Logi')], 'SEK', [{ rate: 12, base: 1000, amount: 120 }]),
        REGISTERED,
      )
      expect(specified.rows).toEqual([{ description: 'Logi', amount: 1000, vat_rate: 0.12 }])
    })

    it('skips lines without a text, and is empty only when no line had one', () => {
      const proposed = rowsFromReading(reading({ total: 1250, vatAmount: 250 }, [line(600, 25, ''), line(400, 25, 'Resor')]), REGISTERED)
      expect(proposed.rows[0].description).toBe('Resor')
      const none = rowsFromReading(reading({ total: 1250, vatAmount: 250 }, [line(600, 25, ''), line(400, 25, '')]), REGISTERED)
      expect(none.rows[0].description).toBe('')
    })
  })

  describe('a reading that proposes no rows', () => {
    it('offers no split either: there is nothing on screen to split', () => {
      const proposed = rowsFromReading(reading({ total: 500 }, [line(0, 25), line(0, 25)]), REGISTERED)
      expect(proposed.rows).toEqual([])
      expect(proposed.invoiceRows).toBeNull()
    })
  })

  // Invoices a seller can issue at one sats, in steps of 9,97 kr from 0,01
  // to 4 000 kr (every öre ending): moms on the net, billed to the öre or to
  // the whole krona. The reading has it whole or has lost a line; either way
  // it opens as one row that the editor's cross-check accepts, with the
  // invoice's own figures.
  describe.each([0.25, 0.12, 0.06])('every invoice at %s', (rate) => {
    const percent = rate * 100
    const mustBeTheNetOnOneRow = (rows: ReadingRow[], { net, vat, total }: { net: number; vat: number; total: number }) => {
      const check = crosscheckOf(rows, total, vat)
      if (rows.length !== 1 || rows[0].amount !== net || !check.totalMatches || !check.vatMatches) {
        throw new Error(`net ${net} moms ${vat} total ${total}: ${JSON.stringify(rows)} ${JSON.stringify(check)}`)
      }
    }
    const cases = function* () {
      for (let netOre = 1; netOre <= 400_000; netOre += 997) {
        const net = netOre / 100
        const vat = netVat(net, rate)
        const exact = roundOre(net + vat)
        yield { net, vat, total: exact }
        const rounded = Math.round(exact)
        if (rounded !== exact && rounded !== 0) yield { net, vat, total: rounded }
      }
    }

    it('opens as one row that adds up when every line was read', () => {
      for (const invoice of cases()) {
        const { net, vat, total } = invoice
        const half = roundOre(net / 2)
        const lines = [line(half, percent), line(roundOre(net - half), percent)]
        mustBeTheNetOnOneRow(rowsFromReading(reading({ total, vatAmount: vat }, lines), REGISTERED).rows, invoice)
      }
    })

    it('opens as one row that adds up when a line was lost and the invoice prints its net', () => {
      for (const invoice of cases()) {
        const { net, vat, total } = invoice
        const lines = [line(roundOre(net / 3), percent), line(0.01, percent)]
        mustBeTheNetOnOneRow(rowsFromReading(reading({ total, vatAmount: vat, subtotal: net }, lines), REGISTERED).rows, invoice)
      }
    })

    it('opens as one row that adds up when a line was lost and only total and moms were read, unless a rounded total hides the net', () => {
      let hidden = 0
      let seen = 0
      for (const { net, vat, total } of cases()) {
        seen += 1
        const lines = [line(roundOre(net / 3), percent), line(0.01, percent)]
        const proposed = rowsFromReading(reading({ total, vatAmount: vat }, lines), REGISTERED)
        const check = crosscheckOf(proposed.rows, total, vat)
        if (proposed.rows.length !== 1) throw new Error(`net ${net}: ${proposed.rows.length} rows`)
        // The moms is always the invoice's: the net came from it.
        if (!check.vatMatches) throw new Error(`net ${net} moms ${vat} total ${total}: moms ${JSON.stringify(check)}`)
        if (!check.totalMatches) {
          // Only a total rounded to the krona can hide the net, never one billed to the öre.
          if (total === roundOre(net + vat)) throw new Error(`net ${net} moms ${vat} total ${total}: ${JSON.stringify(check)}`)
          hidden += 1
        }
      }
      expect(hidden / seen).toBeLessThan(0.05)
    })
  })

  // Readings at two and three satser from a fixed generator, the same on
  // every run: 1 to 4 lines per sats, amounts to the öre. Whatever the seller
  // did (moms per line, prices incl. moms, a credit note, a freight line
  // spread over the satser, euro, a whole-krona total) and whatever the
  // reader lost, the reading opens with every sats its lines charge, and its
  // rows are never further from the Fakturabelopp than a row per line was.
  describe.each([2, 3])('generated readings at %i satser', (rateCount) => {
    const PERCENTS = [25, 12, 6]
    const READINGS = 200
    type Line = ReturnType<typeof line>

    function* invoices(seed: number) {
      let state = seed
      const next = () => {
        state = (state * 1664525 + 1013904223) >>> 0
        return state / 2 ** 32
      }
      for (let n = 0; n < READINGS; n++) {
        const first = Math.floor(next() * 3)
        const percents = Array.from({ length: rateCount }, (_, i) => PERCENTS[(first + i) % 3])
        const lines: Line[] = []
        for (const percent of percents) {
          const count = 1 + Math.floor(next() * 4)
          for (let k = 0; k < count; k++) lines.push(line(Math.max(1, Math.round(next() * 40_000)) / 100, percent))
        }
        yield { percents, lines, next }
      }
    }
    const netOf = (lines: Line[], percent: number) =>
      roundOre(lines.filter((li) => li.vatRate === percent).reduce((sum, li) => sum + li.lineTotal, 0))
    const sum = (values: number[]) => roundOre(values.reduce((a, b) => a + b, 0))

    /** The two promises, for one reading. Returns how far its rows are from the total. */
    function mustKeepItsSatser(r: Reading, currency = 'SEK') {
      const proposed = rowsFromReading(r, REGISTERED)
      const perLine = r!.lineItems.map((li) => ({ description: li.description, amount: li.lineTotal, vat_rate: (li.vatRate ?? 25) / 100 }))
      const said = `${JSON.stringify(r!.totals)} ${JSON.stringify(perLine.map((l) => [l.amount, l.vat_rate]))} opened as ${JSON.stringify(proposed.rows.map((row) => [row.amount, row.vat_rate]))}`
      for (const rate of new Set(perLine.map((l) => l.vat_rate))) {
        if (!proposed.rows.some((row) => row.vat_rate === rate)) throw new Error(`the sats ${rate} is gone: ${said}`)
      }
      const before = Math.abs(crosscheckOf(perLine, proposed.invoiceTotal, null, currency).totalDiff ?? 0)
      const check = crosscheckOf(proposed.rows, proposed.invoiceTotal, proposed.invoiceVat, currency)
      const now = Math.abs(check.totalDiff ?? 0)
      if (now > before) throw new Error(`${now} from the total, a row per line was ${before}: ${said}`)
      return { proposed, check, said }
    }

    it('adds up on one row per sats when the moms is taken on each sats\' sum', () => {
      for (const { percents, lines } of invoices(20261118)) {
        const vat = sum(percents.map((percent) => netVat(netOf(lines, percent), percent / 100)))
        const total = roundOre(sum(lines.map((li) => li.lineTotal)) + vat)
        for (const billed of [total, Math.round(total)]) {
          const { proposed, check, said } = mustKeepItsSatser(reading({ total: billed, vatAmount: vat }, lines))
          if (proposed.rows.length !== rateCount || !check.totalMatches || !check.vatMatches) throw new Error(`does not add up: ${said}`)
        }
      }
    })

    it('keeps its satser when the seller rounds moms per line, in kronor, in euro and on a credit note', () => {
      for (const { lines } of invoices(7)) {
        const vat = sum(lines.map((li) => netVat(li.lineTotal, (li.vatRate ?? 0) / 100)))
        const total = roundOre(sum(lines.map((li) => li.lineTotal)) + vat)
        mustKeepItsSatser(reading({ total, vatAmount: vat }, lines))
        mustKeepItsSatser(reading({ total: Math.round(total), vatAmount: vat }, lines))
        mustKeepItsSatser(reading({ total, vatAmount: vat }, lines, 'EUR'), 'EUR')
        const credited = lines.map((li) => line(-li.lineTotal, li.vatRate))
        mustKeepItsSatser(reading({ total: -total, vatAmount: -vat }, credited))
      }
    })

    it('keeps its satser when the prices are incl. moms, with and without the receipt\'s moms specification', () => {
      for (const { percents, next } of invoices(42)) {
        // Prices in steps of 10 öre; the reader gives each line excl. moms.
        const priced = percents.flatMap((percent) =>
          Array.from({ length: 1 + Math.floor(next() * 4) }, () => ({ percent, gross: Math.max(10, Math.round(next() * 3000)) / 10 })),
        )
        const lines = priced.map(({ percent, gross }) => line(splitGrossVat(gross, percent / 100).net, percent))
        const specification = percents.map((percent) => {
          const split = splitGrossVat(sum(priced.filter((p) => p.percent === percent).map((p) => p.gross)), percent / 100)
          return { rate: percent, base: split.net, amount: split.vat }
        })
        const totals = { total: sum(priced.map((p) => p.gross)), vatAmount: sum(specification.map((entry) => entry.amount)) }
        mustKeepItsSatser(reading(totals, lines))
        mustKeepItsSatser(reading(totals, lines, 'SEK', specification))
      }
    })

    it('keeps its satser when the invoice spreads a freight line over them, and adds up once its specification is read', () => {
      for (const { percents, lines, next } of invoices(1984)) {
        // The freight is one read line at the first sats; the invoice prints
        // each sats' net with its share of it.
        const freight = Math.max(1, Math.round(next() * 20_000)) / 100
        const goods = sum(lines.map((li) => li.lineTotal))
        const shares = percents.map((percent) => roundOre((freight * netOf(lines, percent)) / goods))
        shares[0] = roundOre(shares[0] + freight - sum(shares))
        const specification = percents.map((percent, i) => {
          const base = roundOre(netOf(lines, percent) + shares[i])
          return { rate: percent, base, amount: netVat(base, percent / 100) }
        })
        const read = [...lines, line(freight, percents[0], 'Frakt')]
        const vat = sum(specification.map((entry) => entry.amount))
        const totals = { total: roundOre(goods + freight + vat), vatAmount: vat }
        mustKeepItsSatser(reading(totals, read))
        const { check, said } = mustKeepItsSatser(reading(totals, read, 'SEK', specification))
        if (!check.totalMatches || !check.vatMatches) throw new Error(`does not add up with its specification: ${said}`)
      }
    })

    it('keeps the satser it read when a line was lost', () => {
      for (const { percents, lines } of invoices(311)) {
        const vat = sum(percents.map((percent) => netVat(netOf(lines, percent), percent / 100)))
        const total = roundOre(sum(lines.map((li) => li.lineTotal)) + vat)
        mustKeepItsSatser(reading({ total, vatAmount: vat }, lines.slice(1)))
        mustKeepItsSatser(reading({ total, vatAmount: vat }, lines.slice(0, -1)))
      }
    })
  })
})

describe('accountCarriedFrom', () => {
  const row = (vat_rate: number): ReadingRow => ({ description: '', amount: 100, vat_rate })

  it('starts a split on the account the row of the same sats already has', () => {
    const accountFor = accountCarriedFrom(
      [{ account_number: '6212', vat_rate: 0.25 }, { account_number: '5800', vat_rate: 0.06 }],
      null,
    )
    expect(accountFor(row(0.25))).toBe('6212')
    expect(accountFor(row(0.06))).toBe('5800')
  })

  it('takes the first account chosen for a sats the rows do not carry', () => {
    // A company that is not momsregistrerad holds its one row at 0 %.
    const accountFor = accountCarriedFrom([{ account_number: '', vat_rate: 0.25 }, { account_number: '6212', vat_rate: 0 }], '5010')
    expect(accountFor(row(0.25))).toBe('6212')
  })

  it('falls back to the plan account, else leaves the account for the person', () => {
    expect(accountCarriedFrom([{ account_number: '', vat_rate: 0.25 }], '5010')(row(0.25))).toBe('5010')
    expect(accountCarriedFrom([], null)(row(0.25))).toBe('')
  })
})

describe('rowsStandAsPut', () => {
  const put: SupplierInvoiceLineItem[] = [
    { description: 'Abonnemang', amount: 908.8, account_number: '', vat_rate: 0.25, accrual_period_start: undefined, accrual_period_end: undefined, accrual_balance_account: undefined },
    { description: 'Avgift', amount: 60, account_number: '', vat_rate: 0 },
  ]
  const nameOf = (account: string) => (account === '6212' ? 'Mobiltelefon' : '')
  const changed = (index: number, patch: Partial<SupplierInvoiceLineItem>, rows = put) =>
    rows.map((row, i) => (i === index ? { ...row, ...patch } : row))

  it('is true while the rows are what was put there: an absent field and an undefined one are the same', () => {
    expect(rowsStandAsPut(put, put, nameOf)).toBe(true)
    expect(rowsStandAsPut([{ description: 'Abonnemang', amount: 908.8, account_number: '', vat_rate: 0.25 }, put[1]], put, nameOf)).toBe(true)
    expect(rowsStandAsPut(changed(1, { dimensions: undefined, apply_slp: undefined }), put, nameOf)).toBe(true)
    expect(rowsStandAsPut([], [], nameOf)).toBe(true)
  })

  it('is true after an account has landed on the rows: it travels with them when they are swapped', () => {
    // The supplier's default account, filled in by the form after the reading.
    expect(rowsStandAsPut(put.map((row) => ({ ...row, account_number: '6212' })), put, nameOf)).toBe(true)
    // Or chosen by the person on one row: the other is still empty.
    expect(rowsStandAsPut(changed(0, { account_number: '6212' }), put, nameOf)).toBe(true)
  })

  it('is true when a row put without a text has been named after its account by the form', () => {
    const untexted = changed(0, { description: '' })
    expect(rowsStandAsPut(changed(0, { description: 'Mobiltelefon', account_number: '6212' }, untexted), untexted, nameOf)).toBe(true)
    // Any other text on it is the person's.
    expect(rowsStandAsPut(changed(0, { description: 'Telefoni mars', account_number: '6212' }, untexted), untexted, nameOf)).toBe(false)
  })

  // Review round 1, finding 4: "Dela upp" and "Slå ihop" replayed the reading
  // over whatever the person had changed. Each of these now takes the link away.
  it.each<[string, Partial<SupplierInvoiceLineItem>]>([
    ['a corrected amount', { amount: 450 }],
    ['a text', { description: 'Telefoni mars' }],
    ['another sats', { vat_rate: 0.12 }],
    ['a periodisering', { accrual_period_start: '2026-11-01', accrual_period_end: '2027-10-31', accrual_balance_account: '1790' }],
    ['a dimension', { dimensions: { '1': 'STHLM' } }],
    ['an opened dimension panel', { dimensions: {} }],
    ['särskild löneskatt', { apply_slp: true }],
    ['a limited deduction', { vat_deduction_share: 0.5 }],
    ['another reverse-charge sats', { reverse_charge_rate: 0.12 }],
  ])('is false once the person has set %s on a row', (_what, patch) => {
    expect(rowsStandAsPut(changed(1, patch), put, nameOf)).toBe(false)
    expect(rowsStandAsPut(changed(0, patch), put, nameOf)).toBe(false)
  })

  it('is false once another interim account was chosen for a periodisering the reading opened', () => {
    const accrued = changed(0, { accrual_period_start: '2026-11-01', accrual_period_end: '2027-10-31', accrual_balance_account: '1790' })
    expect(rowsStandAsPut(accrued, accrued, nameOf)).toBe(true)
    expect(rowsStandAsPut(changed(0, { accrual_balance_account: '1710' }, accrued), accrued, nameOf)).toBe(false)
  })

  it('is false once lines of one sats were put on different accounts: combining them would merge the accounts away', () => {
    const lines: SupplierInvoiceLineItem[] = [
      { description: 'Licens', amount: 600, account_number: '', vat_rate: 0.25 },
      { description: 'Resor', amount: 400, account_number: '', vat_rate: 0.25 },
      { description: 'Lunch', amount: 500, account_number: '', vat_rate: 0.12 },
    ]
    const on = (accounts: string[]) => lines.map((row, i) => ({ ...row, account_number: accounts[i] }))
    expect(rowsStandAsPut(on(['6540', '6540', '5831']), lines, nameOf)).toBe(true)
    expect(rowsStandAsPut(on(['6540', '', '5831']), lines, nameOf)).toBe(true)
    expect(rowsStandAsPut(on(['6540', '5800', '5831']), lines, nameOf)).toBe(false)
  })

  it('is false once a row was added or removed', () => {
    expect(rowsStandAsPut([put[0]], put, nameOf)).toBe(false)
    expect(rowsStandAsPut([...put, { description: '', amount: 0, account_number: '4010', vat_rate: 0.25 }], put, nameOf)).toBe(false)
  })

  // The browser proof of 2026-11-18: for a momsregistrerad company, reverse
  // charge switched on after the reading left the rows as they were (908,80
  // where the supplier known first gave 769,00), and the split link went
  // away. The row below is the form's own state as read there: nobody had
  // touched it. Its sats cell had become the reverse-charge sats and handed
  // the row's 25 % over.
  describe('what the editor does to a row by itself is no change by the person', () => {
    const asPut: SupplierInvoiceLineItem[] = [
      { description: 'Abonnemang Mobil Bas', amount: 908.8, account_number: '', vat_rate: 0.25, accrual_period_start: undefined, accrual_period_end: undefined, accrual_balance_account: undefined },
    ]
    const asTheFormHeldIt: SupplierInvoiceLineItem[] = [
      { description: 'Abonnemang Mobil Bas', amount: 908.8, account_number: '6212', vat_rate: 0.25, accrual_period_start: undefined, accrual_period_end: undefined, accrual_balance_account: undefined, reverse_charge_rate: 0.25 },
    ]

    it('stands with the reverse-charge sats the sats cell hands over when reverse charge is switched on', () => {
      expect(rowsStandAsPut(asTheFormHeldIt, asPut, nameOf)).toBe(true)
      // A row put at 12 % is handed 12 %, one put at 0 % is handed 0.
      const reduced = [{ ...asPut[0], vat_rate: 0.12 }, { ...asPut[0], vat_rate: 0 }]
      expect(rowsStandAsPut(reduced.map((row) => ({ ...row, reverse_charge_rate: row.vat_rate })), reduced, nameOf)).toBe(true)
    })

    it('keeps offering the split under reverse charge until the person edits a row', () => {
      const edited = (patch: Partial<SupplierInvoiceLineItem>) => [{ ...asTheFormHeldIt[0], ...patch }]
      expect(rowsStandAsPut(asTheFormHeldIt, asPut, nameOf)).toBe(true)
      expect(rowsStandAsPut(edited({ amount: 769 }), asPut, nameOf)).toBe(false)
      expect(rowsStandAsPut(edited({ description: 'Mobil, november' }), asPut, nameOf)).toBe(false)
      // Another reverse-charge sats than the row's own is the person's choice.
      expect(rowsStandAsPut(edited({ reverse_charge_rate: 0.12 }), asPut, nameOf)).toBe(false)
      expect(rowsStandAsPut([{ ...asPut[0], vat_rate: 0.12, reverse_charge_rate: 0.25 }], [{ ...asPut[0], vat_rate: 0.12 }], nameOf)).toBe(false)
    })

    it('stands with a reverse-charge sats that was put with the row, and not once that one is changed', () => {
      const carried = [{ ...asPut[0], amount: 769, reverse_charge_rate: 0.12 }]
      expect(rowsStandAsPut(carried, carried, nameOf)).toBe(true)
      expect(rowsStandAsPut([{ ...carried[0], reverse_charge_rate: 0.25 }], carried, nameOf)).toBe(false)
    })

    it('stands, for a company that is not momsregistrerad, with each row\'s moms booked as cost by the editor', () => {
      // Under reverse charge its rows are put with the sats they were read
      // with, and the editor's zeroing makes them gross at 0 %.
      const read: SupplierInvoiceLineItem[] = [
        { description: 'Konsulttimmar', amount: 700, account_number: '', vat_rate: 0.25 },
        { description: 'Lunch', amount: 300, account_number: '', vat_rate: 0.12 },
      ]
      const zeroed = [{ ...read[0], amount: 875, vat_rate: 0 }, { ...read[1], amount: 336, vat_rate: 0 }]
      expect(rowsStandAsPut(zeroed, read, nameOf, false)).toBe(true)
      // Before the zeroing has run they are still as put.
      expect(rowsStandAsPut(read, read, nameOf, false)).toBe(true)
      // An amount typed over the zeroed one is the person's.
      expect(rowsStandAsPut([{ ...zeroed[0], amount: 900 }, zeroed[1]], read, nameOf, false)).toBe(false)
      // A momsregistrerad company's editor zeroes nothing: there the same rows were changed by someone.
      expect(rowsStandAsPut(zeroed, read, nameOf)).toBe(false)
      expect(rowsStandAsPut(zeroed, read, nameOf, true)).toBe(false)
    })
  })
})

describe('reverseChargeRateCarriedFrom', () => {
  const row = (vat_rate: number): ReadingRow => ({ description: '', amount: 100, vat_rate })

  it('gives a row the reverse-charge sats the editor gave its moms sats on screen', () => {
    const rateFor = reverseChargeRateCarriedFrom([
      { vat_rate: 0.12, reverse_charge_rate: 0.12 },
      { vat_rate: 0.25, reverse_charge_rate: 0.25 },
      { vat_rate: 0.25 },
    ])
    expect(rateFor(row(0.12))).toBe(0.12)
    expect(rateFor(row(0.25))).toBe(0.25)
  })

  it('gives none where the rows on screen carry none for that sats: the editor then shows its 25 %', () => {
    expect(reverseChargeRateCarriedFrom([{ vat_rate: 0.25 }])(row(0.25))).toBeUndefined()
    expect(reverseChargeRateCarriedFrom([{ vat_rate: 0.12, reverse_charge_rate: 0.12 }])(row(0.25))).toBeUndefined()
    expect(reverseChargeRateCarriedFrom([])(row(0.25))).toBeUndefined()
  })
})
