import { describe, it, expect } from 'vitest'
import type { Payload } from '@/lib/documents/extract/fields'
import { documentDate, documentTitle, fileStem } from '../title'
import { underlagPayload } from '../title'

const field = (value: string | number): Payload[string] => ({ value, normalized: value, page: 1, quote: null, bbox: null, confidence: 1, method: 'consensus', readings: [] })
const payload = (fields: Record<string, string | number>): Payload => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, field(v)]))

describe('documentTitle', () => {
  it('names a photo by what it is rather than by its file', () => {
    expect(documentTitle({ docType: 'supplier_invoice', fileName: 'IMG_7485.jpg', payload: payload({ supplier_name: 'Rollup-Kungen', invoice_number: '215066768' }) })).toBe('Faktura Rollup-Kungen 215066768')
    expect(documentTitle({ docType: 'receipt', fileName: 'IMG_7481.jpg', payload: payload({ merchant_name: 'Balzac' }) })).toBe('Kvitto Balzac')
    expect(documentTitle({ docType: 'decision.skatteverket', fileName: 'IMG_7483.jpg', payload: payload({ decision_type: 'registerutdrag' }) })).toBe('Registerutdrag från Skatteverket')
    expect(documentTitle({ docType: 'registration.bolagsverket', fileName: 'Registreringsbevis_559538-6219.pdf', payload: payload({ company_name: 'Arcim Technology AB' }) })).toBe('Registreringsbevis Arcim Technology AB')
    expect(documentTitle({ docType: 'filing.bolagsverket', fileName: 'Anmälan.pdf', payload: payload({ filing_type: 'ändringsanmälan (ny styrelseledamot)' }) })).toBe('Ändringsanmälan till Bolagsverket')
    expect(documentTitle({ docType: 'minutes.agm', fileName: 'x.pdf', payload: payload({ meeting_kind: 'extra', meeting_date: '2026-05-22' }) })).toBe('Extra bolagsstämma 2026-05-22')
    expect(documentTitle({ docType: 'annual_report', fileName: 'ar.pdf', payload: payload({ fiscal_year_end: '2025-12-31' }) })).toBe('Årsredovisning 2025')
  })

  it('prefers the agreement title, falls back to the kind and then to the file name', () => {
    expect(documentTitle({ docType: 'agreement.loan', fileName: '500050956.pdf', payload: payload({ lender_name: 'Almi' }), agreementTitle: 'Lån 500050956' })).toBe('Lån 500050956')
    expect(documentTitle({ docType: 'agreement.loan', fileName: '500050956.pdf', payload: payload({ lender_name: 'Almi Stockholm AB' }) })).toBe('Låneavtal Almi Stockholm AB')
    expect(documentTitle({ docType: 'agreement.shareholder', fileName: 'sha.pdf', payload: {} })).toBe('Aktieägaravtal')
    expect(documentTitle({ docType: 'receipt', fileName: 'IMG_7480.jpg', payload: {} })).toBe('IMG_7480')
    expect(documentTitle({ docType: null, fileName: 'scan.pdf', payload: null })).toBe('scan')
    expect(fileStem('Avtal.final.PDF')).toBe('Avtal.final')
  })
})

describe('documentDate', () => {
  it('reads the date the document carries, by type, and nothing else', () => {
    expect(documentDate('supplier_invoice', payload({ invoice_date: '2026-04-10', due_date: '2026-04-24' }))).toBe('2026-04-10')
    expect(documentDate('minutes.board', payload({ meeting_date: '2026-05-22' }))).toBe('2026-05-22')
    expect(documentDate('agreement.loan', payload({ signed_on: '2025-01-15', disbursed_on: '2026-02-02' }))).toBe('2025-01-15')
    expect(documentDate('registration.bolagsverket', payload({ registration_date: '2025-07-17', issued_on: '2026-07-28' }))).toBe('2026-07-28')
    expect(documentDate('receipt', payload({ receipt_date: 'igår' }))).toBeNull()
    expect(documentDate('other', null)).toBeNull()
  })
})

describe('underlagPayload', () => {
  const read = { supplier: { name: ' Systembolaget ' }, invoice: { invoiceNumber: '4990', invoiceDate: '2026-09-11', currency: 'SEK' }, totals: { total: 2388.8 } }

  it('carries the inbox reading into the payload for a receipt: name, number, date, amount, currency', () => {
    const p = underlagPayload(read, 'receipt')
    expect(p.merchant_name?.normalized).toBe('Systembolaget')
    expect(p.supplier_name?.normalized).toBe('Systembolaget')
    expect(p.invoice_number?.normalized).toBe('4990')
    expect(p.receipt_date?.normalized).toBe('2026-09-11')
    expect(p.total_amount?.normalized).toBe(2388.8)
    expect(p.currency?.normalized).toBe('SEK')
    expect(documentTitle({ docType: 'receipt', fileName: 'IMG_7483.jpg', payload: p })).toBe('Kvitto Systembolaget')
  })

  it('lends only the counterparty and the date to a document that is not a receipt or an invoice, and everything to one not typed yet', () => {
    const minutes = underlagPayload(read, 'minutes.agm')
    expect(minutes.supplier_name?.normalized).toBe('Systembolaget')
    expect(minutes.total_amount).toBeUndefined()
    expect(minutes.currency).toBeUndefined()
    expect(minutes.invoice_number).toBeUndefined()
    expect(underlagPayload(read, null).total_amount?.normalized).toBe(2388.8)
    expect(underlagPayload(null, 'receipt')).toEqual({})
    expect(underlagPayload({ supplier: { name: '   ' } }, 'receipt')).toEqual({})
  })
})
