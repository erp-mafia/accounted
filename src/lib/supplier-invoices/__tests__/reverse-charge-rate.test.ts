import { describe, expect, it } from 'vitest'
import { isReverseChargeRate, reverseChargeRateDefault, reverseChargeRateOf } from '../reverse-charge-rate'

describe('reverseChargeRateDefault', () => {
  it('keeps the row\'s own sats when it is a Swedish sats a reverse-charge purchase can carry', () => {
    expect(reverseChargeRateDefault(0.25)).toBe(0.25)
    expect(reverseChargeRateDefault(0.12)).toBe(0.12)
    expect(reverseChargeRateDefault(0.06)).toBe(0.06)
  })

  // Issue #227: a row read at 0 % got a reverse-charge sats of 0, which the
  // sats select cannot show and the API refuses.
  it('gives 25 % for a row read at 0 %, never 0', () => {
    expect(reverseChargeRateDefault(0)).toBe(0.25)
  })

  it('gives 25 % for a rate that is not Swedish, a percent-shaped one or none', () => {
    expect(reverseChargeRateDefault(0.2)).toBe(0.25)
    expect(reverseChargeRateDefault(0.19)).toBe(0.25)
    expect(reverseChargeRateDefault(12)).toBe(0.25)
    expect(reverseChargeRateDefault(-0.25)).toBe(0.25)
    expect(reverseChargeRateDefault(Number.NaN)).toBe(0.25)
    expect(reverseChargeRateDefault(null)).toBe(0.25)
    expect(reverseChargeRateDefault(undefined)).toBe(0.25)
  })
})

describe('isReverseChargeRate', () => {
  it('is true for 6, 12 and 25 % only', () => {
    expect([0.06, 0.12, 0.25].every(isReverseChargeRate)).toBe(true)
    expect([0, 0.2, 25, null, undefined].some(isReverseChargeRate)).toBe(false)
  })
})

describe('reverseChargeRateOf', () => {
  it('is the sats the row holds when it is one a reverse-charge purchase can carry', () => {
    expect(reverseChargeRateOf({ vat_rate: 0.25, reverse_charge_rate: 0.06 })).toBe(0.06)
    expect(reverseChargeRateOf({ vat_rate: 0, reverse_charge_rate: 0.12 })).toBe(0.12)
  })

  it('is the row\'s default where it holds none, or one the API would refuse', () => {
    expect(reverseChargeRateOf({ vat_rate: 0.12 })).toBe(0.12)
    expect(reverseChargeRateOf({ vat_rate: 0.12, reverse_charge_rate: null })).toBe(0.12)
    expect(reverseChargeRateOf({ vat_rate: 0, reverse_charge_rate: 0 })).toBe(0.25)
    expect(reverseChargeRateOf({ vat_rate: 0.12, reverse_charge_rate: 0 })).toBe(0.12)
    expect(reverseChargeRateOf({})).toBe(0.25)
  })
})
