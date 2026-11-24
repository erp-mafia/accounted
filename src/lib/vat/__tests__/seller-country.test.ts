import { describe, expect, it } from 'vitest'
import { countryFromAddress, looksForeign, sellerCountry, supplierTypeForRegion, swedishVatNumberAbroad } from '../seller-country'

describe('sellerCountry', () => {
  it('reads the VAT number\'s prefix first', () => {
    expect(sellerCountry({ vatNumber: 'IE3668997OH', address: 'San Francisco, CA 94107' })).toEqual({ country: 'IE', region: 'eu', source: 'vat_number' })
    expect(sellerCountry({ vatNumber: 'SE556677889901' })).toEqual({ country: 'SE', region: 'se', source: 'vat_number' })
    expect(sellerCountry({ vatNumber: 'EL094014201' })).toMatchObject({ country: 'GR', region: 'eu' })
  })

  it('takes no country from a value that is not its member state\'s VAT number (crm#1411)', () => {
    // A US seller's VAT-code label: the SE prefix made the seller Swedish, and the purchase Swedish input VAT.
    expect(sellerCountry({ vatNumber: 'SESL000D', address: '101 Townsend St, San Francisco, CA 94107' })).toEqual({
      country: 'US',
      region: 'non_eu',
      source: 'address',
    })
    expect(sellerCountry({ vatNumber: 'SESL000D' })).toEqual({ country: null, region: null, source: null })
    expect(sellerCountry({ vatNumber: 'SE5566778899', orgNumber: '5566778899' })).toMatchObject({ country: 'SE', source: 'org_number' })
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

// A Swedish VAT number does not make a seller Swedish when the document's
// address names another country: a business established abroad can register
// for VAT here, and whether it is established here for the sale (ML 2023:200
// 16 kap. 4 §) decides who owes the VAT (16 kap. 9 §). The person says.
describe('a Swedish VAT number beside an address abroad', () => {
  const singapore = { vatNumber: 'SE502012345601', address: '1 Example Road\nSingapore 123456\nSingapore' }

  it('decides no country', () => {
    expect(sellerCountry(singapore)).toEqual({ country: null, region: null, source: null })
    expect(sellerCountry({ ...singapore, iban: 'SE45 5000 0000 0583 9825 7466' })).toEqual({ country: null, region: null, source: null })
  })

  it('names the address\'s country', () => {
    expect(swedishVatNumberAbroad(singapore)).toBe('SG')
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address: 'One Microsoft Place, Dublin 18, Ireland' })).toBe('IE')
  })

  it('leaves a Swedish VAT number with a Swedish address, or none, Swedish', () => {
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Storgatan 1, 111 22 Stockholm, Sverige' })).toBeNull()
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Storgatan 1, 111 22 Stockholm' })).toBeNull()
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901' })).toBeNull()
    expect(sellerCountry({ vatNumber: 'SE556677889901', address: 'Storgatan 1, 111 22 Stockholm' })).toEqual({ country: 'SE', region: 'se', source: 'vat_number' })
  })

  it('reads the country code a Peppol delivery ends the address with', () => {
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address: 'Hauptstr. 1, 10117 Berlin, DE' })).toBe('DE')
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Storgatan 1, 111 22 Stockholm' })).toBeNull()
  })

  it('takes no country inside a Swedish address: a person, a street, or a country after Sweden', () => {
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'c/o Israel Andersson, Storgatan 1, 111 22 Stockholm' })).toBeNull()
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Danmark 1, 755 91 Uppsala' })).toBeNull()
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Mässans gata 1, 411 19 Göteborg, Sweden. Offices in Oslo, Norway' })).toBeNull()
    expect(sellerCountry({ vatNumber: 'SE556677889901', address: 'c/o Israel Andersson, Storgatan 1, 111 22 Stockholm' })).toEqual({
      country: 'SE',
      region: 'se',
      source: 'vat_number',
    })
  })

  it('lets a postcode follow the country, letters in it included', () => {
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address: 'Example Strasse 2, Berlin, Germany 10117' })).toBe('DE')
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address: '10 Example Road, London, United Kingdom SW1A 1AA' })).toBe('GB')
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address: '1 Example Street, Dublin, Ireland D02 X285' })).toBe('IE')
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address: 'Voorbeeldstraat 1, Amsterdam, Netherlands 1011 AB.' })).toBe('NL')
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address: '1 Example Way\nCupertino, CA\nUSA 95014-2083' })).toBe('US')
  })

  it('takes no prose after a country for a postcode', () => {
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Storgatan 1, 111 22 Stockholm, Norge AB' })).toBeNull()
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Kina 5 12345 Ankeby' })).toBeNull()
  })

  // Countries the pickers do not list, their own names, and the short forms
  // addresses print: each still read a Swedish seller and let its VAT be deducted.
  it.each([
    ['10 Example Street, London EC1A 1BB, UK', 'GB'],
    ['Office 1, Example Tower, Dubai, UAE', 'AE'],
    ['1 Example Road, Central, Hong Kong SAR', 'HK'],
    ['Voorbeeldstraat 1, 1011 AB Amsterdam, Nederland', 'NL'],
    ['Calle Ejemplo 1, 28001 Madrid, España', 'ES'],
    ['ul. Przykładowa 1, 00-001 Warszawa, Polska', 'PL'],
    ['1 Jalan Contoh, 50000 Kuala Lumpur, Malaysia', 'MY'],
    ['1 Example Road, Taipei 110, Taiwan', 'TW'],
    ['1 Example Street, Riyadh 12345, Saudi Arabia', 'SA'],
    ['1 Example Street, Doha, Qatar', 'QA'],
    ['1 Example Street, 10117 Berlin, DEUTSCHLAND', 'DE'],
  ])('reads %s as abroad', (address, country) => {
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address })).toBe(country)
    expect(sellerCountry({ vatNumber: 'SE502012345601', address })).toEqual({ country: null, region: null, source: null })
  })

  it('reads the country before a phone number, an e-mail or a web address that ends the address', () => {
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address: '1 Example Road, Singapore 123456, Tel +65 6123 4567' })).toBe('SG')
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address: '1 Example Road\nSingapore 123456\n+65 6123 4567' })).toBe('SG')
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address: '1 Example Road, Kuala Lumpur, Malaysia\nbilling@example.com\nwww.example.com' })).toBe('MY')
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address: '1 Example Street, Tel Aviv, Israel' })).toBe('IL')
  })

  it.each([
    ['Example Ltd, Tel: +44 20 7946 0000, London, UK', 'GB'],
    ['1 Example Road, Singapore 123456, Ph. +65 6123 4567', 'SG'],
    ['1 Example Road, Kuala Lumpur, Malaysia, Email: billing@example.com', 'MY'],
    ['1 Example Road, Kuala Lumpur, Malaysia\nVAT: SE502012345601', 'MY'],
    ['10 Example Street, London, U.K.', 'GB'],
    ['Office 1, Dubai, U.A.E.', 'AE'],
    ['Beispielstrasse 1, 8001 Zürich, Schweiz/Suisse', 'CH'],
    ['Rue Exemple 1, 1000 Bruxelles, Belgique', 'BE'],
    ['Eksempelveien 1, 0150 Oslo, Norway (NO)', 'NO'],
    ['Beispielstr. 1, 10117 Berlin, Germany - DE', 'DE'],
  ])('reads %s, its country among contact details or written twice', (address, country) => {
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address })).toBe(country)
  })

  it('takes no floor, giro or box beside a number for a country code', () => {
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Kungsgatan 12, 4 tr' })).toBeNull()
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Storgatan 1, 111 22 Stockholm, 2 tr' })).toBeNull()
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Storgatan 1, 111 22 Stockholm, BG 5050-1055' })).toBeNull()
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Storgatan 1, 111 22 Stockholm, PG 12 34 56-7' })).toBeNull()
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Storgatan 1, Pl 3' })).toBeNull()
    expect(sellerCountry({ vatNumber: 'SE556677889901', address: 'Kungsgatan 12, 4 tr' })).toEqual({ country: 'SE', region: 'se', source: 'vat_number' })
  })

  it('still takes no country from a Swedish address that ends in contact details or a town', () => {
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Storgatan 1, 111 22 Stockholm, Tel 08-123 45 67' })).toBeNull()
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Storgatan 1, Stockholm, 111 22' })).toBeNull()
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Storgatan 1, 111 22 Stockholm, info@example.se' })).toBeNull()
    expect(swedishVatNumberAbroad({ vatNumber: 'SE556677889901', address: 'Box 1, 755 91 Uppsala, SE' })).toBeNull()
  })

  it('is about a Swedish number only: another state\'s number keeps its country', () => {
    expect(swedishVatNumberAbroad({ vatNumber: 'IE3668997OH', address: 'San Francisco, CA 94107' })).toBeNull()
    expect(sellerCountry({ vatNumber: 'IE3668997OH', address: 'San Francisco, CA 94107' })).toMatchObject({ country: 'IE', source: 'vat_number' })
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
    // Georgia before a ZIP is the state, never the country.
    expect(countryFromAddress('1 Example St, Atlanta, Georgia 30303')).toBe('US')
    expect(swedishVatNumberAbroad({ vatNumber: 'SE502012345601', address: '1 Example St, Atlanta, Georgia 30303' })).toBe('US')
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
