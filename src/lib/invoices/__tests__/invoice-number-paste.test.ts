import { describe, it, expect } from 'vitest'
import { generateOcrReference } from '@/lib/bankgiro/luhn'
import {
  MAX_PASTED_REFERENCES,
  closedLookupNumbers,
  parseInvoicePaste,
  planInvoicePaste,
  resolvePastedReferences,
  type PasteInvoice,
} from '../invoice-number-paste'

const texts = (text: string) => parseInvoicePaste(text).references.map((r) => r.text)

const inv = (id: string, number: string | null, extra: Partial<PasteInvoice> = {}): PasteInvoice => ({
  id,
  number,
  state: 'open',
  currency: 'SEK',
  remaining: 1000,
  ...extra,
})

const plan = (text: string, invoices: PasteInvoice[], kind: 'customer' | 'supplier' = 'customer', currency = 'SEK') =>
  planInvoicePaste(parseInvoicePaste(text), invoices, { kind, currency })

describe('parseInvoicePaste', () => {
  it('reads one number per line, trimming whitespace and skipping blank lines', () => {
    expect(texts('1001\r\n  1002  \n\n\t\n1003\r1004')).toEqual(['1001', '1002', '1003', '1004'])
  })

  it('reads numbers separated by commas, spaces, tabs and semicolons, mixed on one paste', () => {
    expect(texts('1001, 1002 1003\n1004\t1005\t1006\n1007;1008;1009\n1010,1011')).toEqual([
      '1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008', '1009', '1010', '1011',
    ])
  })

  it('reads a second spreadsheet column as the amount paid', () => {
    const parsed = parseInvoicePaste('1042\t1 250,00\n1043;980\n1044\t2 500,50 kr\n1045\t1250.75')
    expect(parsed.references).toEqual([
      { text: '1042', amount: 1250 },
      { text: '1043', amount: 980 },
      { text: '1044', amount: 2500.5 },
      { text: '1045', amount: 1250.75 },
    ])
  })

  it('returns a line whose amount is zero or negative as unreadable instead of guessing', () => {
    const parsed = parseInvoicePaste('1042\t0\n1043\t-500\n1044\t100')
    expect(parsed.references).toEqual([{ text: '1044', amount: 100 }])
    expect(parsed.unreadable).toEqual(['1042\t0', '1043\t-500'])
  })

  it('returns cells without a digit (a header, a word) as unreadable, never drops them', () => {
    const parsed = parseInvoicePaste('Fakturanummer\tBelopp\nFaktura 1001\n1002')
    expect(parsed.references.map((r) => r.text)).toEqual(['1001', '1002'])
    expect(parsed.unreadable).toEqual(['Fakturanummer', 'Belopp', 'Faktura'])
  })

  it('collapses a number pasted twice, whatever its case or spacing, and counts the repeats', () => {
    const parsed = parseInvoicePaste('1001\n1001\n 1001 \nF-7\nf-7')
    expect(parsed.references.map((r) => r.text)).toEqual(['1001', 'F-7'])
    expect(parsed.duplicates).toBe(3)
  })

  it('keeps leading zeros as pasted: the resolution decides what they name', () => {
    expect(texts('000123\n0456')).toEqual(['000123', '0456'])
  })

  it('reports a number pasted twice with different amounts as conflicting and picks neither amount', () => {
    const parsed = parseInvoicePaste('1001\t500\n1001\t600\n1002\t100\n1002\t100')
    expect(parsed.references).toEqual([{ text: '1002', amount: 100 }])
    expect(parsed.conflicting).toEqual(['1001'])
    expect(parsed.duplicates).toBe(1)
  })

  it('strips quotes a CSV export puts around a cell', () => {
    expect(texts('"1001"\n\'1002\'')).toEqual(['1001', '1002'])
  })

  it('stops at MAX_PASTED_REFERENCES and says so', () => {
    const many = Array.from({ length: MAX_PASTED_REFERENCES + 10 }, (_, i) => String(100000 + i)).join('\n')
    const parsed = parseInvoicePaste(many)
    expect(parsed.references).toHaveLength(MAX_PASTED_REFERENCES)
    expect(parsed.truncated).toBe(true)
  })
})

describe('resolvePastedReferences', () => {
  it('names a customer invoice by its number, its digits, its OCR or its number without leading zeros', () => {
    const invoices = [inv('a', '1001'), inv('b', '2026-0042'), inv('c', '000123'), inv('d', '456')]
    const refs = parseInvoicePaste(
      ['1001', '20260042', generateOcrReference('1001'), '123', '0456', '9999'].join('\n'),
    ).references
    const resolved = resolvePastedReferences(refs, invoices, 'customer')
    expect(resolved.map((r) => (r.kind === 'one' ? r.invoice.id : r.kind))).toEqual(['a', 'b', 'a', 'c', 'd', 'none'])
  })

  it('reads a pasted number as that invoice before reading it as the OCR of a shorter one', () => {
    // generateOcrReference('316') is 316 plus its check digit: a pasted number
    // equal to it names the invoice with that number when one exists, paid or
    // not, and never falls through to invoice 316.
    const ocr = generateOcrReference('316')
    const open316 = inv('open-316', '316')
    const paid = inv('paid', ocr, { state: 'paid' })
    expect(resolvePastedReferences(parseInvoicePaste(ocr).references, [open316, paid], 'customer')).toEqual([
      { kind: 'one', invoice: paid },
    ])
    expect(resolvePastedReferences(parseInvoicePaste(ocr).references, [open316], 'customer')).toEqual([
      { kind: 'one', invoice: open316 },
    ])
  })

  it('reports a supplier invoice number two suppliers share as ambiguous, never picks one', () => {
    const invoices = [inv('s1', 'A-100'), inv('s2', 'A-100'), inv('s3', 'B-7', { paymentReference: '55512340' })]
    const resolved = resolvePastedReferences(parseInvoicePaste('A-100\n55512340').references, invoices, 'supplier')
    expect(resolved).toEqual([
      { kind: 'ambiguous', count: 2 },
      { kind: 'one', invoice: invoices[2] },
    ])
  })

  it('does not derive an OCR from a supplier invoice number: the supplier prints its own', () => {
    const invoices = [inv('s1', '1001')]
    const resolved = resolvePastedReferences(parseInvoicePaste(generateOcrReference('1001')).references, invoices, 'supplier')
    expect(resolved).toEqual([{ kind: 'none' }])
  })
})

