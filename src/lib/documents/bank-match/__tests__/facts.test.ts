import { describe, expect, it } from 'vitest'
import type { DocumentReading, ReadingFields } from '@/lib/documents/reading/types'
import { bankMatchFacts, paymentWindow, searchRange, windowDueDate } from '../facts'

function reading(fields: Record<string, unknown>): DocumentReading {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(fields)) out[name] = { value, source: 'vision', evidence: 'trolig' }
  return {
    document_id: 'doc-1',
    inbox_item_id: 'item-1',
    fields: out as ReadingFields,
    door: { intake_source: 'upload', sender: null, received_at: null },
    notes: [],
  }
}

const INVOICE = {
  document_type: 'supplier_invoice',
  seller_name: 'Kontorsbolaget AB',
  amount_due_for_payment: 1250,
  invoice_currency_code: 'sek',
  remittance_information: '4711000123',
  payment_account_bankgiro: '999-0003',
  invoice_issue_date: '2026-09-01',
  payment_due_date: '2026-09-30',
}

describe('bankMatchFacts', () => {
  it('reads what the payment should look like off the one reading', () => {
    expect(bankMatchFacts(reading(INVOICE), null, '2026-09-02')).toEqual({
      kind: 'supplier_invoice',
      direction: 'out',
      amount: 1250,
      currency: 'SEK',
      reference: '4711000123',
      bankgiro: '999-0003',
      plusgiro: null,
      supplierBankgiro: null,
      supplierPlusgiro: null,
      issueDate: '2026-09-01',
      dueDate: '2026-09-30',
      names: ['Kontorsbolaget AB'],
      arrivedOn: '2026-09-02',
    })
  })

  it('a credit note expects money back, its amount as a magnitude', () => {
    const facts = bankMatchFacts(reading({ ...INVOICE, document_type: 'credit_note', amount_due_for_payment: -500 }), null, '2026-09-02')
    expect(facts).toMatchObject({ kind: 'credit_note', direction: 'in', amount: 500 })
  })

  it('a receipt below zero is a refund; a receipt has no due date', () => {
    const facts = bankMatchFacts(
      reading({ document_type: 'receipt', amount_due_for_payment: -99, invoice_issue_date: '2026-09-10', payment_due_date: '2026-09-30' }),
      null,
      '2026-09-11',
    )
    expect(facts).toMatchObject({ kind: 'receipt', direction: 'in', amount: 99, dueDate: null, currency: 'SEK' })
  })

  it('adds the supplier card name as an alias and its giro, once each', () => {
    const facts = bankMatchFacts(reading(INVOICE), { name: 'kontorsbolaget ab', bankgiro: '123-4566', plusgiro: null }, '2026-09-02')
    expect(facts?.names).toEqual(['Kontorsbolaget AB'])
    expect(facts?.supplierBankgiro).toBe('123-4566')
    const aliased = bankMatchFacts(reading(INVOICE), { name: 'KB Kontor Sverige', bankgiro: null, plusgiro: null }, '2026-09-02')
    expect(aliased?.names).toEqual(['Kontorsbolaget AB', 'KB Kontor Sverige'])
  })

  it.each([
    ['a government letter', { ...INVOICE, document_type: 'government_letter' }],
    ['another document', { ...INVOICE, document_type: 'other' }],
    ['no kind', { ...INVOICE, document_type: undefined }],
    ['no amount', { ...INVOICE, amount_due_for_payment: undefined }],
    ['a zero amount', { ...INVOICE, amount_due_for_payment: 0 }],
    ['an amount a person cleared', { ...INVOICE, amount_due_for_payment: null }],
  ])('matches nothing for %s', (_label, fields) => {
    expect(bankMatchFacts(reading(fields), null, '2026-09-02')).toBeNull()
  })

  it('drops a date that does not parse', () => {
    expect(bankMatchFacts(reading({ ...INVOICE, invoice_issue_date: 'första september' }), null, '2026-09-02')?.issueDate).toBeNull()
  })
})

describe('paymentWindow', () => {
  const facts = (over: Record<string, unknown>) => bankMatchFacts(reading({ ...INVOICE, ...over }), null, '2026-09-02')!

  it('an invoice: five days before the invoice date to five days after the due date (the matcher\'s pass 3)', () => {
    expect(paymentWindow(facts({}))).toEqual({ start: '2026-08-27', end: '2026-10-05', coreStart: '2026-09-01', coreEnd: '2026-09-30' })
  })

  it('about thirty days of credit on the side that is missing', () => {
    expect(paymentWindow(facts({ payment_due_date: undefined }))).toMatchObject({ start: '2026-08-27', end: '2026-10-06' })
    expect(paymentWindow(facts({ invoice_issue_date: undefined }))).toMatchObject({ start: '2026-08-26', end: '2026-10-05' })
  })

  it('none without a date: only the OCR can pair it', () => {
    expect(paymentWindow(facts({ invoice_issue_date: undefined, payment_due_date: undefined }))).toBeNull()
  })

  it('a receipt: five days before its date to ten after, the matcher handed a due date five days on', () => {
    const receipt = bankMatchFacts(reading({ document_type: 'receipt', amount_due_for_payment: 99, invoice_issue_date: '2026-09-10' }), null, '2026-09-11')!
    expect(paymentWindow(receipt)).toEqual({ start: '2026-09-05', end: '2026-09-20', coreStart: '2026-09-10', coreEnd: '2026-09-10' })
    expect(windowDueDate(receipt)).toBe('2026-09-15')
  })

  it('a receipt without a date is anchored on the day it arrived', () => {
    const receipt = bankMatchFacts(reading({ document_type: 'receipt', amount_due_for_payment: 99 }), null, '2026-09-11')!
    expect(paymentWindow(receipt)).toMatchObject({ start: '2026-09-06', end: '2026-09-21' })
  })
})

describe('searchRange', () => {
  it('spans two months around every known date and never ends before today', () => {
    const facts = bankMatchFacts(reading(INVOICE), null, '2026-09-02')!
    expect(searchRange(facts, '2026-10-16')).toEqual({ from: '2026-07-03', to: '2026-11-29' })
    expect(searchRange(facts, '2027-03-01')).toEqual({ from: '2026-07-03', to: '2027-03-01' })
  })
})
