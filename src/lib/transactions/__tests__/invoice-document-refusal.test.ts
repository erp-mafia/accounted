import { describe, expect, it } from 'vitest'
import { hasActiveCreditNote, invoiceDocumentRefusal } from '../invoice-document-refusal'

describe('invoiceDocumentRefusal', () => {
  it('lets a faktura with no credit note through', () => {
    expect(invoiceDocumentRefusal({ document_type: 'invoice', credited_invoice_id: null, credit_notes: [] })).toBeNull()
    expect(invoiceDocumentRefusal({})).toBeNull()
  })

  it('refuses a proforma, a quote and a delivery note: none carries a receivable', () => {
    for (const documentType of ['proforma', 'quote', 'delivery_note']) {
      expect(invoiceDocumentRefusal({ document_type: documentType })).toEqual({
        code: 'MATCH_INVOICE_NOT_INVOICE_TYPE',
        details: { documentType },
      })
    }
  })

  it('refuses a credit note', () => {
    expect(invoiceDocumentRefusal({ credited_invoice_id: 'inv-1' })).toEqual({ code: 'MATCH_INVOICE_CREDIT_NOTE' })
  })

  it('refuses an original with an active credit note, a draft included', () => {
    expect(invoiceDocumentRefusal({ credit_notes: [{ status: 'draft', creation_complete: true }] })).toEqual({
      code: 'MATCH_INVOICE_CREDIT_NOTE',
      details: { reason: 'active_credit_note' },
    })
  })
})

describe('hasActiveCreditNote', () => {
  it('does not count a cancelled or half-created credit note', () => {
    expect(hasActiveCreditNote({ credit_notes: [{ status: 'cancelled', creation_complete: true }] })).toBe(false)
    expect(hasActiveCreditNote({ credit_notes: [{ status: 'draft', creation_complete: false }] })).toBe(false)
    expect(hasActiveCreditNote({ credit_notes: null })).toBe(false)
  })
})
