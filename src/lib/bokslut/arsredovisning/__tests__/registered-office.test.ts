import { describe, expect, it } from 'vitest'
import {
  REGISTERED_OFFICE_FALLS_BACK_TO_CITY,
  registeredOfficeFallbackWarning,
  resolveRegisteredOffice,
} from '../registered-office'

describe('resolveRegisteredOffice', () => {
  it('prints the säte, not the postal town, when both are set', () => {
    expect(resolveRegisteredOffice({ registered_office: 'Sateskommunen', city: 'Postorten' })).toEqual({
      value: 'Sateskommunen',
      fromCity: false,
    })
  })

  it('falls back to the postal town, flagged, while the säte is unknown (founder default)', () => {
    expect(REGISTERED_OFFICE_FALLS_BACK_TO_CITY).toBe(true)
    expect(resolveRegisteredOffice({ registered_office: null, city: 'Postorten' })).toEqual({
      value: 'Postorten',
      fromCity: true,
    })
    expect(resolveRegisteredOffice({ registered_office: '  ', city: ' Postorten ' })).toEqual({
      value: 'Postorten',
      fromCity: true,
    })
  })

  it('resolves to null with the fallback switched off, so completeness blocks', () => {
    expect(resolveRegisteredOffice({ registered_office: null, city: 'Postorten' }, false)).toEqual({
      value: null,
      fromCity: false,
    })
  })

  it('is null when neither is known', () => {
    expect(resolveRegisteredOffice(null)).toEqual({ value: null, fromCity: false })
    expect(resolveRegisteredOffice({ registered_office: '', city: '' })).toEqual({ value: null, fromCity: false })
  })
})

describe('registeredOfficeFallbackWarning', () => {
  it('names the postal town and where to set the säte', () => {
    const warning = registeredOfficeFallbackWarning('Postorten')
    expect(warning).toContain('(Postorten)')
    expect(warning).toContain('Inställningar → Företag')
  })
})
