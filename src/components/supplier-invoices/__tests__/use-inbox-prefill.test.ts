import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { InvoiceExtractionResult } from '@/types'
import { roundOre } from '@/lib/money'
import { rowsStandAsPut } from '@/lib/supplier-invoices/reading-rows'
import { reverseChargeRateOf } from '@/lib/supplier-invoices/reverse-charge-rate'
import { totalFirstFill, rowNetFromInvoiceTotals } from '@/lib/supplier-invoices/total-first'
import { readingFormRows, readingRowsForNewTreatment, useInboxPrefill, type InboxItemData } from '../use-inbox-prefill'

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

type Apply = (item: InboxItemData) => boolean

/** The hook's applyInboxItem, handed out of one server render. */
function captureApply(
  onInvoiceTotal: (total: number) => void,
  more: Partial<Parameters<typeof useInboxPrefill>[0]> = {},
): Apply {
  const applies: Apply[] = []
  function Harness({ sink }: { sink: Apply[] }) {
    const { applyInboxItem } = useInboxPrefill({
      inboxItemId: null,
      suppliersLoaded: true,
      suppliers: [],
      setValue: vi.fn(),
      replace: vi.fn(),
      reset: vi.fn(),
      getValues: vi.fn(() => ({})) as never,
      toast: vi.fn() as never,
      t: ((key: string) => key) as never,
      onInvoiceTotal,
      ...more,
    })
    sink.push(applyInboxItem)
    return null
  }
  renderToStaticMarkup(createElement(Harness, { sink: applies }))
  if (!applies[0]) throw new Error('not rendered')
  return applies[0]
}

const item = (extracted: Partial<InvoiceExtractionResult>): InboxItemData => ({
  id: 'inbox-1',
  matched_supplier_id: null,
  document_id: 'doc-1',
  extracted_data: extracted as InvoiceExtractionResult,
})

