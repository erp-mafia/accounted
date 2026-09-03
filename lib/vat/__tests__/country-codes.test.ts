import { describe, it, expect } from 'vitest'
import {
  COUNTRY_OPTIONS,
  checkCountryConsistency,
  countryPermitsReverseCharge,
  defaultCountryForParty,
  getCountryName,
  getCountryOptions,
  isCountryCode,
  normalizeCountryCode,
  vatNumberCountryPrefix,
} from '../country-codes'
import { EU_COUNTRIES } from '../eu-countries'

describe('normalizeCountryCode', () => {
  it('passes a well-formed code through, uppercased and trimmed', () => {
    expect(normalizeCountryCode('SE')).toBe('SE')
    expect(normalizeCountryCode('de')).toBe('DE')
    expect(normalizeCountryCode('  no ')).toBe('NO')
  })

  it('maps the VIES spelling of Greece and the customary UK', () => {
    expect(normalizeCountryCode('EL')).toBe('GR')
    expect(normalizeCountryCode('UK')).toBe('GB')
  })

  it('maps the names the customer form and the v1 API used to write (#2028)', () => {
    expect(normalizeCountryCode('Sweden')).toBe('SE')
    expect(normalizeCountryCode('Sverige')).toBe('SE')
    expect(normalizeCountryCode('Germany')).toBe('DE')
    expect(normalizeCountryCode('GERMANY')).toBe('DE')
    expect(normalizeCountryCode('Tyskland')).toBe('DE')
    expect(normalizeCountryCode('Deutschland')).toBe('DE')
    expect(normalizeCountryCode('Nederländerna')).toBe('NL')
    expect(normalizeCountryCode('United States of America')).toBe('US')
    expect(normalizeCountryCode('U.S.A.')).toBe('US')
    expect(normalizeCountryCode('Norway')).toBe('NO')
  })

  it('maps every Swedish and English name in the option list to its code', () => {
    for (const option of COUNTRY_OPTIONS) {
      expect(normalizeCountryCode(option.name)).toBe(option.code)
      expect(normalizeCountryCode(option.nameEn)).toBe(option.code)
    }
  })

  it('returns null for empty input and anything it does not know', () => {
    expect(normalizeCountryCode(null)).toBeNull()
    expect(normalizeCountryCode(undefined)).toBeNull()
    expect(normalizeCountryCode('')).toBeNull()
    expect(normalizeCountryCode('   ')).toBeNull()
    expect(normalizeCountryCode('Atlantis')).toBeNull()
    expect(normalizeCountryCode('SWE')).toBeNull()
    expect(normalizeCountryCode('S')).toBeNull()
    expect(normalizeCountryCode('SE.')).toBeNull()
  })
})

describe('isCountryCode / getCountryName / getCountryOptions', () => {
  it('recognises only an uppercase alpha-2 as already normalised', () => {
    expect(isCountryCode('SE')).toBe(true)
    expect(isCountryCode('se')).toBe(false)
    expect(isCountryCode('Sweden')).toBe(false)
    expect(isCountryCode(null)).toBe(false)
  })

  it('renders a code in the requested language and falls back to the value', () => {
    expect(getCountryName('DE', 'sv')).toBe('Tyskland')
    expect(getCountryName('DE', 'en')).toBe('Germany')
    expect(getCountryName('Germany', 'sv')).toBe('Tyskland')
    expect(getCountryName('AQ')).toBe('AQ')
    expect(getCountryName('Atlantis')).toBe('Atlantis')
    expect(getCountryName(null)).toBe('')
  })

  it('lists every option once with Sweden first, sorted by the locale name', () => {
    const sv = getCountryOptions('sv')
    expect(sv[0].code).toBe('SE')
    expect(new Set(sv.map((o) => o.code)).size).toBe(COUNTRY_OPTIONS.length)
    const rest = sv.slice(1).map((o) => o.name)
    expect(rest).toEqual([...rest].sort(new Intl.Collator('sv').compare))
    expect(getCountryOptions('en')[0].code).toBe('SE')
  })

  it('offers all 27 EU members', () => {
    const codes = new Set(COUNTRY_OPTIONS.map((o) => o.code))
    for (const eu of EU_COUNTRIES) expect(codes.has(eu.code)).toBe(true)
  })
})

describe('vatNumberCountryPrefix', () => {
  it('reads the leading two letters, ignoring spaces, dots and dashes', () => {
    expect(vatNumberCountryPrefix('DE811234567')).toBe('DE')
    expect(vatNumberCountryPrefix(' de 811 234 567')).toBe('DE')
    expect(vatNumberCountryPrefix('ATU12345678')).toBe('AT')
    expect(vatNumberCountryPrefix('EL123456789')).toBe('EL')
  })

  it('is null without a letter prefix', () => {
    expect(vatNumberCountryPrefix('811234567')).toBeNull()
    expect(vatNumberCountryPrefix('')).toBeNull()
    expect(vatNumberCountryPrefix(null)).toBeNull()
  })
})

