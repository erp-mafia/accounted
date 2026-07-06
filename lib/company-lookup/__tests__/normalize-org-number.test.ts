import { describe, it, expect } from 'vitest'
import { normalizeOrgNumber } from '../normalize-org-number'

describe('normalizeOrgNumber', () => {
  it('accepts valid 10-digit AB org numbers (real Volvo)', () => {
    expect(normalizeOrgNumber('5560125790')).toBe('5560125790')
    expect(normalizeOrgNumber('556012-5790')).toBe('5560125790')
    expect(normalizeOrgNumber(' 556012-5790 ')).toBe('5560125790')
  })

  it('strips the century prefix from 12-digit input and returns the 10-digit canonical', () => {
    expect(normalizeOrgNumber('165560125790')).toBe('5560125790') // 16 = AB prefix
    expect(normalizeOrgNumber('198001011231')).toBe('8001011231') // 19 = pre-2000 personnummer
    expect(normalizeOrgNumber('19800101-1231')).toBe('8001011231')
  })

  it('accepts valid 10-digit personnummer-style org numbers', () => {
    expect(normalizeOrgNumber('8001011231')).toBe('8001011231')
    expect(normalizeOrgNumber('800101-1231')).toBe('8001011231')
  })

  it('rejects Luhn-invalid org numbers (blocks garbage at the boundary)', () => {
    // 5560125791 has the last digit flipped from the real Volvo number
    // 5560125790: Luhn check fails.
    expect(normalizeOrgNumber('5560125791')).toBeNull()
    expect(normalizeOrgNumber('556012-5791')).toBeNull()
    // Typo: swapping adjacent digits in the payload breaks the Luhn check.
    expect(normalizeOrgNumber('5506125790')).toBeNull()
  })

  it('rejects wrong lengths and non-digit content', () => {
    expect(normalizeOrgNumber('')).toBeNull()
    expect(normalizeOrgNumber('abc123')).toBeNull()
    expect(normalizeOrgNumber('12345')).toBeNull() // too short
    expect(normalizeOrgNumber('12345678901')).toBeNull() // 11 digits
    expect(normalizeOrgNumber('1234567890123')).toBeNull() // 13 digits
  })

  it('returns null for nullish input', () => {
    expect(normalizeOrgNumber(null)).toBeNull()
    expect(normalizeOrgNumber(undefined)).toBeNull()
  })
})
