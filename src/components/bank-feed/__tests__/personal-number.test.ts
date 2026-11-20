import { describe, expect, it } from 'vitest'
import { normalizePersonalNumber, personalNumberIncomplete } from '../personal-number'

// 19900101-0017 passes the Luhn check (used across the salary tests).
const NOW = new Date('2026-10-12T12:00:00Z')

describe('normalizePersonalNumber', () => {
  it('expands the ten-digit forms to the twelve digits the bank expects', () => {
    expect(normalizePersonalNumber('900101-0017', NOW)).toBe('199001010017')
    expect(normalizePersonalNumber('9001010017', NOW)).toBe('199001010017')
    expect(normalizePersonalNumber('19900101-0017', NOW)).toBe('199001010017')
    expect(normalizePersonalNumber(' 199001010017 ', NOW)).toBe('199001010017')
  })

  it('refuses an empty field, a wrong check digit and a half-typed number', () => {
    expect(normalizePersonalNumber('', NOW)).toBeNull()
    expect(normalizePersonalNumber('19900101-0018', NOW)).toBeNull()
    expect(normalizePersonalNumber('900101', NOW)).toBeNull()
  })
})

describe('personalNumberIncomplete', () => {
  it('is true only while something is typed that is not yet valid', () => {
    expect(personalNumberIncomplete('', NOW)).toBe(false)
    expect(personalNumberIncomplete('9001', NOW)).toBe(true)
    expect(personalNumberIncomplete('900101-0017', NOW)).toBe(false)
  })
})
