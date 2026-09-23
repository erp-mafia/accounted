import { describe, it, expect } from 'vitest'
import { pickCompanyName } from '../lib/lookup'

// Lens v2 lists names newest-decided first and types the firma as
// `legalName`; a särskilt företagsnamn is `particularName`. PH#80: an AB
// that registered a särskilt företagsnamn after its firma was created under
// the brand name because the picker fell back to index 0.
describe('pickCompanyName', () => {
  it('prefers the legal name over a newer särskilt företagsnamn', () => {
    expect(
      pickCompanyName([
        { nameOrIdentifier: 'Newest Brand', companyNamingType: 'particularName' },
        { nameOrIdentifier: 'Older Brand', companyNamingType: 'particularName' },
        { nameOrIdentifier: 'Firma AB', companyNamingType: 'legalName' },
      ]),
    ).toBe('Firma AB')
  })

  it('accepts the v1 `name` type when no legalName entry exists', () => {
    expect(
      pickCompanyName([
        { nameOrIdentifier: 'Brand', companyNamingType: 'particularName' },
        { nameOrIdentifier: 'Firma AB', companyNamingType: 'name' },
      ]),
    ).toBe('Firma AB')
  })

  it('skips particular names before falling back to the first entry', () => {
    expect(
      pickCompanyName([
        { nameOrIdentifier: 'Brand', companyNamingType: 'particularName' },
        { nameOrIdentifier: 'Something Else', companyNamingType: 'registeredName' },
      ]),
    ).toBe('Something Else')
    expect(
      pickCompanyName([{ nameOrIdentifier: 'Only Brand', companyNamingType: 'particularName' }]),
    ).toBe('Only Brand')
  })

  it('returns an empty string for an empty list', () => {
    expect(pickCompanyName([])).toBe('')
  })
})
