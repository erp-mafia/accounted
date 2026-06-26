import { describe, it, expect } from 'vitest'
import {
  normalizeVatNumber,
  isValidSwedishVatNumber,
  deriveSwedishVatNumber,
} from '@/lib/vat/vat-number'

describe('normalizeVatNumber', () => {
  it('uppercases and strips spaces and hyphens', () => {
    expect(normalizeVatNumber('se 556123-4567 01')).toBe('SE556123456701')
  })

  it('leaves an already-canonical number unchanged', () => {
    expect(normalizeVatNumber('SE556123456701')).toBe('SE556123456701')
  })
})

describe('isValidSwedishVatNumber', () => {
  it('accepts SE followed by exactly 12 digits', () => {
    expect(isValidSwedishVatNumber('SE556123456701')).toBe(true)
  })

  it('rejects SE followed by 14 digits (century not dropped)', () => {
    expect(isValidSwedishVatNumber('SE19900101123401')).toBe(false)
  })

  it('rejects lowercase / spaced input (must be normalised first)', () => {
    expect(isValidSwedishVatNumber('se556123456701')).toBe(false)
    expect(isValidSwedishVatNumber('SE 556123 4567 01')).toBe(false)
  })

  it('rejects a non-SE prefix', () => {
    expect(isValidSwedishVatNumber('DE123456789')).toBe(false)
  })
})

describe('deriveSwedishVatNumber', () => {
  it('derives from a 10-digit aktiebolag org number (used as-is + 01)', () => {
    // 5561234567 is a valid-Luhn organisationsnummer
    expect(deriveSwedishVatNumber('5561234567')).toBe('SE556123456701')
  })

  it('accepts hyphen-formatted org numbers', () => {
    expect(deriveSwedishVatNumber('556123-4567')).toBe('SE556123456701')
  })

  it('drops the century from a 12-digit personnummer (enskild firma)', () => {
    // 19850101-0006 → 10-digit form 8501010006 → SE8501010006 01
    expect(deriveSwedishVatNumber('198501010006')).toBe('SE850101000601')
  })

  it('derives from a 10-digit personnummer as-is', () => {
    expect(deriveSwedishVatNumber('850101-0006')).toBe('SE850101000601')
  })

  it('returns null for a structurally invalid (bad Luhn) identity', () => {
    expect(deriveSwedishVatNumber('1234567890')).toBeNull()
  })

  it('returns null for empty / nullish input', () => {
    expect(deriveSwedishVatNumber('')).toBeNull()
    expect(deriveSwedishVatNumber(null)).toBeNull()
    expect(deriveSwedishVatNumber(undefined)).toBeNull()
  })

  it('never produces an SE+14 value from a 12-digit personnummer', () => {
    const derived = deriveSwedishVatNumber('198501010006')
    expect(derived).not.toBeNull()
    expect(isValidSwedishVatNumber(derived as string)).toBe(true)
  })
})
