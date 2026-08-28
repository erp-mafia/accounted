import { describe, expect, it } from 'vitest'
import { EU_COUNTRIES, isEuMemberCountry } from '../eu-countries'

describe('isEuMemberCountry', () => {
  it('is true for every listed member state, case insensitive', () => {
    for (const country of EU_COUNTRIES) {
      expect(isEuMemberCountry(country.code)).toBe(true)
      expect(isEuMemberCountry(country.code.toLowerCase())).toBe(true)
    }
  })

  it('counts Sweden as a member (callers test SE separately)', () => {
    expect(isEuMemberCountry('SE')).toBe(true)
  })

  it('is false for non-EU countries and unknown codes', () => {
    expect(isEuMemberCountry('US')).toBe(false)
    expect(isEuMemberCountry('NO')).toBe(false)
    expect(isEuMemberCountry('GB')).toBe(false)
    expect(isEuMemberCountry('CH')).toBe(false)
    expect(isEuMemberCountry('')).toBe(false)
  })
})
