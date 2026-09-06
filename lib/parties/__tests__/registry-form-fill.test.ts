import { describe, it, expect } from 'vitest'
import { describeFilledFields, registryFormFill, registryLookupKey, type RegistryFormFields, type RegistryLookupFound } from '../registry-form-fill'
import type { RegistrySummary } from '../registry-summary'

function summary(over: Partial<RegistrySummary> = {}): RegistrySummary {
  return {
    legal_name: 'WEBHALLEN SVERIGE AB',
    legal_form: 'Aktiebolag',
    status: { label: 'Verksamt', active: true },
    warning: null,
    registrations: { f_tax: true, vat: true, employer: true },
    industry: null,
    seat: 'Stockholm',
    registered_at: null,
    active_since: null,
    active_until: null,
    employees_band: null,
    turnover: null,
    workplaces: null,
    contact: { email: null, phone: null, address: { co: null, street: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm' } },
    vat_number: 'SE556252915501',
    fetched_at: '2026-09-06T10:00:00Z',
    ...over,
  }
}

function found(over: Partial<RegistryLookupFound> = {}, summaryOver: Partial<RegistrySummary> = {}): RegistryLookupFound {
  return { found: true, orgNumber: '5562529155', name: 'Webhallen Sverige AB', registry: summary(summaryOver), ...over }
}

const empty: RegistryFormFields = { name: '', email: '', phone: '', address_line1: '', address_line2: '', postal_code: '', city: '', vat_number: '' }

describe('registryLookupKey', () => {
  it('returns the canonical ten digits for a Swedish legal person, however written', () => {
    expect(registryLookupKey('5562529155')).toBe('5562529155')
    expect(registryLookupKey('556252-9155')).toBe('5562529155')
    expect(registryLookupKey('16 556252-9155')).toBe('5562529155')
    expect(registryLookupKey('165562529155')).toBe('5562529155')
  })

  it('is null while the number is incomplete or its check digit is wrong', () => {
    expect(registryLookupKey('')).toBeNull()
    expect(registryLookupKey(null)).toBeNull()
    expect(registryLookupKey('556252-915')).toBeNull()
    expect(registryLookupKey('5562529156')).toBeNull()
    expect(registryLookupKey('abc')).toBeNull()
  })

  it('never yields a key for a personnummer, even with a valid check digit', () => {
    // 800101-1231 is Luhn-valid: the refusal is about shape, not the check digit.
    expect(registryLookupKey('8001011231')).toBeNull()
    expect(registryLookupKey('800101-1231')).toBeNull()
    expect(registryLookupKey('198001011231')).toBeNull()
  })
})

describe('registryFormFill', () => {
  it('fills name, VAT number and address on an empty form', () => {
    expect(registryFormFill(empty, found(), null)).toEqual({
      name: 'Webhallen Sverige AB',
      vat_number: 'SE556252915501',
      address_line1: 'Storgatan 1',
      address_line2: '',
      postal_code: '111 22',
      city: 'Stockholm',
    })
  })

  it('never replaces a value the person typed', () => {
    const typed = { ...empty, name: 'Webhallen (butiken)', vat_number: 'SE999999999901' }
    const patch = registryFormFill(typed, found(), null)
    expect(patch.name).toBeUndefined()
    expect(patch.vat_number).toBeUndefined()
    expect(patch.address_line1).toBe('Storgatan 1')
  })

  it('leaves the whole address alone when any part of it was typed', () => {
    const patch = registryFormFill({ ...empty, city: 'Uppsala' }, found(), null)
    expect(patch).toEqual({ name: 'Webhallen Sverige AB', vat_number: 'SE556252915501' })
  })

  it('replaces its own earlier fill when the number is corrected', () => {
    const first = found()
    const afterFirst: RegistryFormFields = { ...empty, ...registryFormFill(empty, first, null) } as RegistryFormFields
    const second = found(
      { orgNumber: '5560125790', name: 'Beijer Byggmaterial AB' },
      { legal_name: 'BEIJER BYGGMATERIAL AB', vat_number: 'SE556012579001', contact: { email: null, phone: null, address: { co: null, street: 'Norra vägen 5', postal_code: '169 70', city: 'Solna' } } },
    )
    expect(registryFormFill(afterFirst, second, first)).toEqual({
      name: 'Beijer Byggmaterial AB',
      vat_number: 'SE556012579001',
      address_line1: 'Norra vägen 5',
      address_line2: '',
      postal_code: '169 70',
      city: 'Solna',
    })
  })

  it('keeps a name the person changed after the first fill', () => {
    const first = found()
    const edited: RegistryFormFields = { ...empty, ...registryFormFill(empty, first, null), name: 'Webhallen' } as RegistryFormFields
    const second = found({ orgNumber: '5560125790', name: 'Beijer Byggmaterial AB' }, { legal_name: 'BEIJER BYGGMATERIAL AB' })
    expect(registryFormFill(edited, second, first).name).toBeUndefined()
  })

  it('puts a c/o on line 1 and the street on line 2, as on the row', () => {
    const patch = registryFormFill(empty, found({}, { contact: { email: null, phone: null, address: { co: 'c/o Byrån AB', street: 'Box 12', postal_code: '111 22', city: 'Stockholm' } } }), null)
    expect(patch.address_line1).toBe('c/o Byrån AB')
    expect(patch.address_line2).toBe('Box 12')
  })

  it('fills e-mail and phone when the register has them', () => {
    const patch = registryFormFill(empty, found({}, { contact: { email: 'info@webhallen.com', phone: '08-123 45 67', address: null } }), null)
    expect(patch).toEqual({ name: 'Webhallen Sverige AB', vat_number: 'SE556252915501', email: 'info@webhallen.com', phone: '08-123 45 67' })
  })

  it('touches nothing when the form already holds what the register says', () => {
    const filled: RegistryFormFields = { ...empty, ...registryFormFill(empty, found(), null) } as RegistryFormFields
    expect(registryFormFill(filled, found(), null)).toEqual({})
  })

  it('does not fill a field the form does not show', () => {
    const patch = registryFormFill(empty, found(), null, ['name', 'address_line1', 'address_line2', 'postal_code', 'city'])
    expect(patch.vat_number).toBeUndefined()
    expect(patch.name).toBe('Webhallen Sverige AB')
    expect(patch.city).toBe('Stockholm')
  })

  it('does nothing without a legal name or VAT number in the register', () => {
    expect(registryFormFill(empty, found({ name: '' }, { legal_name: null, vat_number: null, contact: { email: null, phone: null, address: null } }), null)).toEqual({})
  })
})

describe('describeFilledFields', () => {
  it('collapses the address columns into one item in a fixed order', () => {
    expect(describeFilledFields(['city', 'vat_number', 'postal_code', 'name', 'address_line1'])).toEqual(['name', 'address', 'vat_number'])
    expect(describeFilledFields(['phone', 'email'])).toEqual(['email', 'phone'])
    expect(describeFilledFields([])).toEqual([])
  })
})
