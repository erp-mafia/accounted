import { describe, expect, it } from 'vitest'
import { isInvoiceResendEligible } from '@/lib/invoices/resend-eligibility'
import { makeInvoice } from '@/tests/helpers'

describe('isInvoiceResendEligible', () => {
  it.each(['sent', 'overdue'] as const)('accepts an unpaid faktura in status %s', (status) => {
    expect(isInvoiceResendEligible(makeInvoice({ status }))).toBe(true)
  })

  // Paid and partly paid: the copy repeats the amount to pay and would invite
  // a second payment. Credited and cancelled are no longer payment requests.
  it.each(['draft', 'paid', 'partially_paid', 'credited', 'cancelled'] as const)(
    'refuses status %s',
    (status) => {
      expect(isInvoiceResendEligible(makeInvoice({ status }))).toBe(false)
    },
  )

  it('accepts a sent kreditfaktura', () => {
    expect(
      isInvoiceResendEligible(makeInvoice({ status: 'sent', credited_invoice_id: 'orig' })),
    ).toBe(true)
  })

  it.each(['quote', 'proforma', 'delivery_note'] as const)('refuses document type %s', (document_type) => {
    expect(isInvoiceResendEligible(makeInvoice({ status: 'sent', document_type }))).toBe(false)
  })

  it('treats a missing document_type as a regular invoice', () => {
    expect(isInvoiceResendEligible({ status: 'sent', document_type: null })).toBe(true)
  })
})
