import { describe, expect, it } from 'vitest'
import { invoiceRowStatus, type InvoiceRowStatusInput } from '../status-display'

const TODAY = '2026-10-13'

function row(overrides: Partial<InvoiceRowStatusInput> & { status: string }): InvoiceRowStatusInput {
  return {
    invoice_number: 'F-1',
    document_type: 'invoice',
    credited_invoice_id: null,
    is_self_billed: false,
    due_date: '2026-11-01',
    remaining_amount: 1000,
    paid_at: null,
    ...overrides,
  }
}

describe('invoiceRowStatus: the status line the list and the customer card share (crm#1084)', () => {
  it('a sent invoice past its due date reads "Förfallen N dgr" though no reminder set the status', () => {
    expect(invoiceRowStatus(row({ status: 'sent', due_date: '2026-09-13' }), TODAY)).toEqual({
      kind: 'overdue',
      labelKey: 'status_overdue_days',
      values: { days: 30 },
      chip: 'warning',
    })
  })

  it('a sent invoice not yet due reads as sent, and so does a stored overdue whose due date moved', () => {
    expect(invoiceRowStatus(row({ status: 'sent' }), TODAY)).toMatchObject({ kind: 'sent', labelKey: 'status_sent', chip: null })
    expect(invoiceRowStatus(row({ status: 'overdue' }), TODAY)).toMatchObject({ kind: 'sent', labelKey: 'status_sent' })
  })

  it('a partly paid invoice reads as partly paid first, overdue or not', () => {
    expect(invoiceRowStatus(row({ status: 'partially_paid', due_date: '2026-09-01' }), TODAY)).toMatchObject({
      kind: 'partially_paid',
      labelKey: 'status_partially_paid',
      chip: 'warning',
    })
  })

  it('cancelled, credited and draft invoices say so instead of "Obetald"', () => {
    expect(invoiceRowStatus(row({ status: 'cancelled', due_date: '2026-09-01' }), TODAY)).toMatchObject({
      kind: 'cancelled',
      labelKey: 'status_cancelled',
    })
    expect(invoiceRowStatus(row({ status: 'credited', due_date: '2026-09-01' }), TODAY)).toMatchObject({
      kind: 'credited',
      labelKey: 'status_credited',
    })
    expect(invoiceRowStatus(row({ status: 'draft', invoice_number: null }), TODAY)).toMatchObject({
      kind: 'draft',
      labelKey: 'status_draft',
    })
    expect(invoiceRowStatus(row({ status: 'draft', invoice_number: 'F-9' }), TODAY)).toMatchObject({
      kind: 'unsent',
      labelKey: 'status_unsent',
      chip: 'outline',
    })
  })

  it('a paid invoice reads with its paid date when there is one', () => {
    expect(invoiceRowStatus(row({ status: 'paid', paid_at: '2026-10-02' }), TODAY)).toEqual({
      kind: 'paid',
      labelKey: 'status_paid_date',
      values: { date: '2026-10-02' },
      chip: null,
    })
    expect(invoiceRowStatus(row({ status: 'paid' }), TODAY)).toMatchObject({ kind: 'paid', labelKey: 'status_paid' })
  })

  it('an unpaid credit note reads as Kredit, never as overdue', () => {
    expect(
      invoiceRowStatus(row({ status: 'sent', credited_invoice_id: 'orig', due_date: '2026-09-01', remaining_amount: 0 }), TODAY),
    ).toMatchObject({ kind: 'credit_note', labelKey: 'badge_credit', chip: 'destructive' })
  })

  it('a quote reads its effective decision, expired derived from valid_until', () => {
    expect(
      invoiceRowStatus(row({ status: 'sent', document_type: 'quote', quote_status: 'open', valid_until: '2026-10-01' }), TODAY),
    ).toMatchObject({ kind: 'quote', labelKey: 'quote_status_expired', chip: 'warning' })
    expect(
      invoiceRowStatus(row({ status: 'sent', document_type: 'quote', quote_status: 'accepted' }), TODAY),
    ).toMatchObject({ kind: 'quote', labelKey: 'quote_status_accepted', chip: null })
  })

  it('an open quote that never left reads "Ej skickad", as the list says it (crm#1202)', () => {
    expect(
      invoiceRowStatus(row({ status: 'draft', document_type: 'quote', quote_status: 'open', valid_until: '2026-11-01' }), TODAY),
    ).toEqual({ kind: 'quote', labelKey: 'status_unsent', chip: 'outline' })
    // Expiry outranks unsent: an expired offer needs a new date before sending.
    expect(
      invoiceRowStatus(row({ status: 'draft', document_type: 'quote', quote_status: 'open', valid_until: '2026-10-01' }), TODAY),
    ).toMatchObject({ labelKey: 'quote_status_expired' })
  })

  it('never reads a quote, proforma or delivery note past its due date as overdue', () => {
    for (const document_type of ['quote', 'proforma', 'delivery_note']) {
      const status = invoiceRowStatus(
        row({ status: 'sent', document_type, quote_status: document_type === 'quote' ? 'open' : null, due_date: '2026-09-01' }),
        TODAY,
      )
      expect(status.kind).not.toBe('overdue')
    }
  })

  it('a status this build does not know has no label key, so the caller shows it raw', () => {
    expect(invoiceRowStatus(row({ status: 'some_future_status' }), TODAY)).toEqual({ kind: 'unknown', labelKey: null, chip: null })
  })

  it('reads a konstaterad kundförlust as written off, past its due date or not', () => {
    expect(invoiceRowStatus(row({ status: 'written_off', due_date: '2026-09-01' }), TODAY)).toEqual({
      kind: 'written_off',
      labelKey: 'status_written_off',
      chip: 'destructive',
    })
  })
})
