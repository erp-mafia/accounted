import { describe, expect, it } from 'vitest'
import { compactVatNumber, isMalformedEuVatNumber } from '../vat-number'

describe('isMalformedEuVatNumber (crm#1411)', () => {
  it('flags an EU prefix whose national part is not that state\'s VAT number', () => {
    // A US seller's VAT-code label printed beside its tax line, read as a Swedish VAT number.
    expect(isMalformedEuVatNumber('SESL000D')).toBe(true)
    // An organisationsnummer with SE in front: a Swedish VAT number is SE + 12 digits.
    expect(isMalformedEuVatNumber('SE5566778899')).toBe(true)
    expect(isMalformedEuVatNumber('DE12345')).toBe(true)
    expect(isMalformedEuVatNumber('SE')).toBe(true)
  })

  it('accepts real numbers, however they are printed', () => {
    expect(isMalformedEuVatNumber('SE556012579001')).toBe(false)
    expect(isMalformedEuVatNumber('se 5560 1257 9001')).toBe(false)
    expect(isMalformedEuVatNumber('SE556012-579001')).toBe(false)
    expect(isMalformedEuVatNumber('SESE556012579001')).toBe(false)
    expect(isMalformedEuVatNumber('DE811234567')).toBe(false)
    expect(isMalformedEuVatNumber('IE3668997OH')).toBe(false)
    expect(isMalformedEuVatNumber('NL123456789B01')).toBe(false)
    expect(isMalformedEuVatNumber('EL094014201')).toBe(false)
    expect(isMalformedEuVatNumber('GR094014201')).toBe(false)
  })

  it('does not judge a prefix it has no format for, or no value', () => {
    expect(isMalformedEuVatNumber('GB123456789')).toBe(false)
    expect(isMalformedEuVatNumber('NO923609016MVA')).toBe(false)
    expect(isMalformedEuVatNumber('XI123456789')).toBe(false)
    expect(isMalformedEuVatNumber('556012579001')).toBe(false)
    expect(isMalformedEuVatNumber(null)).toBe(false)
    expect(isMalformedEuVatNumber('')).toBe(false)
  })

  it('compacts separators and a prefix printed twice', () => {
    expect(compactVatNumber('SE 5560.1257-9001')).toBe('SE556012579001')
    expect(compactVatNumber('SESE556012579001')).toBe('SE556012579001')
    expect(compactVatNumber('SESL000D')).toBe('SESL000D')
  })
})
