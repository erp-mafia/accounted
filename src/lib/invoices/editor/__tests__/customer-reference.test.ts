import { describe, it, expect } from 'vitest'
import {
  cardEditReplans,
  customerCardReference,
  customerChangedForReference,
  planMarkingPrefill,
  planYourReferencePrefill,
} from '../customer-reference'

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

describe('planMarkingPrefill (crm#1477)', () => {
  it("fills an empty field with the card's Märkning", () => {
    expect(planMarkingPrefill({ current: '', prefilled: null, customer: { invoice_marking: ' 4500012345 ' } })).toEqual({
      value: '4500012345',
      prefilled: '4500012345',
    })
  })

  it('replaces its own value on a customer switch, and clears it for a customer without one', () => {
    expect(
      planMarkingPrefill({ current: '4500012345', prefilled: '4500012345', customer: { invoice_marking: '4500067890' } }),
    ).toEqual({ value: '4500067890', prefilled: '4500067890' })
    expect(planMarkingPrefill({ current: '4500012345', prefilled: '4500012345', customer: { invoice_marking: null } })).toEqual({
      value: '',
      prefilled: null,
    })
  })

  it('never overwrites what the user typed', () => {
    expect(planMarkingPrefill({ current: 'Projekt Norr', prefilled: null, customer: { invoice_marking: '4500012345' } })).toEqual({
      value: 'Projekt Norr',
      prefilled: null,
    })
  })

  it('takes nothing from the contact person', () => {
    expect(planMarkingPrefill({ current: '', prefilled: null, customer: { contact_person: 'Karin Ek' } as never })).toEqual({
      value: '',
      prefilled: null,
    })
  })
})

describe('cardEditReplans', () => {
  const card = { invoice_reference: 'PO-778', contact_person: 'Karin Ek', invoice_marking: '4500012345' }

  it('plans neither again when the save left both sources alone', () => {
    expect(cardEditReplans(card, { ...card })).toEqual({ reference: false, marking: false })
  })

  it('plans Er referens again only when its Fakturareferens changed', () => {
    expect(cardEditReplans(card, { ...card, invoice_reference: 'PO-779' })).toEqual({ reference: true, marking: false })
  })

  it('follows the contact person only while the card has no Fakturareferens', () => {
    expect(cardEditReplans(card, { ...card, contact_person: 'Per Lind' }).reference).toBe(false)
    const noReference = { ...card, invoice_reference: null }
    expect(cardEditReplans(noReference, { ...noReference, contact_person: 'Per Lind' }).reference).toBe(true)
  })

  it('plans Märkning again only when the card Märkning changed', () => {
    expect(cardEditReplans(card, { ...card, invoice_marking: '4500067890' })).toEqual({ reference: false, marking: true })
    expect(cardEditReplans(card, { ...card, invoice_marking: null })).toEqual({ reference: false, marking: true })
  })

  it('reads blank and surrounding space as no change', () => {
    expect(cardEditReplans(card, { ...card, invoice_reference: ' PO-778 ', invoice_marking: '4500012345 ' })).toEqual({
      reference: false,
      marking: false,
    })
    expect(cardEditReplans({ invoice_marking: '' }, { invoice_marking: null }).marking).toBe(false)
  })
})
