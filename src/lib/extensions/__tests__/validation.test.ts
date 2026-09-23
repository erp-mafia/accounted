import { describe, it, expect } from 'vitest'
import {
  validateSwedishPersonalNumber,
  validatePositiveNumber,
  validateNonNegativeNumber,
  validateMaxNumber,
  validateRequired,
  validateDateNotFuture,
} from '../validation'

describe('validateSwedishPersonalNumber', () => {
  it('accepts a valid personal number with dash', () => {
    // 811228-9874 is a valid test number (Luhn passes)
    expect(validateSwedishPersonalNumber('19811228-9874')).toBeNull()
  })

  it('accepts a valid personal number without dash', () => {
    expect(validateSwedishPersonalNumber('198112289874')).toBeNull()
  })

  it('rejects empty string', () => {
    expect(validateSwedishPersonalNumber('')).toBe('Personnummer kravs')
  })

  it('rejects too short input', () => {
    expect(validateSwedishPersonalNumber('19811228')).toBe('Format: YYYYMMDD-XXXX (12 siffror)')
  })

  it('rejects too long input', () => {
    expect(validateSwedishPersonalNumber('198112289874555')).toBe('Format: YYYYMMDD-XXXX (12 siffror)')
  })

  it('rejects non-numeric characters', () => {
    expect(validateSwedishPersonalNumber('19811228ABCD')).toBe('Format: YYYYMMDD-XXXX (12 siffror)')
  })

  it('rejects invalid month', () => {
    expect(validateSwedishPersonalNumber('199913011234')).toBe('Ogiltig månad')
  })

  it('rejects month 00', () => {
    expect(validateSwedishPersonalNumber('199900011234')).toBe('Ogiltig månad')
  })

  it('rejects invalid day', () => {
    expect(validateSwedishPersonalNumber('199901321234')).toBe('Ogiltig dag')
  })

  it('rejects day 00', () => {
    expect(validateSwedishPersonalNumber('199901001234')).toBe('Ogiltig dag')
  })

  it('rejects year before 1900', () => {
    expect(validateSwedishPersonalNumber('189901011234')).toBe('Ogiltigt år')
  })

  it('rejects future year', () => {
    const futureYear = new Date().getFullYear() + 1
    expect(validateSwedishPersonalNumber(`${futureYear}01011234`)).toBe('Ogiltigt år')
  })

  it('rejects invalid Luhn checksum', () => {
    // Change last digit to break checksum
    expect(validateSwedishPersonalNumber('19811228-9875')).toBe('Ogiltig kontrollsiffra')
  })

  it('handles spaces in input', () => {
    expect(validateSwedishPersonalNumber('1981 1228 9874')).toBeNull()
  })
})

describe('validatePositiveNumber', () => {
  it('returns null for positive number', () => {
    expect(validatePositiveNumber(5)).toBeNull()
  })

  it('returns null for positive string number', () => {
    expect(validatePositiveNumber('42.5')).toBeNull()
  })

  it('rejects zero', () => {
    expect(validatePositiveNumber(0)).toBe('Varde maste vara storre an 0')
  })

  it('rejects negative number', () => {
    expect(validatePositiveNumber(-3)).toBe('Varde maste vara storre an 0')
  })

  it('rejects NaN string', () => {
    expect(validatePositiveNumber('abc')).toBe('Varde maste vara storre an 0')
  })
})

describe('validateNonNegativeNumber', () => {
  it('returns null for positive number', () => {
    expect(validateNonNegativeNumber(5)).toBeNull()
  })

  it('returns null for zero', () => {
    expect(validateNonNegativeNumber(0)).toBeNull()
  })

  it('rejects negative number', () => {
    expect(validateNonNegativeNumber(-1)).toBe('Varde kan inte vara negativt')
  })

  it('rejects NaN string', () => {
    expect(validateNonNegativeNumber('xyz')).toBe('Varde kan inte vara negativt')
  })
})

describe('validateMaxNumber', () => {
  it('returns null when value is under max', () => {
    expect(validateMaxNumber(5, 10)).toBeNull()
  })

  it('returns null when value equals max', () => {
    expect(validateMaxNumber(10, 10)).toBeNull()
  })

  it('rejects when value exceeds max', () => {
    expect(validateMaxNumber(15, 10)).toBe('Varde kan inte overskrida 10')
  })

  it('rejects NaN input', () => {
    expect(validateMaxNumber('abc', 10)).toBe('Ogiltigt varde')
  })

  it('works with string numbers', () => {
    expect(validateMaxNumber('8', 10)).toBeNull()
  })
})

describe('validateRequired', () => {
  it('returns null for non-empty string', () => {
    expect(validateRequired('hello')).toBeNull()
  })

  it('returns null for number', () => {
    expect(validateRequired(42)).toBeNull()
  })

  it('returns null for zero', () => {
    expect(validateRequired(0)).toBeNull()
  })

  it('rejects empty string', () => {
    expect(validateRequired('')).toBe('Obligatoriskt falt')
  })

  it('rejects undefined', () => {
    expect(validateRequired(undefined)).toBe('Obligatoriskt falt')
  })

  it('rejects null', () => {
    expect(validateRequired(null)).toBe('Obligatoriskt falt')
  })
})

describe('validateDateNotFuture', () => {
  it('returns null for past date', () => {
    expect(validateDateNotFuture('2020-01-01')).toBeNull()
  })

  it('returns null for today', () => {
    const today = new Date().toISOString().slice(0, 10)
    expect(validateDateNotFuture(today)).toBeNull()
  })

  it('rejects future date', () => {
    expect(validateDateNotFuture('2099-01-01')).toBe('Datum kan inte vara i framtiden')
  })

  it('rejects empty string', () => {
    expect(validateDateNotFuture('')).toBe('Datum kravs')
  })
})
