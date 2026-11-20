import { describe, expect, it } from 'vitest'
import { classifyPayeeChange } from '@/lib/payments/payee-change'
import { payFromDocumentDetails, payInBankDetails, plainAmount, statedPayeeOfDocument, type PayInBankInvoice } from '../pay-in-bank'
import { reading } from './fixtures'

const INVOICE: PayInBankInvoice = {
  supplier_invoice_number: 'F-1001',
  payment_reference: '1234567897',
  payee_bankgiro: '50501055',
  payee_plusgiro: null,
  payee_iban: null,
  total: 1250,
  remaining_amount: 1250,
  currency: 'SEK',
  due_date: '2026-10-31',
  supplier: { name: 'Leverantören AB', bankgiro: '50501055', plusgiro: null, iban: null },
}

describe('payInBankDetails', () => {
  it('gives the bankgiro the invoice states, its OCR, what is owed and the due date', () => {
    expect(payInBankDetails(INVOICE, { hold: null })).toEqual({
      supplierName: 'Leverantören AB',
      account: { kind: 'bankgiro', value: '5050-1055' },
      held: false,
      reference: { kind: 'ocr', value: '1234567897' },
      amount: 1250,
      currency: 'SEK',
      dueDate: '2026-10-31',
      settled: false,
    })
  })

  it('says when nothing is left to pay', () => {
    expect(payInBankDetails({ ...INVOICE, status: 'paid', remaining_amount: 0 }, null).settled).toBe(true)
    expect(payInBankDetails({ ...INVOICE, remaining_amount: 0 }, null).settled).toBe(true)
    expect(payInBankDetails({ ...INVOICE, status: 'registered' }, null).settled).toBe(false)
  })

  it('falls back to the supplier card, a plusgiro after a bankgiro, then an IBAN', () => {
    expect(payInBankDetails({ ...INVOICE, payee_bankgiro: null }, null).account).toEqual({ kind: 'bankgiro', value: '5050-1055' })
    const plusgiro = { ...INVOICE, payee_bankgiro: null, supplier: { name: 'X', plusgiro: '45674' } }
    expect(payInBankDetails(plusgiro, null).account).toEqual({ kind: 'plusgiro', value: '4567-4' })
    const iban = { ...INVOICE, payee_bankgiro: null, supplier: null, payee_iban: 'se45 5000 0000 0583 9825 7466' }
    expect(payInBankDetails(iban, null).account).toEqual({ kind: 'iban', value: 'SE4550000000058398257466' })
    expect(payInBankDetails({ ...INVOICE, payee_bankgiro: null, supplier: null }, null).account).toBeNull()
  })

  it('never hands over an account that waits for a person to confirm it', () => {
    const d = payInBankDetails(INVOICE, { hold: 'payee_unconfirmed' })
    expect(d.held).toBe(true)
    expect(d.account).toBeNull()
    // The rest is still there: the person pays once the account is confirmed.
    expect(d.reference).toEqual({ kind: 'ocr', value: '1234567897' })
  })

  it('sends a reference that fails the OCR check digit as a message, and the invoice number when there is none', () => {
    expect(payInBankDetails({ ...INVOICE, payment_reference: '1234567890' }, null).reference).toEqual({ kind: 'message', value: '1234567890' })
    expect(payInBankDetails({ ...INVOICE, payment_reference: 'Order 77' }, null).reference).toEqual({ kind: 'message', value: 'Order 77' })
    expect(payInBankDetails({ ...INVOICE, payment_reference: '  ' }, null).reference).toEqual({ kind: 'message', value: 'F-1001' })
    expect(payInBankDetails({ ...INVOICE, payment_reference: null, supplier_invoice_number: null }, null).reference).toBeNull()
  })

  it('asks for what is still owed, in the invoice currency', () => {
    const d = payInBankDetails({ ...INVOICE, remaining_amount: 250.5, currency: 'eur' }, null)
    expect(d.amount).toBe(250.5)
    expect(d.currency).toBe('EUR')
    expect(payInBankDetails({ ...INVOICE, remaining_amount: null }, null).amount).toBe(1250)
  })
})

