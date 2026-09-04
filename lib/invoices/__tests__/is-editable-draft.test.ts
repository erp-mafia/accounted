import { describe, it, expect } from 'vitest'
import { isEditableInvoiceDraft } from '@/lib/invoices/is-editable-draft'

describe('isEditableInvoiceDraft', () => {
  it('allows a plain draft with no committed verifikat', () => {
    expect(
      isEditableInvoiceDraft({ status: 'draft', journal_entry_id: null, is_self_billed: false }),
    ).toBe(true)
  })

  it('allows a draft when the optional fields are absent', () => {
    expect(isEditableInvoiceDraft({ status: 'draft' })).toBe(true)
  })

  it('blocks any non-draft status', () => {
    for (const status of ['sent', 'paid', 'cancelled', 'credited', 'overdue']) {
      expect(isEditableInvoiceDraft({ status })).toBe(false)
    }
  })

  it('blocks a draft that somehow already carries a committed verifikat', () => {
    expect(
      isEditableInvoiceDraft({ status: 'draft', journal_entry_id: 'je-1', is_self_billed: false }),
    ).toBe(false)
  })

  it('blocks a received self-billed document', () => {
    expect(
      isEditableInvoiceDraft({ status: 'draft', journal_entry_id: null, is_self_billed: true }),
    ).toBe(false)
  })

  it('blocks a credit-note draft because it must continue mirroring the original', () => {
    expect(
      isEditableInvoiceDraft({
        status: 'draft',
        journal_entry_id: null,
        credited_invoice_id: 'invoice-1',
      }),
    ).toBe(false)
  })

  it('allows an open quote draft but blocks one that was accepted or declined', () => {
    expect(isEditableInvoiceDraft({ status: 'draft', quote_status: 'open' })).toBe(true)
    expect(isEditableInvoiceDraft({ status: 'draft', quote_status: 'accepted' })).toBe(false)
    expect(isEditableInvoiceDraft({ status: 'draft', quote_status: 'declined' })).toBe(false)
  })
})
