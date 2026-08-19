import { describe, it, expect } from 'vitest'
import {
  K2_ACCRUAL_THRESHOLD_SEK,
  accrualHintKey,
  resolveAccrualAmountSek,
  shouldShowK2AccrualHint,
} from '@/components/bookkeeping/accrual-k2-hint'

describe('resolveAccrualAmountSek', () => {
  it('returns the amount unchanged for SEK', () => {
    expect(resolveAccrualAmountSek({ amount: 4999, currency: 'SEK' })).toBe(4999)
  })

  it('treats a missing currency as SEK (the editors default to it)', () => {
    expect(resolveAccrualAmountSek({ amount: 4999 })).toBe(4999)
    expect(resolveAccrualAmountSek({ amount: 4999, currency: null })).toBe(4999)
    expect(resolveAccrualAmountSek({ amount: 4999, currency: '' })).toBe(4999)
  })

  it('converts a foreign amount with the given rate, rounded to ore', () => {
    // 500 EUR at 11.5012 = 5750.60 kr, not 5750.5999999999995.
    expect(
      resolveAccrualAmountSek({ amount: 500, currency: 'EUR', exchangeRate: 11.5012 }),
    ).toBe(5750.6)
  })

  it('returns null for a foreign amount with no usable rate', () => {
    expect(resolveAccrualAmountSek({ amount: 500, currency: 'EUR' })).toBeNull()
    expect(
      resolveAccrualAmountSek({ amount: 500, currency: 'EUR', exchangeRate: null }),
    ).toBeNull()
    // An empty rate field parses to NaN; a cleared one to 0.
    expect(
      resolveAccrualAmountSek({ amount: 500, currency: 'EUR', exchangeRate: NaN }),
    ).toBeNull()
    expect(
      resolveAccrualAmountSek({ amount: 500, currency: 'EUR', exchangeRate: 0 }),
    ).toBeNull()
    expect(
      resolveAccrualAmountSek({ amount: 500, currency: 'EUR', exchangeRate: -11.5 }),
    ).toBeNull()
  })

  it('returns null for a non-finite amount', () => {
    expect(resolveAccrualAmountSek({ amount: NaN, currency: 'SEK' })).toBeNull()
  })

  it('accepts a lowercase or padded currency code', () => {
    expect(resolveAccrualAmountSek({ amount: 100, currency: ' sek ' })).toBe(100)
    expect(
      resolveAccrualAmountSek({ amount: 100, currency: ' eur ', exchangeRate: 11.5 }),
    ).toBe(1150)
  })
})

describe('shouldShowK2AccrualHint', () => {
  it('hides the hint for a foreign line that is above 5 000 kr once converted', () => {
    // THE BUG: 500 EUR is ~5 750 kr, i.e. ABOVE the K2 threshold, but the raw
    // 500 reads as below it and used to surface "under 5 000 kr" wrongly.
    expect(
      shouldShowK2AccrualHint({ amount: 500, currency: 'EUR', exchangeRate: 11.5 }),
    ).toBe(false)
  })

  it('shows the hint for a foreign line that is genuinely below 5 000 kr', () => {
    // 400 EUR = 4 600 kr.
    expect(
      shouldShowK2AccrualHint({ amount: 400, currency: 'EUR', exchangeRate: 11.5 }),
    ).toBe(true)
  })

  it('shows the hint for a foreign line the raw amount would have hidden', () => {
    // The reverse direction: 6 000 NOK at 0.98 = 5 880 kr... above. At 0.8 it
    // is 4 800 kr, below the threshold, while the raw 6 000 reads as above.
    expect(
      shouldShowK2AccrualHint({ amount: 6000, currency: 'NOK', exchangeRate: 0.8 }),
    ).toBe(true)
  })

  it('hides the hint when the SEK value cannot be determined', () => {
    // The customer-invoice editor has no exchange_rate field at all: never
    // guess a branch, show nothing.
    expect(shouldShowK2AccrualHint({ amount: 500, currency: 'EUR' })).toBe(false)
    expect(shouldShowK2AccrualHint({ amount: 50000, currency: 'EUR' })).toBe(false)
  })

  it('leaves SEK behaviour exactly as it was', () => {
    expect(shouldShowK2AccrualHint({ amount: 4999.99, currency: 'SEK' })).toBe(true)
    expect(shouldShowK2AccrualHint({ amount: 1, currency: 'SEK' })).toBe(true)
    expect(shouldShowK2AccrualHint({ amount: K2_ACCRUAL_THRESHOLD_SEK, currency: 'SEK' })).toBe(
      false,
    )
    expect(shouldShowK2AccrualHint({ amount: 5001, currency: 'SEK' })).toBe(false)
    expect(shouldShowK2AccrualHint({ amount: 0, currency: 'SEK' })).toBe(false)
    // No currency prop at all is the same as SEK.
    expect(shouldShowK2AccrualHint({ amount: 4999 })).toBe(true)
    expect(shouldShowK2AccrualHint({ amount: 5000 })).toBe(false)
  })

  it('does not fire on a negative (discount) line', () => {
    expect(shouldShowK2AccrualHint({ amount: -100, currency: 'SEK' })).toBe(false)
    expect(
      shouldShowK2AccrualHint({ amount: -100, currency: 'EUR', exchangeRate: 11.5 }),
    ).toBe(false)
  })
})

describe('accrualHintKey', () => {
  it('cites K1 (BFNAR 2006:1) for enskild firma', () => {
    expect(accrualHintKey('enskild_firma')).toBe('k1_hint')
  })

  it('cites K2 for aktiebolag', () => {
    expect(accrualHintKey('aktiebolag')).toBe('k2_hint')
  })

  it('keeps the K2 default when the entity type is unknown', () => {
    expect(accrualHintKey(null)).toBe('k2_hint')
    expect(accrualHintKey(undefined)).toBe('k2_hint')
  })
})
