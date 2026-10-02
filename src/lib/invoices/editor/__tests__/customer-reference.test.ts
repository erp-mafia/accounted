import { describe, it, expect } from 'vitest'
import { planYourReferencePrefill } from '../customer-reference'

describe('planYourReferencePrefill', () => {
  it('fills an empty field with the customer card contact person', () => {
    expect(planYourReferencePrefill({ current: '', prefilled: null, contactPerson: 'Karin Ek' })).toEqual({
      value: 'Karin Ek',
      prefilled: 'Karin Ek',
    })
  })

  it('trims the contact person and leaves an empty field empty when there is none', () => {
    expect(planYourReferencePrefill({ current: '', prefilled: null, contactPerson: '  Karin Ek ' }).value).toBe('Karin Ek')
    expect(planYourReferencePrefill({ current: '', prefilled: null, contactPerson: null })).toEqual({
      value: '',
      prefilled: null,
    })
    expect(planYourReferencePrefill({ current: undefined, prefilled: null, contactPerson: '   ' })).toEqual({
      value: '',
      prefilled: null,
    })
  })

  it('replaces its own prefill when the customer changes before the user edits it', () => {
    expect(planYourReferencePrefill({ current: 'Karin Ek', prefilled: 'Karin Ek', contactPerson: 'Per Lind' })).toEqual({
      value: 'Per Lind',
      prefilled: 'Per Lind',
    })
  })

  it('clears its own prefill when the new customer has no contact person, or none is picked', () => {
    expect(planYourReferencePrefill({ current: 'Karin Ek', prefilled: 'Karin Ek', contactPerson: '' })).toEqual({
      value: '',
      prefilled: null,
    })
    expect(planYourReferencePrefill({ current: 'Karin Ek', prefilled: 'Karin Ek', contactPerson: null })).toEqual({
      value: '',
      prefilled: null,
    })
  })

  it('never overwrites what the user typed, and stops tracking the prefill', () => {
    expect(planYourReferencePrefill({ current: 'Karin Ek, Lars', prefilled: 'Karin Ek', contactPerson: 'Per Lind' })).toEqual({
      value: 'Karin Ek, Lars',
      prefilled: null,
    })
    expect(planYourReferencePrefill({ current: 'Inköp', prefilled: null, contactPerson: 'Per Lind' })).toEqual({
      value: 'Inköp',
      prefilled: null,
    })
  })

  it('keeps a reference from a copy or a saved draft (nothing prefilled yet)', () => {
    expect(planYourReferencePrefill({ current: 'Ordernr 77', prefilled: null, contactPerson: 'Karin Ek' }).value).toBe(
      'Ordernr 77',
    )
  })

  it('fills again once the user has emptied the field', () => {
    expect(planYourReferencePrefill({ current: '', prefilled: null, contactPerson: 'Per Lind' })).toEqual({
      value: 'Per Lind',
      prefilled: 'Per Lind',
    })
  })
})
