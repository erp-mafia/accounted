/**
 * What an invoice still asks the customer to pay: the one figure the PDF
 * payment box and every payment QR (Swish, payment link, bank app) share.
 */
import { describe, expect, it } from 'vitest'
import {
  invoiceAmountDue,
  isInvoicePayableStatus,
  partlyPaidRemainder,
} from '@/lib/invoices/amount-due'
import { makeInvoice } from '@/tests/helpers'

const company = { ore_rounding: true }

describe('isInvoicePayableStatus', () => {
  it('is true for a real invoice that is a draft, sent, overdue or partly paid', () => {
    for (const status of ['draft', 'sent', 'overdue', 'partially_paid'] as const) {
      expect(isInvoicePayableStatus(makeInvoice({ status })), status).toBe(true)
    }
  })

  it('is false once the invoice is paid, cancelled or credited', () => {
    for (const status of ['paid', 'cancelled', 'credited'] as const) {
      expect(isInvoicePayableStatus(makeInvoice({ status })), status).toBe(false)
    }
  })

  it('is false for a credit note, whatever its status', () => {
    expect(isInvoicePayableStatus(makeInvoice({ status: 'sent', credited_invoice_id: 'inv-orig' }))).toBe(false)
  })

  it('is false for documents that are not payment requests', () => {
    for (const documentType of ['proforma', 'quote', 'delivery_note'] as const) {
      expect(isInvoicePayableStatus(makeInvoice({ status: 'sent', document_type: documentType })), documentType).toBe(false)
    }
  })

  it('treats a missing status or document type as a payable invoice (previews, legacy rows)', () => {
    expect(isInvoicePayableStatus({})).toBe(true)
    expect(isInvoicePayableStatus({ status: null, document_type: null, credited_invoice_id: null })).toBe(true)
  })
})

describe('invoiceAmountDue', () => {
  it('is "Att betala" on an unpaid invoice', () => {
    expect(invoiceAmountDue(makeInvoice({ status: 'sent', total: 12500 }), company)).toBe(12500)
  })

  it('applies öresavrundning, then the ROT/RUT deduction, like the PDF totals block', () => {
    expect(invoiceAmountDue(makeInvoice({ status: 'sent', total: 1250.49 }), company)).toBe(1250)
    expect(invoiceAmountDue(makeInvoice({ status: 'sent', total: 1250.49 }), { ore_rounding: false })).toBe(1250.49)
    expect(
      invoiceAmountDue(makeInvoice({ status: 'sent', total: 1250.49, deduction_total: 625 }), company),
    ).toBe(625)
  })

  it('is the remainder on a partly paid invoice', () => {
    const partly = makeInvoice({ status: 'partially_paid', total: 12500, paid_amount: 5000, remaining_amount: 7500 })
    expect(invoiceAmountDue(partly, company)).toBe(7500)
  })

  it('falls back to "Att betala" minus what was paid when the row has no remaining_amount', () => {
    const partly = makeInvoice({
      status: 'partially_paid',
      total: 12500,
      deduction_total: 2500,
      paid_amount: 4000.1,
      remaining_amount: undefined,
    })
    expect(invoiceAmountDue(partly, company)).toBe(5999.9)
  })

  it('is 0 once nothing is asked for: paid, cancelled, credited, credit notes, other documents', () => {
    expect(invoiceAmountDue(makeInvoice({ status: 'paid', paid_amount: 12500, remaining_amount: 0 }), company)).toBe(0)
    expect(invoiceAmountDue(makeInvoice({ status: 'cancelled' }), company)).toBe(0)
    expect(invoiceAmountDue(makeInvoice({ status: 'credited' }), company)).toBe(0)
    expect(invoiceAmountDue(makeInvoice({ status: 'sent', credited_invoice_id: 'inv-orig', total: -12500 }), company)).toBe(0)
    expect(invoiceAmountDue(makeInvoice({ status: 'sent', document_type: 'proforma' }), company)).toBe(0)
    expect(invoiceAmountDue(makeInvoice({ status: 'sent', document_type: 'quote' }), company)).toBe(0)
    expect(invoiceAmountDue(makeInvoice({ status: 'sent', document_type: 'delivery_note' }), company)).toBe(0)
  })

  it('is 0 when a deduction covers the whole invoice, and never negative', () => {
    expect(invoiceAmountDue(makeInvoice({ status: 'sent', total: 1250, deduction_total: 1250 }), company)).toBe(0)
    expect(invoiceAmountDue(makeInvoice({ status: 'sent', total: -100 }), company)).toBe(0)
  })
})

describe('partlyPaidRemainder', () => {
  it('prefers the ledger figure, floors at zero and rounds to öre', () => {
    expect(partlyPaidRemainder({ paid_amount: 100, remaining_amount: 250.004 }, 1000)).toBe(250)
    expect(partlyPaidRemainder({ paid_amount: 100, remaining_amount: -5 }, 1000)).toBe(0)
    expect(partlyPaidRemainder({ paid_amount: 1200, remaining_amount: null }, 1000)).toBe(0)
    expect(partlyPaidRemainder({ paid_amount: null, remaining_amount: null }, 1000)).toBe(1000)
  })
})
