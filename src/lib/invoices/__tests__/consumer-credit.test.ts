import { describe, it, expect } from 'vitest'
import {
  consumerCreditApplies,
  consumerCreditRefusal,
  consumerInvoiceTerms,
  isInvoiceFeeLine,
} from '../consumer-credit'

const base = {
  customerType: 'individual' as const,
  documentType: 'invoice' as const,
  invoiceDate: '2026-12-01',
  dueDate: '2026-12-31',
  total: 1250,
  items: [{ description: 'Målning av staket', line_type: 'product' }],
}

describe('consumerCreditApplies', () => {
  it('reaches private persons from the day the act enters into force', () => {
    expect(consumerCreditApplies('individual', '2026-11-20')).toBe(true)
    expect(consumerCreditApplies('individual', '2026-11-19')).toBe(false)
    expect(consumerCreditApplies('swedish_business', '2026-12-01')).toBe(false)
    expect(consumerCreditApplies(null, '2026-12-01')).toBe(false)
  })
})

describe('consumerInvoiceTerms', () => {
  it('holds a consumer at 50 days and leaves everyone else alone', () => {
    expect(consumerInvoiceTerms(60, 'individual', '2026-12-01')).toBe(50)
    expect(consumerInvoiceTerms(30, 'individual', '2026-12-01')).toBe(30)
    expect(consumerInvoiceTerms(60, 'individual', '2026-11-19')).toBe(60)
    expect(consumerInvoiceTerms(90, 'swedish_business', '2026-12-01')).toBe(90)
  })
})

describe('isInvoiceFeeLine', () => {
  it('reads a fee for being invoiced by its text', () => {
    expect(isInvoiceFeeLine({ description: 'Fakturaavgift' })).toBe(true)
    expect(isInvoiceFeeLine({ description: 'Faktureringsavgift 49 kr' })).toBe(true)
    expect(isInvoiceFeeLine({ description: 'Aviavgift' })).toBe(true)
    expect(isInvoiceFeeLine({ description: 'Invoice fee' })).toBe(true)
  })

  it('leaves late-payment costs, ordinary lines and text rows alone', () => {
    expect(isInvoiceFeeLine({ description: 'Påminnelseavgift' })).toBe(false)
    expect(isInvoiceFeeLine({ description: 'Påminnelseavgift faktura 1042' })).toBe(false)
    expect(isInvoiceFeeLine({ description: 'Dröjsmålsränta' })).toBe(false)
    expect(isInvoiceFeeLine({ description: 'Frakt' })).toBe(false)
    expect(isInvoiceFeeLine({ description: 'Ingen fakturaavgift tas ut', line_type: 'text' })).toBe(false)
  })
})

describe('consumerCreditRefusal', () => {
  it('lets a fee-free invoice due within 50 days through', () => {
    expect(consumerCreditRefusal(base)).toBeNull()
    expect(consumerCreditRefusal({ ...base, dueDate: '2027-01-20' })).toBeNull()
  })

  it('refuses a due date past 50 days and names the last one allowed', () => {
    expect(consumerCreditRefusal({ ...base, dueDate: '2027-01-21' })).toEqual({
      code: 'INVOICE_CONSUMER_CREDIT_TERMS_TOO_LONG',
      details: { maxDays: 50, countedFrom: '2026-12-01', latestDueDate: '2027-01-20', dueDate: '2027-01-21' },
    })
  })

  it('counts from a delivery that comes after the invoice date, never from one before it', () => {
    expect(consumerCreditRefusal({ ...base, deliveryDate: '2026-12-20', dueDate: '2027-02-08' })).toBeNull()
    expect(consumerCreditRefusal({ ...base, deliveryDate: '2026-12-20', dueDate: '2027-02-09' })?.code).toBe(
      'INVOICE_CONSUMER_CREDIT_TERMS_TOO_LONG',
    )
    expect(consumerCreditRefusal({ ...base, deliveryDate: '2026-10-01', dueDate: '2027-01-20' })).toBeNull()
  })

  it('refuses an invoice fee line', () => {
    expect(
      consumerCreditRefusal({ ...base, items: [...base.items, { description: 'Fakturaavgift' }] }),
    ).toEqual({ code: 'INVOICE_CONSUMER_CREDIT_FEE', details: { lines: ['Fakturaavgift'] } })
  })

  it('does not reach businesses, earlier invoices, other documents or credit notes', () => {
    const breaking = { ...base, dueDate: '2027-06-01', items: [{ description: 'Fakturaavgift' }] }
    expect(consumerCreditRefusal({ ...breaking, customerType: 'swedish_business' })).toBeNull()
    expect(consumerCreditRefusal({ ...breaking, invoiceDate: '2026-11-19' })).toBeNull()
    expect(consumerCreditRefusal({ ...breaking, documentType: 'quote' })).toBeNull()
    expect(consumerCreditRefusal({ ...breaking, documentType: 'proforma' })).toBeNull()
    expect(consumerCreditRefusal({ ...breaking, total: -1250 })).toBeNull()
  })
})
