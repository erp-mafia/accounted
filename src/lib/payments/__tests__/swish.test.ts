import { describe, it, expect } from 'vitest'
import { normaliseSwish, isValidSwish, buildSwishQrPayload } from '../swish'

describe('normaliseSwish', () => {
  it('strips whitespace and hyphens', () => {
    expect(normaliseSwish('123 456 78 90')).toBe('1234567890')
    expect(normaliseSwish('070-123 45 67')).toBe('0701234567')
    expect(normaliseSwish('  1234567890  ')).toBe('1234567890')
  })

  it('returns empty string for null/undefined/empty', () => {
    expect(normaliseSwish(null)).toBe('')
    expect(normaliseSwish(undefined)).toBe('')
    expect(normaliseSwish('')).toBe('')
  })
})

describe('isValidSwish', () => {
  it('accepts Swish Företag numbers (123XXXXXXX)', () => {
    expect(isValidSwish('1234567890')).toBe(true)
    expect(isValidSwish('1230000000')).toBe(true)
  })

  it('accepts Swedish mobile numbers (07XXXXXXXX)', () => {
    expect(isValidSwish('0701234567')).toBe(true)
    expect(isValidSwish('0700000000')).toBe(true)
  })

  it('accepts empty string for clearing the field', () => {
    expect(isValidSwish('')).toBe(true)
  })

  it('rejects non-conforming numbers', () => {
    expect(isValidSwish('0123456789')).toBe(false)
    expect(isValidSwish('1239')).toBe(false)
    expect(isValidSwish('12345678901')).toBe(false)
    expect(isValidSwish('123abc4567')).toBe(false)
  })
})

describe('buildSwishQrPayload', () => {
  it('builds a fully-locked Type C payload for a Swish-företag number', () => {
    expect(buildSwishQrPayload('1234567890', 1250, 'Faktura 100')).toBe('C1234567890;1250.00;Faktura 100;0')
  })

  it('works for a mobile-number payee with the same syntax', () => {
    expect(buildSwishQrPayload('0701234567', 99.5, 'F-1')).toBe('C0701234567;99.50;F-1;0')
  })

  it('normalises spaces/hyphens in the number', () => {
    expect(buildSwishQrPayload('123 456 78 90', 10, 'x')).toBe('C1234567890;10.00;x;0')
  })

  it('strips the ; field delimiter from the message and trims it', () => {
    expect(buildSwishQrPayload('1234567890', 10, ' a;b ')).toBe('C1234567890;10.00;a b;0')
  })

  it('formats the amount with two decimals', () => {
    expect(buildSwishQrPayload('1234567890', 100, 'x')).toBe('C1234567890;100.00;x;0')
    expect(buildSwishQrPayload('1234567890', 1234.5, 'x')).toBe('C1234567890;1234.50;x;0')
  })

  it('returns null for an invalid or empty number', () => {
    expect(buildSwishQrPayload('12345', 10, 'x')).toBeNull()
    expect(buildSwishQrPayload('', 10, 'x')).toBeNull()
    expect(buildSwishQrPayload(null, 10, 'x')).toBeNull()
  })

  it('returns null for a non-positive amount', () => {
    expect(buildSwishQrPayload('1234567890', 0, 'x')).toBeNull()
    expect(buildSwishQrPayload('1234567890', -5, 'x')).toBeNull()
  })
})
