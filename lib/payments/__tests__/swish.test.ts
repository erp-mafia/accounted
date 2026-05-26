import { describe, it, expect } from 'vitest'
import { normaliseSwish, isValidSwish } from '../swish'

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
