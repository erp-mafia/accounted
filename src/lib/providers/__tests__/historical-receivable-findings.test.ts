import { describe, expect, it } from 'vitest'
import type { SalesInvoiceDto } from '../dto'
import { findHistoricalReceivableCandidates, parseHistoricalPaymentDescription, type HistoricalInvoiceSource, type HistoricalPaymentEntry } from '../historical-receivable-findings'
const entry: HistoricalPaymentEntry = { id: 'payment', date: '2022-11-07', description: 'Faktura #216 betalad av Example AB',
  series: 'V', number: 93, receivableCredit: 180000, bankDebit: 180000 }
const source: HistoricalInvoiceSource = { chunkId: 'chunk', sourceId: 'source', payloadHash: 'hash', imported: false, reviewable: true,
  invoice: { invoiceNumber: '216', issueDate: '2022-09-30', status: 'paid', currencyCode: 'SEK', lines: [],
    customer: { name: 'Example AB' }, legalMonetaryTotal: { payableAmount: { value: 180000 } },
    paymentStatus: { paid: true, balance: { value: 0 } }, _raw: {} } as unknown as SalesInvoiceDto }
const find = (e = entry, sources = [source], existing = new Set<string>()) => findHistoricalReceivableCandidates([e], sources, existing)
describe('historical receivable discovery', () => {
  it('proposes the exact paid, line-less source without modifying it', () => {
    const before = JSON.stringify(source)
    expect(find()[0]).toMatchObject({ invoiceNumber: '216', chunkId: 'chunk', paymentEntryId: 'payment', origin: 'incomplete_invoice' })
    expect(JSON.stringify(source)).toBe(before)
  })
  it('also proposes a ledger-only reference without inventing an invoice date', () => {
    expect(find(entry, [])[0]).toMatchObject({ origin: 'voucher_only', invoiceDate: null, sourceId: null })
    expect(find({ ...entry, description: 'Kundbet Example AB (215)' }, [])[0].invoiceNumber).toBe('215')
  })
  it.each(['Levfakt Example AB (216)', 'Levbet Example AB (216)', 'Makulering: Faktura #216 betalad av Example AB',
    'Faktura #216 betalad av Wrong AB'])('does not conflate descriptions: %s', description => {
    expect(find({ ...entry, description })).toEqual([])
  })
  it.each([{ receivableCredit: -180000 }, { bankDebit: -180000 }, { bankDebit: 179999 }, { receivableCredit: NaN }])('rejects non-payment or mismatched ledger directions: %j', patch => {
    expect(find({ ...entry, ...patch })).toEqual([])
  })
  it('never downgrades an already imported or complete invoice', () => {
    expect(find(entry, [{ ...source, imported: true }])).toEqual([])
    expect(find(entry, [{ ...source, reviewable: false }])).toEqual([])
    expect(find(entry, [{ ...source, invoice: { ...source.invoice, lines: [{}] } as unknown as SalesInvoiceDto }])).toEqual([])
    expect(find(entry, [source], new Set(['216']))).toEqual([])
  })
  it.each([{ status: 'draft' }, { currencyCode: 'EUR' }, { invoiceTypeCode: '381' }, { issueDate: '2023-01-01' },
    { _raw: { journalEntryRef: { id: 'registration' } } }])('leaves unsupported source states for review: %j', patch => {
    expect(find(entry, [{ ...source, invoice: { ...source.invoice, ...patch } as unknown as SalesInvoiceDto }])).toEqual([])
  })
  it('refuses duplicate source numbers instead of choosing one', () => {
    expect(find(entry, [source, { ...source, sourceId: 'other' }])).toEqual([])
  })
  it('requires a full invoice token and a customer, not an arbitrary number search', () => {
    expect(parseHistoricalPaymentDescription('invoice entry 216')).toBeNull()
    expect(parseHistoricalPaymentDescription('Faktura #216 betald av Example AB')).toEqual({ number: '216', customer: 'Example AB' })
  })
})

it('never attaches a similar invoice number to the incomplete source', () => {
  expect(find({ ...entry, description: 'Faktura #2160 betalad av Example AB' })[0]).toMatchObject({ invoiceNumber: '2160', sourceId: null, origin: 'voucher_only' })
})

it('does not claim a source match from non-finite totals or invalid dates', () => {
  expect(find(entry, [{ ...source, invoice: { ...source.invoice, issueDate: '' } }])).toEqual([])
  expect(find(entry, [{ ...source, invoice: { ...source.invoice, paymentStatus: { ...source.invoice.paymentStatus, balance: { value: NaN, currencyCode: 'SEK' } } } }])).toEqual([])
  expect(find({ ...entry, date: '' })).toEqual([])
})
