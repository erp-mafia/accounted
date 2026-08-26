import { describe, expect, it } from 'vitest'
import { isPaymentConfirmationEligible } from '@/lib/invoices/payment-confirmation'
import { makeInvoice } from '@/tests/helpers'

describe('isPaymentConfirmationEligible', () => {
  it('accepts a fully paid faktura', () => {
    expect(isPaymentConfirmationEligible(makeInvoice({ status: 'paid' }))).toBe(true)
  })

  it.each(['draft', 'sent', 'overdue', 'partially_paid', 'cancelled', 'credited'] as const)(
    'refuses status %s',
    (status) => {
      expect(isPaymentConfirmationEligible(makeInvoice({ status }))).toBe(false)
    },
  )

  it('refuses credit notes even when marked paid', () => {
    expect(
      isPaymentConfirmationEligible(makeInvoice({ status: 'paid', credited_invoice_id: 'orig' })),
    ).toBe(false)
  })

  it.each(['proforma', 'delivery_note'] as const)('refuses document type %s', (document_type) => {
    expect(isPaymentConfirmationEligible(makeInvoice({ status: 'paid', document_type }))).toBe(false)
  })

  it('treats a missing document_type as a regular invoice', () => {
    expect(
      isPaymentConfirmationEligible({ status: 'paid', credited_invoice_id: null, document_type: null }),
    ).toBe(true)
  })
})
