/**
 * What the invoice PDF's payment area says, per document type and status
 * (lib/invoices/pdf/payment-area.ts). The area has one fixed height; only
 * its words change, so these are the rules a re-render must follow.
 */
import { describe, expect, it } from 'vitest'
import {
  buildPdfPaymentArea,
  documentHasPaymentArea,
  type PdfPaymentAreaInput,
} from '@/lib/invoices/pdf/payment-area'
import type { InvoicePdfPaymentQr } from '@/lib/invoices/payment-qr'
import { generateOcrReference } from '@/lib/bankgiro/luhn'

const qr: InvoicePdfPaymentQr = { kind: 'bank_app', caption: 'Skanna med din bankapp', vector: { path: 'M4 4h1v1h-1z', size: 29 } }

function input(overrides: Partial<PdfPaymentAreaInput> = {}, invoice: Partial<PdfPaymentAreaInput['invoice']> = {}): PdfPaymentAreaInput {
  return {
    invoice: {
      status: 'sent',
      invoice_number: '1042',
      currency: 'SEK',
      due_date: '2026-11-01',
      our_reference: 'Anna Säljare',
      payment_link_url: null,
      ...invoice,
    },
    company: {
      bankgiro: '5050-1055',
      invoice_show_bankgiro: true,
      invoice_show_ocr: true,
      email: 'info@example.test',
      phone: '08-000 00 00',
    },
    lang: 'sv',
    docType: 'invoice',
    isCreditNote: false,
    amountToPay: 12500,
    paidState: null,
    paymentQr: qr,
    ...overrides,
  }
}

describe('buildPdfPaymentArea', () => {
  it('unpaid faktura: Att betala, the due date, the payment rows ending in the reference, the code', () => {
    const area = buildPdfPaymentArea(input())!
    expect(area).toMatchObject({
      kicker: 'Betalning',
      amountLabel: 'Att betala',
      amount: 12500,
      currency: 'SEK',
      amountNote: null,
      detail: { label: 'Förfallodatum', value: '2026-11-01' },
      status: null,
      slot: { kind: 'qr', qr },
    })
    expect(area.rows.map((r) => [r.key, r.label])).toEqual([
      ['bankgiro', 'Bankgiro'],
      ['ocr', 'OCR/Referens'],
    ])
    expect(area.rows[1]).toMatchObject({ value: generateOcrReference('1042'), emphasis: true })
  })

  it('partly paid: the remainder, what was paid, the same rows and the code', () => {
    const area = buildPdfPaymentArea(
      input({ paidState: { kind: 'partially_paid', paidAmount: 5000, remainingAmount: 7500, paidDate: null } }),
    )!
    expect(area).toMatchObject({
      amountLabel: 'Kvar att betala',
      amount: 7500,
      amountNote: 'Betalt: 5 000,00 SEK',
      slot: { kind: 'qr' },
    })
    expect(area.rows).toHaveLength(2)
  })

  it('paid: nothing left, the same rows, and the paid marker instead of a code', () => {
    const area = buildPdfPaymentArea(
      input({ paidState: { kind: 'paid', paidAmount: 12500, remainingAmount: 0, paidDate: '2026-10-20' } }),
    )!
    expect(area).toMatchObject({
      amountLabel: 'Kvar att betala',
      amount: 0,
      slot: { kind: 'paid', title: 'Betald', date: '2026-10-20', amount: '12 500,00 SEK' },
    })
    expect(area.rows).toHaveLength(2)
  })

  it('cancelled: says it must not be paid, with no rows and no code', () => {
    const area = buildPdfPaymentArea(input({}, { status: 'cancelled' }))!
    expect(area).toMatchObject({ amountLabel: 'Att betala', amount: 0, rows: [], slot: null, detail: null })
    expect(area.status?.headline).toBe('Makulerad, ska inte betalas.')
    expect(area.status?.text).toContain('Faktura 1042 har makulerats')
  })

  it('credited: says it must not be paid, with no rows and no code', () => {
    const area = buildPdfPaymentArea(input({}, { status: 'credited' }))!
    expect(area).toMatchObject({ amount: 0, rows: [], slot: null, status: { headline: 'Krediterad, ska inte betalas.' } })
  })

  it('kreditfaktura: Att kreditera and the invoice it credits, no rows, no code', () => {
    const area = buildPdfPaymentArea(input({ isCreditNote: true, amountToPay: -12500, originalInvoiceNumber: '1041' }))!
    expect(area).toEqual({
      kicker: 'Kredit',
      amountLabel: 'Att kreditera',
      amount: -12500,
      currency: 'SEK',
      amountNote: null,
      detail: { label: 'Avser faktura', value: '1041' },
      rows: [],
      status: null,
      slot: null,
    })
  })

  it('offert: Summa, Giltig till and who to ask, no payment rows, no code', () => {
    const area = buildPdfPaymentArea(input({ docType: 'quote' }, { valid_until: '2026-12-01' }))!
    expect(area).toMatchObject({
      kicker: 'Offert',
      amountLabel: 'Summa',
      detail: { label: 'Giltig till', value: '2026-12-01' },
      slot: null,
    })
    expect(area.rows.map((r) => [r.label, r.value])).toEqual([
      ['Kontakt', 'Anna Säljare'],
      ['E-post', 'info@example.test'],
      ['Telefon', '08-000 00 00'],
    ])
  })

  it('proforma and följesedel: no payment area at all', () => {
    expect(buildPdfPaymentArea(input({ docType: 'proforma' }))).toBeNull()
    expect(buildPdfPaymentArea(input({ docType: 'delivery_note' }))).toBeNull()
    expect(documentHasPaymentArea('proforma', false)).toBe(false)
    expect(documentHasPaymentArea('delivery_note', false)).toBe(false)
    expect(documentHasPaymentArea('invoice', true)).toBe(true)
    expect(documentHasPaymentArea('quote', false)).toBe(true)
  })

  it('keeps the bank account number on one line: only the bank name may wrap', () => {
    const area = buildPdfPaymentArea({
      ...input(),
      company: {
        ...input().company,
        bank_name: 'Svenska Handelsbanken AB (publ)',
        clearing_number: '6123',
        account_number: '456 789 012',
      },
    })!
    const bank = area.rows.find((r) => r.key === 'bank_account')!
    expect(bank.value).toBe('Svenska Handelsbanken AB (publ), 6123-456\u00a0789\u00a0012')
    // No plain (breakable) space between two digits of the number.
    expect(bank.value).not.toMatch(/[\d-] \d/)
  })

  it('prints the payment link short and links to the full URL', () => {
    const url = 'https://pay.example.test/checkout/session/abcdefghijklmnopqrstuvwxyz0123'
    const area = buildPdfPaymentArea(input({}, { payment_link_url: url }))!
    const link = area.rows.find((r) => r.key === 'payment_link')!
    expect(link.href).toBe(url)
    expect(link.value.startsWith('pay.example.test/')).toBe(true)
    expect(link.value.length).toBeLessThanOrEqual(40)
  })

  it('speaks English on an English invoice', () => {
    const area = buildPdfPaymentArea(
      input({ lang: 'en', paidState: { kind: 'partially_paid', paidAmount: 5000, remainingAmount: 7500, paidDate: null } }),
    )!
    expect(area).toMatchObject({ kicker: 'Payment', amountLabel: 'Balance due', amountNote: 'Paid: 5,000.00 SEK' })
    expect(area.detail?.label).toBe('Due date')
  })
})
