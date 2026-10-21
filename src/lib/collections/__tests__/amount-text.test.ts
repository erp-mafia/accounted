import { describe, expect, it } from 'vitest'
import { formatKronor } from '../amount-text'

// Intl separates groups and the unit with no-break spaces; compare with plain ones.
const plain = (text: string) => text.replace(/\s/g, ' ')

describe('formatKronor (one rule across the collections screens)', () => {
  it('shows whole kronor without decimals', () => {
    expect(plain(formatKronor(12500))).toBe('12 500 kr')
    expect(plain(formatKronor(0))).toBe('0 kr')
    expect(plain(formatKronor(10625.004))).toBe('10 625 kr')
  })

  it('shows öre, always both digits, only when the amount is not whole kronor', () => {
    expect(plain(formatKronor(11250.5))).toBe('11 250,50 kr')
    expect(plain(formatKronor(62.5))).toBe('62,50 kr')
    expect(plain(formatKronor(0.1 + 0.2))).toBe('0,30 kr')
  })

  it('keeps the sign', () => {
    expect(plain(formatKronor(-62.5))).toMatch(/^[-−]62,50 kr$/)
    expect(plain(formatKronor(-1500))).toMatch(/^[-−]1 500 kr$/)
  })
})
