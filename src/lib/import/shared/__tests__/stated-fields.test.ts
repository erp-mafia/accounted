import { describe, it, expect } from 'vitest'
import { checkCountryConsistency } from '@/lib/vat/country-codes'
import { saysOnlyCompany, statedType, typeAndCountryForUpdate, updateWritesType } from '../stated-fields'

describe('saysOnlyCompany', () => {
  it.each(['Företag', 'foretag', ' BUSINESS '])('reads %s as a company of no named kind', (cell) => {
    expect(saysOnlyCompany(cell)).toBe(true)
  })

  it.each([null, '', 'AB', 'EU', 'Privat'])('does not read %s so', (cell) => {
    expect(saysOnlyCompany(cell)).toBe(false)
  })
})

describe('statedType', () => {
  it('is business for a word for any company, also where the register reads a kind from it', () => {
    expect(statedType(true, true)).toBe('business')
    expect(statedType(true, false)).toBe('business')
  })

  it('is type for a cell the register reads a type from, and null for none', () => {
    expect(statedType(false, true)).toBe('type')
    expect(statedType(false, false)).toBeNull()
  })
})

describe('updateWritesType', () => {
  it('writes a type the row names', () => {
    expect(updateWritesType('type', 'eu_business')).toBe(true)
  })

  it('writes a bare company over a private person only', () => {
    expect(updateWritesType('business', 'individual')).toBe(true)
    expect(updateWritesType('business', 'eu_business')).toBe(false)
    expect(updateWritesType('business', 'swedish_business')).toBe(false)
  })

  it('never writes a type the row does not state', () => {
    expect(updateWritesType(null, 'individual')).toBe(false)
    expect(updateWritesType(null, 'eu_business')).toBe(false)
  })
})

describe('typeAndCountryForUpdate', () => {
  // A pair breaks the rule when it is written and disagrees.
  const pairRule = (type: string, country: string, writes: boolean) =>
    writes ? checkCountryConsistency({ partyType: type, country }) : null
  const eu = { type: 'eu_business', country: 'DE' }
  const swedish = { type: 'swedish_business', country: 'SE' }
  const row = (over: Partial<Parameters<typeof typeAndCountryForUpdate>[0]>) => ({
    type: 'swedish_business', type_stated: null, country: 'SE', country_stated: false, ...over,
  })

  it('writes nothing the row does not state', () => {
    expect(typeAndCountryForUpdate(row({}), eu, pairRule)).toEqual({ write: {} })
    expect(typeAndCountryForUpdate(row({ type_stated: 'business' }), eu, pairRule)).toEqual({ write: {} })
  })

  it('writes what the row states when the pair agrees', () => {
    expect(typeAndCountryForUpdate(row({ country: 'AT', country_stated: true, type: 'eu_business' }), eu, pairRule))
      .toEqual({ write: { country: 'AT' } })
  })

  it('takes the type the row reads from a stated country the record\'s type cannot have', () => {
    expect(typeAndCountryForUpdate(row({ type: 'eu_business', country: 'DE', country_stated: true }), swedish, pairRule))
      .toEqual({ write: { type: 'eu_business', country: 'DE' } })
  })

  it('takes the country the row reads for a type it names in place of the record\'s', () => {
    expect(typeAndCountryForUpdate(row({ type_stated: 'type' }), eu, pairRule))
      .toEqual({ write: { type: 'swedish_business', country: 'SE' } })
  })

  it('never fills a private person in from a stated country', () => {
    const update = typeAndCountryForUpdate(row({ type: 'individual', country: 'DE', country_stated: true }), swedish, pairRule)
    expect(update).toEqual({ broken: 'SWEDISH_BUSINESS_REQUIRES_SE', stated: { country: 'DE' } })
  })

  it('answers what breaks, beside what the row states, when its own reading cannot make the pair agree', () => {
    expect(typeAndCountryForUpdate(row({ type_stated: 'type', country: 'DE', country_stated: true }), eu, pairRule))
      .toEqual({ broken: 'SWEDISH_BUSINESS_REQUIRES_SE', stated: { type: 'swedish_business', country: 'DE' } })
    expect(typeAndCountryForUpdate(row({ type: 'eu_business', type_stated: 'type' }), swedish, pairRule))
      .toEqual({ broken: 'EU_BUSINESS_COUNTRY_IS_SE', stated: { type: 'eu_business' } })
  })
})
