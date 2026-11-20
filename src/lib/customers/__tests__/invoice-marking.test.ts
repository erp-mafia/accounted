import { describe, expect, it } from 'vitest'
import { customerInvoiceMarking, invoiceMarkingForNewInvoice } from '../invoice-marking'

describe('customerInvoiceMarking', () => {
  it('is the card value, trimmed', () => {
    expect(customerInvoiceMarking({ invoice_marking: '  4500012345 ' })).toBe('4500012345')
  })

  it.each([null, undefined, {}, { invoice_marking: null }, { invoice_marking: '   ' }])(
    'is null without a value (%j)',
    (customer) => {
      expect(customerInvoiceMarking(customer)).toBeNull()
    },
  )
})

describe('invoiceMarkingForNewInvoice', () => {
  const customer = { invoice_marking: '4500012345' }

  it('keeps what the caller states', () => {
    expect(invoiceMarkingForNewInvoice('Projekt Norr', customer)).toBe('Projekt Norr')
  })

  it.each([undefined, null, '', '   '])('takes the card value when the caller states nothing (%j)', (stated) => {
    expect(invoiceMarkingForNewInvoice(stated, customer)).toBe('4500012345')
  })

  it('is null when neither has one', () => {
    expect(invoiceMarkingForNewInvoice('', { invoice_marking: null })).toBeNull()
    expect(invoiceMarkingForNewInvoice(undefined, null)).toBeNull()
  })
})