describe('useInboxPrefill', () => {
  it('hands the billed total to Fakturabelopp, so an inbox arrival gets its öresavrundning (crm#1595)', () => {
    const onInvoiceTotal = vi.fn()
    const apply = captureApply(onInvoiceTotal)
    // The reading of the invoice in the report: 4 990 + 299,40 moms, billed 5 289 after rounding -0,40.
    apply(item({
      totals: { total: 5289, subtotal: 4990, vatAmount: 299.4, roundingAmount: -0.4 },
      lineItems: [{ description: 'E-bok', quantity: 1, unitPrice: 4990, lineTotal: 4990, vatRate: 6 }],
    } as unknown as Partial<InvoiceExtractionResult>))
    expect(onInvoiceTotal).toHaveBeenCalledWith(5289)
  })

  it('hands nothing on when the reading has no total', () => {
    const onInvoiceTotal = vi.fn()
    const apply = captureApply(onInvoiceTotal)
    apply(item({ totals: { total: null, subtotal: null, vatAmount: null } } as unknown as Partial<InvoiceExtractionResult>))
    expect(onInvoiceTotal).not.toHaveBeenCalled()
  })

  const invoice = { invoiceNumber: '1001', invoiceDate: '2026-10-31', dueDate: null, paymentReference: null, currency: 'SEK' }
  // The read lines of the reported invoice: 769,00 net, 961,25 with their moms.
  const readLines = [
    { description: 'Abonnemang', quantity: 1, unitPrice: 299, lineTotal: 299, vatRate: 25, accountSuggestion: null },
    { description: 'Surf', quantity: 1, unitPrice: 250, lineTotal: 250, vatRate: 25, accountSuggestion: null },
    { description: 'Samtal', quantity: 1, unitPrice: 220, lineTotal: 220, vatRate: 25, accountSuggestion: null },
  ]

  // The reported reading: a telecom invoice billing 1 136,00 with 227,20 moms,
  // whose read lines stop 174,75 kr short of it (769,00 + 192,25 = 961,25).
  // It opened as three rows, an empty Moms and "Diff +174,75 kr mot raderna".
  it('opens a reading whose lines fall short with the invoice totals on one row', () => {
    const onInvoiceTotal = vi.fn()
    const onInvoiceVat = vi.fn()
    const replace = vi.fn()
    const apply = captureApply(onInvoiceTotal, { onInvoiceVat, replace })
    apply(item({ invoice, totals: { total: 1136, subtotal: null, vatAmount: 227.2 }, lineItems: readLines }))

    expect(onInvoiceTotal).toHaveBeenCalledWith(1136)
    expect(onInvoiceVat).toHaveBeenCalledWith(227.2)
    expect(replace).toHaveBeenCalledTimes(1)
    const [rows, filledNet] = replace.mock.calls[0]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amount: 908.8, vat_rate: 0.25, account_number: '' })
    // The row is the total-first fill's: a later change of Fakturabelopp, Moms or the sats moves it.
    expect(filledNet).toBe(908.8)
    // Recomputed here in whole öre, not through the editor: net + moms is the
    // Fakturabelopp, and the moms is 25 % of the net.
    const [netOre, vatOre, totalOre] = [rows[0].amount, 227.2, 1136].map((kr) => Math.round(roundOre(kr) * 100))
    expect(netOre + vatOre).toBe(totalOre)
    expect(netOre * 25).toBe(vatOre * 100)
  })

  it('books the whole total on one row at 0 % for a company that is not momsregistrerad', () => {
    const replace = vi.fn()
    const apply = captureApply(vi.fn(), { replace, vatRegistered: false })
    apply(item({ invoice, totals: { total: 1136, subtotal: null, vatAmount: 227.2 }, lineItems: readLines }))
    const [rows, filledNet] = replace.mock.calls[0]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amount: 1136, vat_rate: 0 })
    expect(filledNet).toBe(1136)
  })

  it('keeps a row per read line when the reading has no total, and touches neither total field', () => {
    const onInvoiceTotal = vi.fn()
    const onInvoiceVat = vi.fn()
    const replace = vi.fn()
    const apply = captureApply(onInvoiceTotal, { onInvoiceVat, replace })
    apply(item({ invoice, totals: { total: null, subtotal: null, vatAmount: null }, lineItems: readLines }))
    const [rows, filledNet] = replace.mock.calls[0]
    expect(rows.map((row: { description: string; amount: number; vat_rate: number }) => [row.description, row.amount, row.vat_rate]))
      .toEqual([['Abonnemang', 299, 0.25], ['Surf', 250, 0.25], ['Samtal', 220, 0.25]])
    expect(filledNet).toBeNull()
    expect(onInvoiceTotal).not.toHaveBeenCalled()
    expect(onInvoiceVat).not.toHaveBeenCalled()
  })

  it('clears a Moms an earlier reading left when this one states a total and no moms', () => {
    const onInvoiceVat = vi.fn()
    const apply = captureApply(vi.fn(), { onInvoiceVat })
    apply(item({ invoice, totals: { total: 961.25, subtotal: null, vatAmount: null }, lineItems: readLines }))
    expect(onInvoiceVat).toHaveBeenCalledWith(null)
  })

  it('puts the plan account on the row, which carries the text of its largest read line', () => {
    const replace = vi.fn()
    const apply = captureApply(vi.fn(), { replace, prefillAccount: '5010' })
    apply(item({ invoice, totals: { total: 1136, subtotal: null, vatAmount: 227.2 }, lineItems: readLines }))
    expect(replace.mock.calls[0][0]).toEqual([
      expect.objectContaining({ account_number: '5010', description: 'Abonnemang', amount: 908.8, vat_rate: 0.25 }),
    ])
  })

  // Review round 1, finding 5: a row without a text is refused by the API
  // ("Item description is required").
  it('names a row whose read lines had no text after its account, by the company\'s own chart first', () => {
    const untexted = readLines.map((li) => ({ ...li, description: '' }))
    const reading = item({ invoice, totals: { total: 1136, subtotal: null, vatAmount: 227.2 }, lineItems: untexted })
    const replace = vi.fn()
    // 4011 is an account the company added: no reference chart knows it.
    captureApply(vi.fn(), { replace, prefillAccount: '4011', accounts: [{ account_number: '4011', account_name: 'Inköp reservdelar' }] })(reading)
    expect(replace.mock.calls[0][0][0]).toMatchObject({ account_number: '4011', description: 'Inköp reservdelar' })
    captureApply(vi.fn(), { replace, prefillAccount: '5010' })(reading)
    expect(replace.mock.calls[1][0][0]).toMatchObject({ account_number: '5010', description: 'Lokalkostnader' })
  })

  describe('a foreign seller that charged moms anyway (919,20 + 229,80 = 1 149,00)', () => {
    const charged = {
      invoice: { ...invoice, currency: 'EUR' },
      totals: { total: 1149, subtotal: null, vatAmount: 229.8 },
      lineItems: [{ description: 'Licens', quantity: 1, unitPrice: 919.2, lineTotal: 919.2, vatRate: 25, accountSuggestion: null }],
    }
    const foreign = [{ id: 's1', supplier_type: 'eu_business' }, { id: 's2', supplier_type: 'swedish_business' }] as never

    it('opens for reverse charge when the reading selects the foreign supplier: the lines\' net, never the fill\'s row', () => {
      // The supplier effect switches reverse charge on a render after the
      // reading: the rows are proposed for it already.
      const replace = vi.fn()
      const apply = captureApply(vi.fn(), { replace, suppliers: foreign })
      apply({ ...item(charged), matched_supplier_id: 's1' })
      const [rows, filledNet] = replace.mock.calls[0]
      expect(rows).toEqual([expect.objectContaining({ description: 'Licens', amount: 919.2 })])
      expect(filledNet).toBeNull()
    })

    it('opens as an ordinary invoice for a Swedish supplier: the row is the fill\'s', () => {
      const replace = vi.fn()
      const apply = captureApply(vi.fn(), { replace, suppliers: foreign })
      apply({ ...item(charged), matched_supplier_id: 's2' })
      const [rows, filledNet] = replace.mock.calls[0]
      expect(rows).toEqual([expect.objectContaining({ amount: 919.2, vat_rate: 0.25 })])
      expect(filledNet).toBe(919.2)
    })

    it('takes reverse charge as the form has it when the reading\'s supplier is the one already chosen', () => {
      // The person picked the foreign supplier, then switched reverse charge
      // off by hand: nothing switches it on again, so the reading is not
      // proposed for it.
      const replace = vi.fn()
      const formValues = { supplier_id: 's1', reverse_charge: false }
      const getValues = vi.fn((name?: keyof typeof formValues) => (name ? formValues[name] : formValues)) as never
      const apply = captureApply(vi.fn(), { replace, suppliers: foreign, getValues })
      apply({ ...item(charged), matched_supplier_id: 's1' })
      expect(replace.mock.calls[0][1]).toBe(919.2)
    })

    // The other order: the reading first, the foreign supplier picked after
    // it. When reverse charge turns on, the hook's effect puts what
    // readingRowsForNewTreatment answers, and the form's fill asks
    // totalFirstFill. No test in this repo mounts a component, so the effect
    // itself is not run here: its two decisions are.
    describe('when the supplier is picked after the reading', () => {
      const reading = charged as unknown as InvoiceExtractionResult
      const options = { thresholdFor: undefined, chart: [] }
      const ordinary = readingFormRows(reading, { vatRegistered: true, reverseCharge: false }, false, { ...options, accountFor: () => '' })
      const reverseCharge = { vatRegistered: true, reverseCharge: true }

      it('first opens as an ordinary invoice, on a row that is the fill\'s', () => {
        expect(ordinary.rows).toEqual([expect.objectContaining({ amount: 919.2, vat_rate: 0.25 })])
        expect(ordinary.filledNet).toBe(919.2)
      })

      it('is proposed again for reverse charge while its rows stand as put: the lines\' net, not the fill\'s row', () => {
        // The supplier's default account has landed on the row meanwhile.
        const onScreen = ordinary.rows.map((row) => ({ ...row, account_number: '6540' }))
        const again = readingRowsForNewTreatment(reading, reverseCharge, ordinary, onScreen, { ...options, prefillAccount: null })
        expect(again?.rows).toEqual([expect.objectContaining({ description: 'Licens', amount: 919.2, account_number: '6540' })])
        expect(again?.filledNet).toBeNull()
      })

      it('is left as it stands once the person has changed a row, and the fill leaves it too: 919,20 never becomes 1 149,00', () => {
        const onScreen = ordinary.rows.map((row) => ({ ...row, description: 'Licens, november' }))
        expect(readingRowsForNewTreatment(reading, reverseCharge, ordinary, onScreen, { ...options, prefillAccount: null })).toBeNull()
        // The row is still the amount the fill was handed, and under reverse
        // charge the fill's net is the whole Fakturabelopp.
        const fillNet = rowNetFromInvoiceTotals({ total: 1149, vat: null, rate: 0.25, reverseCharge: true })
        expect(fillNet).toBe(1149)
        expect(totalFirstFill({ amount: 919.2, net: fillNet, filled: ordinary.filledNet, fromReading: true, reverseCharge: true })).toBeNull()
      })

      it('makes up no lost line from the totals under reverse charge: the rows are the lines\' sums in either order', () => {
        // Read as an ordinary invoice the lost line came from the totals
        // (908,80); for reverse charge it is the lines' 769,00, as a row per line showed.
        const lost = { invoice, totals: { total: 1136, subtotal: null, vatAmount: 227.2 }, lineItems: readLines } as unknown as InvoiceExtractionResult
        const first = readingFormRows(lost, { vatRegistered: true, reverseCharge: false }, false, { ...options, accountFor: () => '' })
        expect(first.rows[0].amount).toBe(908.8)
        const after = readingRowsForNewTreatment(lost, reverseCharge, first, first.rows, { ...options, prefillAccount: null })
        const known = readingFormRows(lost, reverseCharge, false, { ...options, accountFor: () => '' })
        expect(after?.rows.map((row) => row.amount)).toEqual([769])
        expect(after?.rows).toEqual(known.rows)
      })

      // The browser proof of 2026-11-18 showed the test above was fed rows the
      // real form never holds at that moment: by the time reverse charge is on,
      // the editor has given each row on screen its default reverse-charge
      // sats (reverseChargeRateOf, the form's own doing). The rows then stayed
      // 908,80 for a momsregistrerad company, with the supplier picked after
      // the reading and with the switch under Förval alike.
      describe('with the rows as the form holds them once reverse charge is on', () => {
        const lost = { invoice, totals: { total: 1136, subtotal: null, vatAmount: 227.2 }, lineItems: readLines } as unknown as InvoiceExtractionResult
        const first = readingFormRows(lost, { vatRegistered: true, reverseCharge: false }, false, { ...options, accountFor: () => '' })
        /** What the editor does to the rows on screen when reverse charge is switched on. */
        const withTheEditorsSats = (rows: typeof first.rows) => rows.map((row) => ({ ...row, reverse_charge_rate: reverseChargeRateOf(row) }))
        const nameOf = () => ''

        it('gives the reported reading the same rows in either order: 769,00, the lines\' net', () => {
          expect(first.rows.map((row) => row.amount)).toEqual([908.8])
          const after = readingRowsForNewTreatment(lost, reverseCharge, first, withTheEditorsSats(first.rows), { ...options, prefillAccount: null })
          // The supplier known first: put for reverse charge, with the sats the editor leaves as it is.
          const known = readingFormRows(lost, reverseCharge, false, { ...options, accountFor: () => '' })
          expect(withTheEditorsSats(known.rows)).toEqual(known.rows)
          expect(after?.rows.map((row) => row.amount)).toEqual([769])
          expect(after?.rows).toEqual(known.rows)
          expect(after?.filledNet).toBeNull()
        })

        it('offers the split under reverse charge in either order, until the person edits a row', () => {
          const known = readingFormRows(lost, reverseCharge, false, { ...options, accountFor: () => '' })
          expect(known.lineCount).toBe(3)
          const onScreen = withTheEditorsSats(known.rows)
          expect(rowsStandAsPut(onScreen, known.rows, nameOf)).toBe(true)
          const after = readingRowsForNewTreatment(lost, reverseCharge, first, withTheEditorsSats(first.rows), { ...options, prefillAccount: null })
          expect(after && rowsStandAsPut(after.rows, after.rows, nameOf)).toBe(true)
          expect(rowsStandAsPut(onScreen.map((row) => ({ ...row, amount: 800 })), known.rows, nameOf)).toBe(false)
        })

        it('goes back to the ordinary row when reverse charge is switched off again', () => {
          const on = readingRowsForNewTreatment(lost, reverseCharge, first, withTheEditorsSats(first.rows), { ...options, prefillAccount: null })
          if (!on) throw new Error('not proposed for reverse charge')
          const off = readingRowsForNewTreatment(lost, { vatRegistered: true, reverseCharge: false }, on, on.rows, { ...options, prefillAccount: null })
          expect(off?.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[908.8, 0.25]])
          expect(off?.filledNet).toBe(908.8)
          // No reverse-charge sats travels onto an ordinary invoice's rows.
          expect(off?.rows[0]).not.toHaveProperty('reverse_charge_rate')
        })

        it('keeps a reduced Swedish sats: a 12 % line self-assesses at 12 % in either order', () => {
          const reduced = {
            invoice,
            totals: { total: 1120, subtotal: null, vatAmount: 120 },
            lineItems: [{ description: 'Livsmedel', quantity: 1, unitPrice: 900, lineTotal: 900, vatRate: 12, accountSuggestion: null }],
          } as unknown as InvoiceExtractionResult
          const opened = readingFormRows(reduced, { vatRegistered: true, reverseCharge: false }, false, { ...options, accountFor: () => '' })
          expect(opened.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[1000, 0.12]])
          const after = readingRowsForNewTreatment(reduced, reverseCharge, opened, withTheEditorsSats(opened.rows), { ...options, prefillAccount: null })
          const known = readingFormRows(reduced, reverseCharge, false, { ...options, accountFor: () => '' })
          expect(after?.rows).toEqual(known.rows)
          expect(after?.rows.map((row) => [row.amount, row.reverse_charge_rate])).toEqual([[900, 0.12]])
        })

        // Issue #227: a line read at 0 % (or at a rate that is not Swedish)
        // got a reverse-charge sats of 0 once reverse charge came on after
        // the rows, which the sats select cannot show and the API refuses.
        it('gives a line read at 0 % or at a foreign rate 25 % in either order, never 0', () => {
          for (const vatRate of [0, 20]) {
            const unrated = {
              invoice,
              totals: { total: 900, subtotal: 900, vatAmount: 0 },
              lineItems: [{ description: 'Hosting', quantity: 1, unitPrice: 900, lineTotal: 900, vatRate, accountSuggestion: null }],
            } as unknown as InvoiceExtractionResult
            const opened = readingFormRows(unrated, { vatRegistered: true, reverseCharge: false }, false, { ...options, accountFor: () => '' })
            expect(opened.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[900, 0]])
            const onScreen = withTheEditorsSats(opened.rows)
            expect(onScreen.map((row) => row.reverse_charge_rate)).toEqual([0.25])
            // Still the reading's rows: what the editor gave them is no edit.
            expect(rowsStandAsPut(onScreen, opened.rows, nameOf)).toBe(true)
            const after = readingRowsForNewTreatment(unrated, reverseCharge, opened, onScreen, { ...options, prefillAccount: null })
            const known = readingFormRows(unrated, reverseCharge, false, { ...options, accountFor: () => '' })
            expect(known.rows.map((row) => [row.amount, row.reverse_charge_rate])).toEqual([[900, 0.25]])
            expect(after?.rows).toEqual(known.rows)
          }
        })

        it('gives the rows their default again when reverse charge is switched off and on by hand', () => {
          const reduced = {
            invoice,
            totals: { total: 1500, subtotal: null, vatAmount: null },
            lineItems: [
              { description: 'Livsmedel', quantity: 1, unitPrice: 900, lineTotal: 900, vatRate: 12, accountSuggestion: null },
              { description: 'Frakt', quantity: 1, unitPrice: 600, lineTotal: 600, vatRate: 0, accountSuggestion: null },
            ],
          } as unknown as InvoiceExtractionResult
          const known = readingFormRows(reduced, reverseCharge, false, { ...options, accountFor: () => '' })
          const off = readingRowsForNewTreatment(reduced, { vatRegistered: true, reverseCharge: false }, known, known.rows, { ...options, prefillAccount: null })
          if (!off) throw new Error('not proposed for an ordinary invoice')
          const on = readingRowsForNewTreatment(reduced, reverseCharge, off, withTheEditorsSats(off.rows), { ...options, prefillAccount: null })
          expect(on?.rows.map((row) => [row.vat_rate, row.reverse_charge_rate])).toEqual([[0.12, 0.12], [0, 0.25]])
          expect(on?.rows).toEqual(known.rows)
        })

        it('proposes the rows again for a company that is not momsregistrerad after the editor has booked their moms as cost', () => {
          // Lines read without a sats under a total of 1 000,00 (review round 2, N1).
          const unrated = {
            invoice,
            totals: { total: 1000, subtotal: null, vatAmount: 0 },
            lineItems: [
              { description: 'Konsulttimmar', quantity: 1, unitPrice: 700, lineTotal: 700, vatRate: null, accountSuggestion: null },
              { description: 'Licens', quantity: 1, unitPrice: 300, lineTotal: 300, vatRate: null, accountSuggestion: null },
            ],
          } as unknown as InvoiceExtractionResult
          const ordinary = { vatRegistered: false, reverseCharge: false }
          const reverse = { vatRegistered: false, reverseCharge: true }
          const opened = readingFormRows(unrated, ordinary, false, { ...options, accountFor: () => '' })
          expect(opened.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[1000, 0]])
          const on = readingRowsForNewTreatment(unrated, reverse, opened, opened.rows, { ...options, prefillAccount: null })
          if (!on) throw new Error('not proposed for reverse charge')
          expect(on.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[1000, 0.25]])
          // The editor's zeroing then shows 1 250,00 at 0 %, as on main.
          const zeroed = on.rows.map((row) => ({ ...row, amount: roundOre(row.amount * 1.25), vat_rate: 0 }))
          expect(zeroed.map((row) => row.amount)).toEqual([1250])
          // Still the reading's rows: the split is offered, and switching back proposes the ordinary row.
          expect(rowsStandAsPut(zeroed, on.rows, nameOf, false)).toBe(true)
          const off = readingRowsForNewTreatment(unrated, ordinary, on, zeroed, { ...options, prefillAccount: null })
          expect(off?.rows.map((row) => [row.amount, row.vat_rate])).toEqual([[1000, 0]])
        })
      })
    })
  })

  // Review round 1, finding 4: "Dela upp" and "Slå ihop" replayed the reading
  // over what the person had changed. The link is offered only while the
  // rows on screen are what the reading (or the last toggle) put there.
  describe('the rows the reading put, against the rows on screen', () => {
    const reading = {
      invoice: { ...invoice, servicePeriodStart: '2026-11-01', servicePeriodEnd: '2027-10-31' },
      totals: { total: 7500, subtotal: 6000, vatAmount: 1500 },
      lineItems: [
        { description: 'Licens', quantity: 1, unitPrice: 3600, lineTotal: 3600, vatRate: 25, accountSuggestion: null },
        { description: 'Support', quantity: 1, unitPrice: 2400, lineTotal: 2400, vatRate: 25, accountSuggestion: null },
      ],
      vatBreakdown: [],
    } as unknown as InvoiceExtractionResult
    const treatment = { vatRegistered: true, reverseCharge: false }
    const nameOf = (account: string) => (account === '6540' ? 'IT-tjänster' : '')
    const put = (split: boolean, accountFor: () => string = () => '') =>
      readingFormRows(reading, treatment, split, { thresholdFor: () => 5000, accountFor, chart: [] })

    it('opens combined with periodisering on the summed row, and offers the two lines', () => {
      const combined = put(false)
      expect(combined.rows).toEqual([
        expect.objectContaining({ description: 'Licens', amount: 6000, accrual_period_start: '2026-11-01', accrual_period_end: '2027-10-31' }),
      ])
      expect(combined).toMatchObject({ split: false, lineCount: 2, filledNet: 6000 })
      const split = put(true)
      expect(split.rows.map((row) => [row.description, row.amount])).toEqual([['Licens', 3600], ['Support', 2400]])
      expect(split).toMatchObject({ split: true, lineCount: 2, filledNet: null })
    })

    it('still stands as put after the supplier\'s default account has landed on the rows', () => {
      // The account is the form's doing, not the person's, and a swap carries it.
      const split = put(true).rows
      expect(rowsStandAsPut(split.map((row) => ({ ...row, account_number: '6540' })), split, nameOf)).toBe(true)
    })

    it.each([
      ['an amount corrected from 2 400 to 2 450', { amount: 2450 }],
      ['a periodisering set on a row', { accrual_period_start: '2026-11-01', accrual_period_end: '2026-12-31', accrual_balance_account: '1790' }],
      ['a dimension', { dimensions: { '1': 'STHLM' } }],
      ['a text', { description: 'Support, årsavtal' }],
    ])('no longer stands as put with %s, so the link is gone and nothing is replayed over it', (_what, change) => {
      const split = put(true).rows
      const onScreen = split.map((row, index) => (index === 1 ? { ...row, ...change } : row))
      expect(rowsStandAsPut(onScreen, split, nameOf)).toBe(false)
    })

    it('proposes no periodisering under reverse charge, where the editor clears it', () => {
      const reverse = readingFormRows(reading, { vatRegistered: true, reverseCharge: true }, false, { thresholdFor: () => 5000, accountFor: () => '', chart: [] })
      expect(reverse.rows[0].accrual_period_start).toBeUndefined()
      expect(reverse.filledNet).toBeNull()
    })
  })

  describe('periodisering from a stated service period', () => {
    const year = { ...invoice, servicePeriodStart: '2026-11-01', servicePeriodEnd: '2027-10-31' }
    const lines = [
      { description: 'Licens', quantity: 1, unitPrice: 3000, lineTotal: 3000, vatRate: 25, accountSuggestion: null },
      { description: 'Support', quantity: 1, unitPrice: 3000, lineTotal: 3000, vatRate: 25, accountSuggestion: null },
    ]

    it('opens on the row the lines are summed into, by the limit the lines were held to', () => {
      const replace = vi.fn()
      const apply = captureApply(vi.fn(), { replace, accrualThresholdFor: () => 7000 })
      // 6 000 kr on one row is under the 7 000 kr limit: nothing opens.
      apply(item({ invoice: year, totals: { total: 7500, subtotal: 6000, vatAmount: 1500 }, lineItems: lines }))
      expect(replace.mock.calls[0][0]).toEqual([expect.objectContaining({ amount: 6000, accrual_period_start: undefined })])

      // At the 5 000 kr limit the row is over it, though neither line was.
      const older = captureApply(vi.fn(), { replace, accrualThresholdFor: () => 5000 })
      older(item({ invoice: year, totals: { total: 7500, subtotal: 6000, vatAmount: 1500 }, lineItems: lines }))
      expect(replace.mock.calls[1][0]).toEqual([
        expect.objectContaining({
          amount: 6000,
          accrual_period_start: '2026-11-01',
          accrual_period_end: '2027-10-31',
          accrual_balance_account: '1790',
        }),
      ])
    })

    it('never lets a date that is not ISO reach the form', () => {
      const replace = vi.fn()
      const apply = captureApply(vi.fn(), { replace, accrualThresholdFor: () => 5000 })
      apply(item({
        invoice: { ...year, servicePeriodStart: '1 nov 2026' },
        totals: { total: 7500, subtotal: 6000, vatAmount: 1500 },
        lineItems: lines,
      }))
      expect(replace.mock.calls[0][0][0].accrual_period_start).toBeUndefined()
      expect(replace.mock.calls[0][0][0].accrual_period_end).toBeUndefined()
    })
  })
})
