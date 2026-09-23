import { describe, it, expect } from 'vitest'
import { classifyCustomer, classifySupplier } from '../classify'

describe('classifyCustomer', () => {
  it('classifies 12-digit personnummer as individual', () => {
    expect(classifyCustomer({
      org_number: '198001011234',
      vat_number: null,
    })).toBe('individual')
  })

  it('classifies 10-digit Swedish org as swedish_business', () => {
    expect(classifyCustomer({
      org_number: '5560217780',
      vat_number: null,
    })).toBe('swedish_business')
  })

  it('classifies non-SE EU VAT prefix as eu_business', () => {
    expect(classifyCustomer({
      org_number: null,
      vat_number: 'DE123456789',
    })).toBe('eu_business')
  })

  it('classifies non-EU VAT prefix as non_eu_business', () => {
    expect(classifyCustomer({
      org_number: null,
      vat_number: 'NO12345678',
    })).toBe('non_eu_business')
  })

  it('keeps SE VAT prefix as swedish_business', () => {
    expect(classifyCustomer({
      org_number: '5560217780',
      vat_number: 'SE556021778001',
    })).toBe('swedish_business')
  })

  it('classifies 10-digit personnummer-month-pattern as individual', () => {
    // Third digit is 0 (month 01), classic personnummer pattern
    expect(classifyCustomer({
      org_number: '8001011234',
      vat_number: null,
    })).toBe('individual')
  })

  it('falls back to swedish_business when no signals', () => {
    expect(classifyCustomer({
      org_number: null,
      vat_number: null,
    })).toBe('swedish_business')
  })

  it('uses country code when VAT missing', () => {
    expect(classifyCustomer({
      org_number: null,
      vat_number: null,
      country: 'DE',
    })).toBe('eu_business')
  })

  it('detects Norway as non-EU', () => {
    expect(classifyCustomer({
      org_number: null,
      vat_number: null,
      country: 'Norge',
    })).toBe('non_eu_business')
  })
})

describe('classifySupplier', () => {
  it('never returns individual', () => {
    expect(classifySupplier({
      org_number: '198001011234',
      vat_number: null,
    })).toBe('swedish_business')
  })

  it('classifies non-SE EU VAT prefix as eu_business', () => {
    expect(classifySupplier({
      org_number: null,
      vat_number: 'FR12345678901',
    })).toBe('eu_business')
  })

  it('classifies post-Brexit GB VAT as non_eu_business', () => {
    expect(classifySupplier({
      org_number: null,
      vat_number: 'GB123456789',
    })).toBe('non_eu_business')
  })

  it('classifies XI (Northern Ireland) VAT as eu_business', () => {
    expect(classifySupplier({
      org_number: null,
      vat_number: 'XI123456789',
    })).toBe('eu_business')
  })

  it('falls back to swedish_business by default', () => {
    expect(classifySupplier({
      org_number: null,
      vat_number: null,
    })).toBe('swedish_business')
  })
})
