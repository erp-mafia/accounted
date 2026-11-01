import { describe, it, expect } from 'vitest'
import { invoiceRowTone, type InvoiceRowToneInput } from '@/lib/invoices/invoice-list-row-tone'

function row(status: InvoiceRowToneInput['status'], extra: Partial<InvoiceRowToneInput> = {}): InvoiceRowToneInput {
  return { status, credited_invoice_id: null, document_type: 'invoice', ...extra }
}

const TODAY = '2026-10-13'

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

  it('overdue: an owed customer invoice past its due date, whatever the stored status (crm#1084)', () => {
    const pastDue = { due_date: '2026-09-30', remaining_amount: 1250 }
    expect(invoiceRowTone(row('sent', pastDue), TODAY)).toBe('overdue')
    expect(invoiceRowTone(row('partially_paid', pastDue), TODAY)).toBe('overdue')
    expect(invoiceRowTone(row('overdue', pastDue), TODAY)).toBe('overdue')
  })

  it('open: not yet due, due today, or nothing left to pay is not overdue', () => {
    expect(invoiceRowTone(row('sent', { due_date: TODAY, remaining_amount: 1250 }), TODAY)).toBe('open')
    expect(invoiceRowTone(row('sent', { due_date: '2026-10-30', remaining_amount: 1250 }), TODAY)).toBe('open')
    // A stored 'overdue' whose due date moved reads as open again.
    expect(invoiceRowTone(row('overdue', { due_date: '2026-10-30', remaining_amount: 1250 }), TODAY)).toBe('open')
    expect(invoiceRowTone(row('sent', { due_date: '2026-09-30', remaining_amount: 0 }), TODAY)).toBe('open')
  })

  it('none: drafts and non-invoice documents never read as receivables', () => {
    expect(invoiceRowTone(row('draft'))).toBe('none')
    expect(invoiceRowTone(row('sent', { document_type: 'proforma' }))).toBe('none')
    expect(invoiceRowTone(row('sent', { document_type: 'quote' }))).toBe('none')
    expect(invoiceRowTone(row('sent', { document_type: 'delivery_note' }))).toBe('none')
    expect(invoiceRowTone(row('overdue', { document_type: 'proforma', due_date: '2026-09-30' }), TODAY)).toBe('none')
  })

  it('none: an unpaid credit note is not a receivable even when sent or overdue', () => {
    expect(invoiceRowTone(row('sent', { credited_invoice_id: 'inv-1' }))).toBe('none')
    expect(invoiceRowTone(row('overdue', { credited_invoice_id: 'inv-1', due_date: '2026-09-30' }), TODAY)).toBe('none')
  })

  it('treats a missing or null document_type as a customer invoice, like the list page', () => {
    expect(invoiceRowTone({ status: 'sent', credited_invoice_id: null })).toBe('open')
    expect(
      invoiceRowTone({ status: 'sent', credited_invoice_id: null, document_type: null, due_date: '2026-09-30' }, TODAY),
    ).toBe('overdue')
  })
})

describe('invoiceRowTone: a credit note imported without a link', () => {
  it('is no open receivable, like a linked one', () => {
    expect(invoiceRowTone(row('sent', { total: -500, due_date: '2026-01-01', remaining_amount: 0 }), TODAY)).toBe('none')
    expect(invoiceRowTone(row('draft', { total: -500 }), TODAY)).toBe('none')
  })
})
