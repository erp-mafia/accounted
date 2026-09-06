import { describe, it, expect } from 'vitest'
import { invoiceRowTone, type InvoiceRowToneInput } from '@/lib/invoices/invoice-list-row-tone'

function row(status: InvoiceRowToneInput['status'], extra: Partial<InvoiceRowToneInput> = {}): InvoiceRowToneInput {
  return { status, credited_invoice_id: null, document_type: 'invoice', ...extra }
}

describe('invoiceRowTone', () => {
  it('settled: paid, cancelled and credited rows recede regardless of document type', () => {
    expect(invoiceRowTone(row('paid'))).toBe('settled')
    expect(invoiceRowTone(row('cancelled'))).toBe('settled')
    expect(invoiceRowTone(row('credited'))).toBe('settled')
    expect(invoiceRowTone(row('paid', { credited_invoice_id: 'inv-1' }))).toBe('settled')
    expect(invoiceRowTone(row('cancelled', { document_type: 'quote' }))).toBe('settled')
  })

  it('open: a sent or partially paid customer invoice is waiting for money', () => {
    expect(invoiceRowTone(row('sent'))).toBe('open')
    expect(invoiceRowTone(row('partially_paid'))).toBe('open')
  })

  it('overdue: an overdue customer invoice', () => {
    expect(invoiceRowTone(row('overdue'))).toBe('overdue')
  })

  it('none: drafts and non-invoice documents never read as receivables', () => {
    expect(invoiceRowTone(row('draft'))).toBe('none')
    expect(invoiceRowTone(row('sent', { document_type: 'proforma' }))).toBe('none')
    expect(invoiceRowTone(row('sent', { document_type: 'quote' }))).toBe('none')
    expect(invoiceRowTone(row('sent', { document_type: 'delivery_note' }))).toBe('none')
    expect(invoiceRowTone(row('overdue', { document_type: 'proforma' }))).toBe('none')
  })

  it('none: an unpaid credit note is not a receivable even when sent or overdue', () => {
    expect(invoiceRowTone(row('sent', { credited_invoice_id: 'inv-1' }))).toBe('none')
    expect(invoiceRowTone(row('overdue', { credited_invoice_id: 'inv-1' }))).toBe('none')
  })

  it('treats a missing or null document_type as a customer invoice, like the list page', () => {
    expect(invoiceRowTone({ status: 'sent', credited_invoice_id: null })).toBe('open')
    expect(invoiceRowTone({ status: 'overdue', credited_invoice_id: null, document_type: null })).toBe('overdue')
  })
})
