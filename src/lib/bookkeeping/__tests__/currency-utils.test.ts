import { describe, it, expect } from 'vitest'
import {
  resolveSekAmount,
  resolveSekAmountOrNull,
  buildCurrencyMetadata,
} from '../currency-utils'

/**
 * The strict ladder. Booking code must use this one: it answers "no SEK value
 * can be established" with null instead of handing back the foreign amount.
 */
describe('resolveSekAmountOrNull', () => {
  it('returns amount as-is for SEK currency', () => {
    expect(resolveSekAmountOrNull(1000, null, 'SEK', null)).toBe(1000)
  })

  it('returns amount as-is when currency is null (legacy data means SEK)', () => {
    expect(resolveSekAmountOrNull(1000, null, null, null)).toBe(1000)
  })

  it('returns amount as-is when currency is undefined', () => {
    expect(resolveSekAmountOrNull(1000, null, undefined, null)).toBe(1000)
  })

  it('returns amountSek when populated for foreign currency', () => {
    expect(resolveSekAmountOrNull(100, 1150, 'EUR', 11.5)).toBe(1150)
  })

  it('rounds amountSek to öre', () => {
    expect(resolveSekAmountOrNull(100, 1150.456, 'EUR', 11.5)).toBe(1150.46)
  })

  it('computes via exchangeRate when amountSek is null', () => {
    expect(resolveSekAmountOrNull(100, null, 'EUR', 11.5)).toBe(1150)
  })

  it('rounds the computed amount to öre', () => {
    // 100.33 * 11.5 = 1153.795 -> 1153.8
    expect(resolveSekAmountOrNull(100.33, null, 'EUR', 11.5)).toBe(1153.8)
  })

  it('prefers amountSek over exchangeRate computation', () => {
    expect(resolveSekAmountOrNull(100, 1200, 'EUR', 11.5)).toBe(1200)
  })

  it('handles negative amounts', () => {
    expect(resolveSekAmountOrNull(-100, null, 'EUR', 11.5)).toBe(-1150)
  })

  it('handles zero amount', () => {
    expect(resolveSekAmountOrNull(0, null, 'EUR', 11.5)).toBe(0)
  })

  // The whole point of the strict sibling: a foreign amount with no SEK value
  // and no rate is refused, never relabelled as kronor. 100 EUR is not 100 SEK.
  it('returns null when a foreign amount has neither amountSek nor exchangeRate', () => {
    expect(resolveSekAmountOrNull(100, null, 'EUR', null)).toBeNull()
  })

  it('returns null when exchangeRate is 0', () => {
    expect(resolveSekAmountOrNull(100, null, 'EUR', 0)).toBeNull()
  })

  it('returns null when exchangeRate is negative', () => {
    expect(resolveSekAmountOrNull(100, null, 'EUR', -11.5)).toBeNull()
  })

  it('returns null when exchangeRate is undefined', () => {
    expect(resolveSekAmountOrNull(100, null, 'EUR', undefined)).toBeNull()
  })

  it('never returns null for SEK, whatever the rate looks like', () => {
    expect(resolveSekAmountOrNull(100, null, 'SEK', null)).toBe(100)
    expect(resolveSekAmountOrNull(100, null, 'SEK', 0)).toBe(100)
  })
})

/**
 * The lenient wrapper, kept for read-only callers over legacy pre-FX rows.
 *
 * Its fallback behaviour is UNCHANGED and deliberately still pinned below: the
 * root fix added `resolveSekAmountOrNull()` as a strict sibling rather than
 * flipping this function's return type, so no unread call site could shift. The
 * two "falls back to the original amount" cases therefore still pass, and they
 * now assert that the lenient contract is intact rather than that guessing is
 * acceptable: the matching strict cases above assert the refusal.
 */