describe('payFromDocumentDetails', () => {
  const DOC = reading({
    documentKind: 'supplier_invoice',
    supplier: { name: 'Leverantören AB', bankgiro: '50501055' },
    invoice: { invoiceNumber: 'F-1001', paymentReference: '1234567897', dueDate: '2026-10-31' },
    totals: { total: 1250, vatAmount: 250 },
  })

  it('reads what to pay off the document itself: its bankgiro, OCR, total and due date', () => {
    expect(payFromDocumentDetails(DOC, { held: false })).toEqual({
      supplierName: 'Leverantören AB',
      account: { kind: 'bankgiro', value: '5050-1055' },
      held: false,
      reference: { kind: 'ocr', value: '1234567897' },
      amount: 1250,
      currency: 'SEK',
      dueDate: '2026-10-31',
    })
  })

  it('takes a plusgiro after a bankgiro, then an IBAN, and says when the document states none', () => {
    const plusgiro = reading({ supplier: { plusgiro: '45674' } })
    expect(payFromDocumentDetails(plusgiro, null).account).toEqual({ kind: 'plusgiro', value: '4567-4' })
    const iban = reading({ supplier: { iban: 'se45 5000 0000 0583 9825 7466' } })
    expect(payFromDocumentDetails(iban, null).account).toEqual({ kind: 'iban', value: 'SE4550000000058398257466' })
    expect(payFromDocumentDetails(reading(), null).account).toBeNull()
    expect(payFromDocumentDetails(null, null).account).toBeNull()
  })

  it('gives an OCR only when it passes the Bankgirot check digit, else a message, else the invoice number', () => {
    const ref = (paymentReference: string | null) =>
      payFromDocumentDetails(reading({ invoice: { invoiceNumber: 'F-1001', paymentReference } }), null).reference
    expect(ref('1234 5678 97')).toEqual({ kind: 'ocr', value: '1234567897' })
    expect(ref('1234567890')).toEqual({ kind: 'message', value: '1234567890' })
    expect(ref(null)).toEqual({ kind: 'message', value: 'F-1001' })
  })

  it('never hands over the number while the document\'s account differs from the supplier card', () => {
    const d = payFromDocumentDetails(DOC, { held: true })
    expect(d.held).toBe(true)
    expect(d.account).toBeNull()
    expect(d.reference).toEqual({ kind: 'ocr', value: '1234567897' })
    expect(d.amount).toBe(1250)
  })

  it('holds exactly when the payee rules call the document\'s account a change from the card', () => {
    const held = (card: Parameters<typeof classifyPayeeChange>[0]['card']) =>
      classifyPayeeChange({ invoice: statedPayeeOfDocument(DOC), card }).kind === 'changed'
    expect(held({ bankgiro: '1234-5674' })).toBe(true)
    // The same giro written another way, a card without an account, and no card at all show the number.
    expect(held({ bankgiro: '5050-1055' })).toBe(false)
    expect(held({})).toBe(false)
  })

  it('has no amount when the reading has no positive total, and keeps the document\'s currency', () => {
    expect(payFromDocumentDetails(reading({ totals: { total: null } }), null).amount).toBeNull()
    expect(payFromDocumentDetails(reading({ totals: { total: -500 } }), null).amount).toBeNull()
    expect(payFromDocumentDetails(reading({ invoice: { currency: 'eur' }, totals: { total: 99.5 } }), null)).toMatchObject({
      amount: 99.5,
      currency: 'EUR',
    })
  })
})

describe('plainAmount', () => {
  it('writes two decimals with a decimal comma and no grouping, as a bank amount field takes it', () => {
    expect(plainAmount(1250)).toBe('1250,00')
    expect(plainAmount(1234567.5)).toBe('1234567,50')
    expect(plainAmount(0.1 + 0.2)).toBe('0,30')
  })
})
