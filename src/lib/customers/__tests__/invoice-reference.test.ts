import { describe, expect, it } from 'vitest'
import { customerInvoiceReference, yourReferenceForNewInvoice } from '../invoice-reference'

describe('customerInvoiceReference', () => {
  it('is the card value, trimmed', () => {
    expect(customerInvoiceReference({ invoice_reference: '  KST 4410 ' })).toBe('KST 4410')
  })

  it.each([null, undefined, {}, { invoice_reference: null }, { invoice_reference: '   ' }])(
    'is null without a value (%j)',
    (customer) => {
      expect(customerInvoiceReference(customer)).toBeNull()
    },
  )
})

describe('yourReferenceForNewInvoice', () => {
  const customer = { invoice_reference: 'KST 4410' }

  it('keeps what the caller states', () => {
    expect(yourReferenceForNewInvoice('Anna Andersson', customer)).toBe('Anna Andersson')
  })

  it.each([undefined, null, '', '   '])('takes the card value when the caller states nothing (%j)', (stated) => {
    expect(yourReferenceForNewInvoice(stated, customer)).toBe('KST 4410')
  })

  it('is null when neither has one', () => {
    expect(yourReferenceForNewInvoice('', { invoice_reference: null })).toBeNull()
    expect(yourReferenceForNewInvoice(undefined, null)).toBeNull()
  })
})