describe('defaultCountryForParty', () => {
  it('is SE for Swedish types', () => {
    expect(defaultCountryForParty('swedish_business')).toBe('SE')
    expect(defaultCountryForParty('individual')).toBe('SE')
  })

  it('derives an EU business country from the VAT prefix, EL included', () => {
    expect(defaultCountryForParty('eu_business', 'DE811234567')).toBe('DE')
    expect(defaultCountryForParty('eu_business', 'EL123456789')).toBe('GR')
  })

  it('has nothing to derive for an EU business without a usable prefix', () => {
    expect(defaultCountryForParty('eu_business', '811234567')).toBeNull()
    expect(defaultCountryForParty('eu_business', 'SE556677889901')).toBeNull()
    expect(defaultCountryForParty('eu_business', 'CHE123456789')).toBeNull()
    expect(defaultCountryForParty('eu_business')).toBeNull()
  })

  it('never guesses for a non-EU business', () => {
    expect(defaultCountryForParty('non_eu_business')).toBeNull()
    expect(defaultCountryForParty('non_eu_business', 'GB123456789')).toBeNull()
  })
})

describe('checkCountryConsistency', () => {
  it('accepts the shapes that agree', () => {
    expect(checkCountryConsistency({ partyType: 'swedish_business', country: 'SE' })).toBeNull()
    expect(checkCountryConsistency({ partyType: 'individual', country: 'SE' })).toBeNull()
    expect(checkCountryConsistency({ partyType: 'individual', country: 'NO' })).toBeNull()
    expect(
      checkCountryConsistency({ partyType: 'eu_business', country: 'DE', vatNumber: 'DE811234567' }),
    ).toBeNull()
    expect(
      checkCountryConsistency({ partyType: 'eu_business', country: 'GR', vatNumber: 'EL123456789' }),
    ).toBeNull()
    expect(checkCountryConsistency({ partyType: 'eu_business', country: 'DE', vatNumber: '811234567' })).toBeNull()
    expect(checkCountryConsistency({ partyType: 'eu_business', country: 'DE' })).toBeNull()
    expect(checkCountryConsistency({ partyType: 'non_eu_business', country: 'NO' })).toBeNull()
    expect(checkCountryConsistency({ partyType: 'non_eu_business', country: 'US' })).toBeNull()
  })

  it('refuses the #2025 shape: EU business with land Sverige', () => {
    expect(
      checkCountryConsistency({ partyType: 'eu_business', country: 'SE', vatNumber: 'DE811234567' }),
    ).toBe('EU_BUSINESS_COUNTRY_IS_SE')
    expect(checkCountryConsistency({ partyType: 'eu_business', country: 'Sweden' })).toBe(
      'EU_BUSINESS_COUNTRY_IS_SE',
    )
  })

  it('refuses an EU business outside the EU and a non-EU business inside it', () => {
    expect(checkCountryConsistency({ partyType: 'eu_business', country: 'NO' })).toBe(
      'EU_BUSINESS_REQUIRES_EU_COUNTRY',
    )
    expect(checkCountryConsistency({ partyType: 'non_eu_business', country: 'DE' })).toBe(
      'NON_EU_BUSINESS_REQUIRES_NON_EU_COUNTRY',
    )
    expect(checkCountryConsistency({ partyType: 'non_eu_business', country: 'SE' })).toBe(
      'NON_EU_BUSINESS_REQUIRES_NON_EU_COUNTRY',
    )
  })

  it('refuses a Swedish business abroad', () => {
    expect(checkCountryConsistency({ partyType: 'swedish_business', country: 'DE' })).toBe(
      'SWEDISH_BUSINESS_REQUIRES_SE',
    )
  })

  it('refuses a VAT prefix that names another country than the row', () => {
    expect(
      checkCountryConsistency({ partyType: 'eu_business', country: 'FR', vatNumber: 'DE811234567' }),
    ).toBe('VAT_PREFIX_COUNTRY_MISMATCH')
    expect(
      checkCountryConsistency({ partyType: 'eu_business', country: 'GR', vatNumber: 'GR123456789' }),
    ).toBe('VAT_PREFIX_COUNTRY_MISMATCH')
  })

  it('has nothing to say when the country is missing or unmapped', () => {
    expect(checkCountryConsistency({ partyType: 'eu_business', country: null })).toBeNull()
    expect(checkCountryConsistency({ partyType: 'eu_business', country: '' })).toBeNull()
    expect(checkCountryConsistency({ partyType: 'swedish_business', country: 'Atlantis' })).toBeNull()
  })
})

describe('countryPermitsReverseCharge', () => {
  it('allows an EU member other than Sweden, by code or by legacy name', () => {
    expect(countryPermitsReverseCharge('DE')).toBe(true)
    expect(countryPermitsReverseCharge('Germany')).toBe(true)
    expect(countryPermitsReverseCharge('gr')).toBe(true)
  })

  it('refuses Sweden and countries outside the EU', () => {
    expect(countryPermitsReverseCharge('SE')).toBe(false)
    expect(countryPermitsReverseCharge('Sweden')).toBe(false)
    expect(countryPermitsReverseCharge('NO')).toBe(false)
    expect(countryPermitsReverseCharge('US')).toBe(false)
  })

  it('does not block on an unknown country: that is the consistency check\'s job', () => {
    expect(countryPermitsReverseCharge(null)).toBe(true)
    expect(countryPermitsReverseCharge(undefined)).toBe(true)
    expect(countryPermitsReverseCharge('Deutschland (Bayern)')).toBe(true)
  })
})
