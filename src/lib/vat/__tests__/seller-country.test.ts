import { describe, expect, it } from 'vitest'
import { countryFromAddress, looksForeign, sellerCountry, supplierTypeForRegion } from '../seller-country'

describe('sellerCountry', () => {
  it('reads the VAT number\'s prefix first', () => {
    expect(sellerCountry({ vatNumber: 'IE3668997OH', address: 'San Francisco, CA 94107' })).toEqual({ country: 'IE', region: 'eu', source: 'vat_number' })
    expect(sellerCountry({ vatNumber: 'SE556677889901' })).toEqual({ country: 'SE', region: 'se', source: 'vat_number' })
    expect(sellerCountry({ vatNumber: 'EL094014201' })).toMatchObject({ country: 'GR', region: 'eu' })
  })

  it('counts the United Kingdom, Norway and Switzerland outside the EU', () => {
    expect(sellerCountry({ vatNumber: 'GB123456789' }).region).toBe('non_eu')
    expect(sellerCountry({ vatNumber: 'NO923609016MVA' }).region).toBe('non_eu')
    expect(sellerCountry({ vatNumber: 'XI123456789' })).toMatchObject({ country: 'GB', region: 'non_eu' })
    expect(sellerCountry({ iban: 'CH93 0076 2011 6238 5295 7' })).toMatchObject({ country: 'CH', region: 'non_eu', source: 'iban' })
  })

  it('then the IBAN, then a Swedish org number', () => {
    expect(sellerCountry({ iban: 'DE89 3704 0044 0532 0130 00', orgNumber: '5566778899' })).toMatchObject({ country: 'DE', source: 'iban' })
    expect(sellerCountry({ orgNumber: '556677-8899', address: '1 Main St, Dublin, Ireland' })).toEqual({ country: 'SE', region: 'se', source: 'org_number' })
  })

  it('then the address', () => {
    expect(sellerCountry({ address: '2261 Market Street #4512, San Francisco, CA 94114' })).toEqual({ country: 'US', region: 'non_eu', source: 'address' })
    expect(sellerCountry({ address: 'Unter den Linden 77, 10117 Berlin, Tyskland' })).toMatchObject({ country: 'DE', region: 'eu' })
  })

  it('answers nothing when nothing names a country', () => {
    expect(sellerCountry({ address: 'Box 12' })).toEqual({ country: null, region: null, source: null })
    expect(sellerCountry(null)).toEqual({ country: null, region: null, source: null })
  })
})

describe('countryFromAddress', () => {
  it('lets the last country named win', () => {
    expect(countryFromAddress('Ireland Road 4, London, United Kingdom')).toBe('GB')
  })

  it('never counts a name inside a longer one', () => {
    expect(countryFromAddress('1 Harbour Lane, Belfast, Northern Ireland')).toBe('GB')
  })

  it('reads a US state by its two letters before a ZIP, or by name', () => {
    expect(countryFromAddress('500 Howard St, San Francisco, CA 94105-3000')).toBe('US')
    expect(countryFromAddress('100 Congress Ave, Austin, Texas 78701')).toBe('US')
    expect(countryFromAddress('Washington Street 4')).toBeNull()
  })

  it('reads Swedish and English names', () => {
    expect(countryFromAddress('Storgatan 1, 111 22 Stockholm, Sverige')).toBe('SE')
    expect(countryFromAddress('Karl Johans gate 1, Oslo, Norge')).toBe('NO')
    expect(countryFromAddress('Rue de Rivoli 1, Paris, France')).toBe('FR')
  })
})

describe('looksForeign', () => {
  it('a foreign currency or an address that does not read Swedish', () => {
    expect(looksForeign({ currency: 'USD' })).toBe(true)
    expect(looksForeign({ currency: 'SEK', address: '12 Harbour Road, Unit 4' })).toBe(true)
  })

  it('a kronor document with a Swedish address, or none', () => {
    expect(looksForeign({ currency: 'SEK', address: 'Storgatan 1, 111 22 Stockholm' })).toBe(false)
    expect(looksForeign({ currency: 'SEK', address: 'Drottninggatan 5, Göteborg' })).toBe(false)
    expect(looksForeign({ currency: 'SEK', address: null })).toBe(false)
  })
})

describe('supplierTypeForRegion', () => {
  it('maps the regions onto suppliers.supplier_type', () => {
    expect(supplierTypeForRegion('se')).toBe('swedish_business')
    expect(supplierTypeForRegion('eu')).toBe('eu_business')
    expect(supplierTypeForRegion('non_eu')).toBe('non_eu_business')
  })
})

describe('countryFromAddress: what must not read as a country', () => {
  it('a street named after a country in a US address', () => {
    expect(countryFromAddress('1 Ireland Ave, Boston, MA 02110')).toBe('US')
  })

  it('a US state that contains a country\'s name', () => {
    expect(countryFromAddress('100 Main St, Santa Fe, New Mexico 87501')).toBe('US')
  })

  it('an English island for Iceland', () => {
    expect(countryFromAddress('30-30 Thomson Ave, Long Island City, NY 11101')).toBe('US')
  })

  it('a German postcode with its country prefix for Delaware', () => {
    expect(countryFromAddress('Unter den Linden 77, DE 10117 Berlin')).toBeNull()
  })
})