describe('resolveSekAmount', () => {
  it('returns amount as-is for SEK currency', () => {
    expect(resolveSekAmount(1000, null, 'SEK', null)).toBe(1000)
  })

  it('returns amount as-is when currency is null (legacy data)', () => {
    expect(resolveSekAmount(1000, null, null, null)).toBe(1000)
  })

  it('returns amount as-is when currency is undefined', () => {
    expect(resolveSekAmount(1000, null, undefined, null)).toBe(1000)
  })

  it('returns amountSek when populated for foreign currency', () => {
    expect(resolveSekAmount(100, 1150, 'EUR', 11.5)).toBe(1150)
  })

  it('rounds amountSek to 2 decimals', () => {
    expect(resolveSekAmount(100, 1150.456, 'EUR', 11.5)).toBe(1150.46)
  })

  it('computes via exchangeRate when amountSek is null', () => {
    expect(resolveSekAmount(100, null, 'EUR', 11.5)).toBe(1150)
  })

  it('rounds computed amount to 2 decimals', () => {
    // 100.33 * 11.5 = 1153.795 → rounds to 1153.8
    expect(resolveSekAmount(100.33, null, 'EUR', 11.5)).toBe(1153.8)
  })

  // These two are the legacy-reader contract, NOT a statement that 100 EUR may
  // be booked as 100 SEK. Booking code must call resolveSekAmountOrNull(), which
  // returns null for exactly these inputs (see the strict block above).
  it('falls back to original amount when both amountSek and exchangeRate are null (legacy readers only)', () => {
    expect(resolveSekAmount(100, null, 'EUR', null)).toBe(100)
    expect(resolveSekAmountOrNull(100, null, 'EUR', null)).toBeNull()
  })

  it('falls back when exchangeRate is 0 (legacy readers only)', () => {
    expect(resolveSekAmount(100, null, 'EUR', 0)).toBe(100)
    expect(resolveSekAmountOrNull(100, null, 'EUR', 0)).toBeNull()
  })

  // The lenient function is a thin wrapper: everything except the last resort
  // must be byte-identical to the strict ladder, so the two can never drift.
  it('delegates every resolvable case to resolveSekAmountOrNull', () => {
    const cases: Array<[number, number | null, string | null, number | null]> = [
      [1000, null, 'SEK', null],
      [1000, null, null, null],
      [100, 1150, 'EUR', 11.5],
      [100, 1150.456, 'EUR', 11.5],
      [100.33, null, 'EUR', 11.5],
      [-100, null, 'EUR', 11.5],
      [0, null, 'EUR', 11.5],
      [100, 1200, 'EUR', 11.5],
    ]
    for (const [amount, amountSek, currency, rate] of cases) {
      expect(resolveSekAmount(amount, amountSek, currency, rate)).toBe(
        resolveSekAmountOrNull(amount, amountSek, currency, rate)
      )
    }
  })

  it('handles negative amounts correctly', () => {
    expect(resolveSekAmount(-100, null, 'EUR', 11.5)).toBe(-1150)
  })

  it('prefers amountSek over exchangeRate computation', () => {
    // amountSek = 1200, but exchangeRate would give 1150
    expect(resolveSekAmount(100, 1200, 'EUR', 11.5)).toBe(1200)
  })

  it('handles zero amount', () => {
    expect(resolveSekAmount(0, null, 'EUR', 11.5)).toBe(0)
  })
})

describe('buildCurrencyMetadata', () => {
  it('returns empty object for SEK', () => {
    expect(buildCurrencyMetadata('SEK', 1000, null)).toEqual({})
  })

  it('returns empty object for null currency', () => {
    expect(buildCurrencyMetadata(null, 1000, null)).toEqual({})
  })

  it('returns empty object for undefined currency', () => {
    expect(buildCurrencyMetadata(undefined, 1000, null)).toEqual({})
  })

  it('returns currency metadata for foreign currency', () => {
    expect(buildCurrencyMetadata('EUR', 100, 11.5)).toEqual({
      currency: 'EUR',
      amount_in_currency: 100,
      exchange_rate: 11.5,
    })
  })

  it('omits amount_in_currency when null', () => {
    expect(buildCurrencyMetadata('EUR', null, 11.5)).toEqual({
      currency: 'EUR',
      exchange_rate: 11.5,
    })
  })

  it('omits exchange_rate when null', () => {
    expect(buildCurrencyMetadata('EUR', 100, null)).toEqual({
      currency: 'EUR',
      amount_in_currency: 100,
    })
  })

  it('omits exchange_rate when 0', () => {
    expect(buildCurrencyMetadata('EUR', 100, 0)).toEqual({
      currency: 'EUR',
      amount_in_currency: 100,
    })
  })
})
