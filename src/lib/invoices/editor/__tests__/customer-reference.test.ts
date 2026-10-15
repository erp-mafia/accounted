import { describe, it, expect } from 'vitest'
import { customerCardReference, customerChangedForReference, planYourReferencePrefill } from '../customer-reference'

describe('planYourReferencePrefill', () => {
  it('fills an empty field with the customer card contact person', () => {
    expect(planYourReferencePrefill({ current: '', prefilled: null, customerReference: 'Karin Ek' })).toEqual({
      value: 'Karin Ek',
      prefilled: 'Karin Ek',
    })
  })

  it('trims the contact person and leaves an empty field empty when there is none', () => {
    expect(planYourReferencePrefill({ current: '', prefilled: null, customerReference: '  Karin Ek ' }).value).toBe('Karin Ek')
    expect(planYourReferencePrefill({ current: '', prefilled: null, customerReference: null })).toEqual({
      value: '',
      prefilled: null,
    })
    expect(planYourReferencePrefill({ current: undefined, prefilled: null, customerReference: '   ' })).toEqual({
      value: '',
      prefilled: null,
    })
  })

  it('replaces its own prefill when the customer changes before the user edits it', () => {
    expect(planYourReferencePrefill({ current: 'Karin Ek', prefilled: 'Karin Ek', customerReference: 'Per Lind' })).toEqual({
      value: 'Per Lind',
      prefilled: 'Per Lind',
    })
  })

  it('clears its own prefill when the new customer has no contact person, or none is picked', () => {
    expect(planYourReferencePrefill({ current: 'Karin Ek', prefilled: 'Karin Ek', customerReference: '' })).toEqual({
      value: '',
      prefilled: null,
    })
    expect(planYourReferencePrefill({ current: 'Karin Ek', prefilled: 'Karin Ek', customerReference: null })).toEqual({
      value: '',
      prefilled: null,
    })
  })

  it('never overwrites what the user typed, and stops tracking the prefill', () => {
    expect(planYourReferencePrefill({ current: 'Karin Ek, Lars', prefilled: 'Karin Ek', customerReference: 'Per Lind' })).toEqual({
      value: 'Karin Ek, Lars',
      prefilled: null,
    })
    expect(planYourReferencePrefill({ current: 'Inköp', prefilled: null, customerReference: 'Per Lind' })).toEqual({
      value: 'Inköp',
      prefilled: null,
    })
  })

  it('keeps a reference from a copy or a saved draft (nothing prefilled yet)', () => {
    expect(planYourReferencePrefill({ current: 'Ordernr 77', prefilled: null, customerReference: 'Karin Ek' }).value).toBe(
      'Ordernr 77',
    )
  })

  it('fills again once the user has emptied the field', () => {
    expect(planYourReferencePrefill({ current: '', prefilled: null, customerReference: 'Per Lind' })).toEqual({
      value: 'Per Lind',
      prefilled: 'Per Lind',
    })
  })
})

describe('customerChangedForReference', () => {
  it('plans again only for a different customer than the one the field followed', () => {
    expect(customerChangedForReference(null, 'cust-a')).toBe(true)
    expect(customerChangedForReference('cust-a', 'cust-b')).toBe(true)
    expect(customerChangedForReference('cust-a', null)).toBe(true)
  })

  it('ignores a refreshed customer list for the same customer, so an emptied field stays empty', () => {
    expect(customerChangedForReference('cust-a', 'cust-a')).toBe(false)
  })

  it('treats no customer and an empty id alike', () => {
    expect(customerChangedForReference(null, '')).toBe(false)
    expect(customerChangedForReference(undefined, null)).toBe(false)
  })
})

describe('customerCardReference', () => {
  it('prefers the Fakturareferens over the contact person (crm#1200)', () => {
    expect(customerCardReference({ invoice_reference: ' KST 4410 ', contact_person: 'Karin Ek' })).toBe('KST 4410')
  })

  it('falls back to the contact person, as before the field existed', () => {
    expect(customerCardReference({ invoice_reference: null, contact_person: ' Karin Ek ' })).toBe('Karin Ek')
    expect(customerCardReference({ invoice_reference: '  ', contact_person: 'Karin Ek' })).toBe('Karin Ek')
    expect(customerCardReference({ contact_person: 'Karin Ek' })).toBe('Karin Ek')
  })

  it('is null without either, or without a customer', () => {
    expect(customerCardReference({ invoice_reference: null, contact_person: null })).toBeNull()
    expect(customerCardReference(null)).toBeNull()
  })

  it('feeds the plan: a fresh form takes the Fakturareferens', () => {
    const customerReference = customerCardReference({ invoice_reference: 'KST 4410', contact_person: 'Karin Ek' })
    expect(planYourReferencePrefill({ current: '', prefilled: null, customerReference })).toEqual({
      value: 'KST 4410',
      prefilled: 'KST 4410',
    })
  })
})
