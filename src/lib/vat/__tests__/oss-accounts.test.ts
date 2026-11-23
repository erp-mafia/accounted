import { describe, expect, it } from 'vitest'
import { isOtherEuCountry } from '../eu-countries'
import {
  OSS_ALL_EU_COUNTRIES,
  isOssAccountCountry,
  isOssVatRate,
  ossAccountKind,
  suggestOssAccount,
} from '../oss-accounts'

describe('isOtherEuCountry', () => {
  it('is every member state but Sweden', () => {
    expect(isOtherEuCountry('DE')).toBe(true)
    expect(isOtherEuCountry('fi')).toBe(true)
    expect(isOtherEuCountry('SE')).toBe(false)
    expect(isOtherEuCountry('NO')).toBe(false)
    expect(isOtherEuCountry('GB')).toBe(false)
    expect(isOtherEuCountry('EU')).toBe(false)
  })
})

describe('ossAccountKind', () => {
  it('reads a class 3 account with VAT code OSS as a sales account', () => {
    expect(ossAccountKind({ account_number: '3149', default_vat_treatment: 'oss' })).toBe('sales')
    expect(ossAccountKind({ account_number: '3001', default_vat_treatment: 'standard_25' })).toBeNull()
    expect(ossAccountKind({ account_number: '3106', default_vat_treatment: null })).toBeNull()
  })

  it('reads a 26xx account other than 2650 as a VAT account', () => {
    expect(ossAccountKind({ account_number: '2670' })).toBe('vat')
    expect(ossAccountKind({ account_number: '2618' })).toBe('vat')
    expect(ossAccountKind({ account_number: '2650' })).toBeNull()
    expect(ossAccountKind({ account_number: '2710' })).toBeNull()
    expect(ossAccountKind({ account_number: '26711' })).toBeNull()
    expect(ossAccountKind({ account_number: '1930' })).toBeNull()
  })
})

describe('isOssAccountCountry', () => {
  it('takes another EU country in capitals, and EU on a VAT account only', () => {
    expect(isOssAccountCountry('sales', 'DE')).toBe(true)
    expect(isOssAccountCountry('vat', 'DE')).toBe(true)
    expect(isOssAccountCountry('vat', OSS_ALL_EU_COUNTRIES)).toBe(true)
    expect(isOssAccountCountry('sales', OSS_ALL_EU_COUNTRIES)).toBe(false)
    expect(isOssAccountCountry('sales', 'SE')).toBe(false)
    expect(isOssAccountCountry('sales', 'NO')).toBe(false)
    expect(isOssAccountCountry('sales', 'de')).toBe(false)
    expect(isOssAccountCountry('vat', 'Tyskland')).toBe(false)
  })
})

describe('isOssVatRate', () => {
  it('is a percentage above 0 and below 100 with at most two decimals', () => {
    expect(isOssVatRate(19)).toBe(true)
    expect(isOssVatRate(25.5)).toBe(true)
    expect(isOssVatRate(5.25)).toBe(true)
    expect(isOssVatRate(0)).toBe(false)
    expect(isOssVatRate(100)).toBe(false)
    expect(isOssVatRate(-7)).toBe(false)
    expect(isOssVatRate(19.123)).toBe(false)
    expect(isOssVatRate(Number.NaN)).toBe(false)
    expect(isOssVatRate('19')).toBe(false)
    expect(isOssVatRate(null)).toBe(false)
  })
})

describe('suggestOssAccount', () => {
  it('reads the country and the rate an account name states', () => {
    expect(suggestOssAccount('Försäljning enl. OSS (Spanien 21%)')).toEqual({ country: 'ES', vat_rate: 21 })
    expect(suggestOssAccount('Försäljning OSS Tyskland 19 %')).toEqual({ country: 'DE', vat_rate: 19 })
    expect(suggestOssAccount('Fsg varor Finland 25,5%')).toEqual({ country: 'FI', vat_rate: 25.5 })
    expect(suggestOssAccount('Sales Netherlands 21 procent')).toEqual({ country: 'NL', vat_rate: 21 })
    expect(suggestOssAccount('Försäljning Holland 9%')).toEqual({ country: 'NL', vat_rate: 9 })
    expect(suggestOssAccount('OSS-försäljning (DE) 7 %')).toEqual({ country: 'DE', vat_rate: 7 })
  })

  it('reads a VAT account that states a country and no rate', () => {
    expect(suggestOssAccount('Utgående moms OSS Frankrike')).toEqual({ country: 'FR', vat_rate: null })
  })

  it('suggests nothing a name does not state exactly once', () => {
    expect(suggestOssAccount('Försäljning varor till annat EU-land, momspliktig')).toEqual({ country: null, vat_rate: null })
    expect(suggestOssAccount('Försäljning Tyskland och Frankrike')).toEqual({ country: null, vat_rate: null })
    expect(suggestOssAccount('Försäljning Tyskland 19% / 7%')).toEqual({ country: 'DE', vat_rate: null })
    // Sweden is never an OSS country, and Norway is outside the EU.
    expect(suggestOssAccount('Försäljning Sverige 25%')).toEqual({ country: null, vat_rate: 25 })
    expect(suggestOssAccount('Försäljning Norge 25%')).toEqual({ country: null, vat_rate: 25 })
  })

  it('reads whole words only: a bare country code or a country inside another word is no country', () => {
    expect(suggestOssAccount('Försäljning IT-tjänster OSS')).toEqual({ country: null, vat_rate: null })
    expect(suggestOssAccount('Försäljning Nordirland 20%')).toEqual({ country: null, vat_rate: 20 })
    expect(suggestOssAccount('Försäljning DE 19%')).toEqual({ country: null, vat_rate: 19 })
  })
})
