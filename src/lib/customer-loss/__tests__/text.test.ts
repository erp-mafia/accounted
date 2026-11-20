import { describe, expect, it } from 'vitest'
import { formatLossAmount } from '../text'

// Intl separates groups and the unit with no-break spaces; compare with plain ones.
const plain = (text: string) => text.replace(/\s/g, ' ')

describe('formatLossAmount', () => {
  it('prints whole kronor without decimals and öre with both digits (the collections screens\' one rule)', () => {
    expect(plain(formatLossAmount(12187.5))).toBe('12 187,50 kr')
    expect(plain(formatLossAmount(62.5))).toBe('62,50 kr')
    expect(plain(formatLossAmount(1250))).toBe('1 250 kr')
    expect(plain(formatLossAmount(0.07))).toBe('0,07 kr')
  })
})
