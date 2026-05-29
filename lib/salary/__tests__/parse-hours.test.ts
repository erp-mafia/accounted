import { describe, it, expect } from 'vitest'
import { parseHoursInput } from '../parse-hours'

describe('parseHoursInput', () => {
  it('parses plain numbers', () => {
    expect(parseHoursInput('8')).toBe(8)
    expect(parseHoursInput('6.5')).toBe(6.5)
    expect(parseHoursInput('0')).toBe(0)
  })

  it('accepts Swedish decimal comma', () => {
    expect(parseHoursInput('6,5')).toBe(6.5)
  })

  it('parses HHMM-HHMM ranges', () => {
    expect(parseHoursInput('1740-2240')).toBe(5)
    expect(parseHoursInput('0800-1630')).toBe(8.5)
    expect(parseHoursInput('9-17')).toBe(8)
  })

  it('parses HH:MM-HH:MM ranges', () => {
    expect(parseHoursInput('17:40-22:40')).toBe(5)
    expect(parseHoursInput('08:00-16:30')).toBe(8.5)
  })

  it('handles overnight ranges by wrapping past midnight', () => {
    // 17:40 → 00:30 next day = 6h50m = 6.83
    expect(parseHoursInput('1740-0030')).toBe(6.83)
    // 22:00 → 06:00 = 8h
    expect(parseHoursInput('2200-0600')).toBe(8)
  })

  it('accepts en/em dashes', () => {
    expect(parseHoursInput('0800–1630')).toBe(8.5)
    expect(parseHoursInput('0800—1630')).toBe(8.5)
  })

  it('returns null for unparseable input', () => {
    expect(parseHoursInput('')).toBeNull()
    expect(parseHoursInput('abc')).toBeNull()
    expect(parseHoursInput('1740-')).toBeNull()
    expect(parseHoursInput('2540-2600')).toBeNull() // invalid clock hours
    expect(parseHoursInput('0800-0800')).toBeNull() // zero-length
  })

  it('treats a negative number as a plain (invalid-downstream) value, not a range', () => {
    expect(parseHoursInput('-5')).toBe(-5)
  })

  it('rounds to 2 decimals', () => {
    // 17:40 → 00:35 = 6h55m = 6.9166… → 6.92
    expect(parseHoursInput('1740-0035')).toBe(6.92)
  })
})
