import { describe, expect, it } from 'vitest'
import { invoicePdfFilename, paymentConfirmationPdfFilename } from '../pdf-filename'

describe('invoicePdfFilename', () => {
  it('includes company, customer, document type, number, and invoice date', () => {
    expect(invoicePdfFilename({
      companyName: 'Oppy',
      customerName: 'Kund AB',
      invoiceNumber: '2621',
      invoiceDate: '2026-07-21',
    })).toBe('Oppy x Kund AB Faktura nr 2621 20260721.pdf')
  })

  it('uses the correct label for credit notes and other document types', () => {
    const base = {
      companyName: 'Oppy',
      customerName: 'Kund AB',
      invoiceNumber: '42',
      invoiceDate: '2026-07-21',
    }

    expect(invoicePdfFilename({ ...base, isCreditNote: true }))
      .toContain('Kreditfaktura nr 42')
    expect(invoicePdfFilename({ ...base, documentType: 'proforma' }))
      .toContain('Proformafaktura nr 42')
    expect(invoicePdfFilename({ ...base, documentType: 'delivery_note' }))
      .toContain('Följesedel nr 42')
  })

  it('keeps drafts identifiable without inventing an invoice number', () => {
    expect(invoicePdfFilename({
      companyName: 'Oppy',
      customerName: 'Kund AB',
      invoiceId: 'bbbbbbbb-1111-2222-3333-cccccccccccc',
      invoiceDate: '2026-07-21',
    })).toBe('Oppy x Kund AB Faktura utkast-bbbbbbbb 20260721.pdf')
  })

  it('removes characters that are unsafe in cross-platform filenames', () => {
    expect(invoicePdfFilename({
      companyName: 'Oppy / Sverige',
      customerName: 'Kund: "Nord" * AB',
      invoiceNumber: '../26/21',
      invoiceDate: '2026-07-21',
    })).toBe('Oppy Sverige x Kund Nord AB Faktura nr .. 26 21 20260721.pdf')
  })

  it('falls back when company and customer names are empty', () => {
    expect(invoicePdfFilename({
      companyName: ' ',
      customerName: null,
      invoiceNumber: '2621',
      invoiceDate: '2026-07-21',
    })).toBe('Företag x Kund Faktura nr 2621 20260721.pdf')
  })

  it('keeps multibyte filenames within common filesystem byte limits', () => {
    const filename = invoicePdfFilename({
      companyName: '🚀'.repeat(60),
      customerName: '漢'.repeat(60),
      invoiceNumber: '2621',
      invoiceDate: '2026-07-21',
    })

    expect(Buffer.byteLength(filename, 'utf8')).toBeLessThanOrEqual(255)
    expect(filename).toMatch(/Faktura nr 2621 20260721\.pdf$/)
  })
})

// #1693: the paid copy is named as a betalningsbekräftelse, never as the
// invoice, so the file cannot be mistaken for the one that was sent.
describe('paymentConfirmationPdfFilename', () => {
  it('names the file after the invoice number', () => {
    expect(paymentConfirmationPdfFilename('2621')).toBe('Betalningsbekraftelse-2621.pdf')
  })

  it('sanitizes unsafe characters and spaces in the number', () => {
    expect(paymentConfirmationPdfFilename('F 2026/0042')).toBe('Betalningsbekraftelse-F-2026-0042.pdf')
  })

  it('falls back when the number is missing', () => {
    expect(paymentConfirmationPdfFilename(null)).toBe('Betalningsbekraftelse-okand.pdf')
  })
})