describe('closedLookupNumbers', () => {
  it('asks for the number as pasted, its digits, and the number an OCR was built from', () => {
    const refs = parseInvoicePaste(`2026-0042\n${generateOcrReference('1001')}`).references
    expect(closedLookupNumbers(refs, 'customer')).toEqual(
      expect.arrayContaining(['2026-0042', '20260042', generateOcrReference('1001'), '1001']),
    )
  })

  it('only sends plain characters into the filter', () => {
    const refs = parseInvoicePaste('10(01)').references
    expect(closedLookupNumbers(refs, 'customer')).toEqual(['1001'])
  })

  it('derives no OCR base for supplier invoices', () => {
    const refs = parseInvoicePaste(generateOcrReference('1001')).references
    expect(closedLookupNumbers(refs, 'supplier')).toEqual([generateOcrReference('1001')])
  })
})

describe('planInvoicePaste', () => {
  it('picks every open invoice named, at what it owes, and sums the picks', () => {
    const result = plan('1001\n1002', [inv('a', '1001', { remaining: 1500 }), inv('b', '1002', { remaining: 249.5 })])
    expect(result.picks.map((p) => [p.invoice.id, p.amount])).toEqual([
      ['a', 1500],
      ['b', 249.5],
    ])
    expect(result.pickedTotal).toBe(1749.5)
    expect(result.skipped).toEqual([])
  })

  it('picks at the pasted amount, a part payment included', () => {
    const result = plan('1001\t400', [inv('a', '1001', { remaining: 1000 })])
    expect(result.picks.map((p) => p.amount)).toEqual([400])
  })

  it('refuses a pasted amount a krona or more above what the invoice owes, as the batch RPC would', () => {
    const invoices = [inv('a', '1001', { remaining: 1000 }), inv('b', '1002', { remaining: 1000 })]
    const result = plan('1001\t1001\n1002\t1000,50', invoices)
    expect(result.picks.map((p) => [p.invoice.id, p.amount])).toEqual([['b', 1000.5]])
    expect(result.skipped).toEqual([{ text: '1001', reason: 'amount_above_remaining', invoiceNumber: '1001' }])
  })

  it('lists every number it does not pick, and why, in paste order', () => {
    const invoices = [
      inv('open', '1001'),
      inv('paid', '1002', { state: 'paid' }),
      inv('draft', '1003', { state: 'not_open' }),
      inv('eur', '1004', { currency: 'EUR' }),
    ]
    const result = plan(`1001\n1002\n1003\n1004\n1005\n${generateOcrReference('1001')}\nBelopp\n1006\t5\n1006\t6`, invoices)
    expect(result.picks.map((p) => p.invoice.id)).toEqual(['open'])
    expect(result.skipped).toEqual([
      { text: '1002', reason: 'already_paid', invoiceNumber: '1002' },
      { text: '1003', reason: 'not_open', invoiceNumber: '1003' },
      { text: '1004', reason: 'other_currency', invoiceNumber: '1004' },
      { text: '1005', reason: 'not_found' },
      { text: generateOcrReference('1001'), reason: 'same_invoice', invoiceNumber: '1001', earlier: '1001' },
      { text: '1006', reason: 'conflicting_amounts' },
      { text: 'Belopp', reason: 'unreadable' },
    ])
    expect(result.counts).toEqual({
      not_found: 1,
      already_paid: 1,
      not_open: 1,
      ambiguous: 0,
      other_currency: 1,
      amount_above_remaining: 0,
      same_invoice: 1,
      conflicting_amounts: 1,
      unreadable: 1,
    })
  })

  it('compares currencies case-insensitively and reads a missing one as kronor', () => {
    const result = plan('1001\n1002', [inv('a', '1001', { currency: 'sek' }), inv('b', '1002', { currency: null })])
    expect(result.picks.map((p) => p.invoice.id)).toEqual(['a', 'b'])
  })

  it('resolves 2 000 pasted numbers against 3 000 invoices without a quadratic scan', () => {
    const invoices = Array.from({ length: 3000 }, (_, i) =>
      inv(`id-${i}`, String(20000 + i), { remaining: 100 + (i % 7) }),
    )
    // Every other number pasted as its OCR, a few that do not exist.
    const lines = Array.from({ length: 2000 }, (_, i) =>
      i % 2 === 0 ? String(20000 + i) : generateOcrReference(String(20000 + i)),
    )
    lines.push('99999999', '88888888')
    const started = performance.now()
    const result = plan(lines.join('\n'), invoices)
    const elapsed = performance.now() - started
    expect(result.picks).toHaveLength(2000)
    expect(result.counts.not_found).toBe(2)
    // Generous for a loaded CI runner; the quadratic version took seconds.
    expect(elapsed).toBeLessThan(2000)
  })
})
