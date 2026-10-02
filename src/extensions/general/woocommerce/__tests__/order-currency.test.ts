import { describe, it, expect } from 'vitest'
import {
  decodeCurrencyEntities,
  isKnownCurrencyCode,
  resolveOrderCurrency,
} from '../lib/order-currency'

describe('decodeCurrencyEntities', () => {
  it('decodes decimal, hex and the named entities of the symbol table', () => {
    expect(decodeCurrencyEntities('&#107;&#114;')).toBe('kr')
    expect(decodeCurrencyEntities('&#x6b;&#X72;')).toBe('kr')
    expect(decodeCurrencyEntities('&euro;')).toBe('€')
    expect(decodeCurrencyEntities('&pound;')).toBe('£')
    expect(decodeCurrencyEntities('SEK')).toBe('SEK')
  })

  it('leaves unknown or out-of-range entities alone', () => {
    expect(decodeCurrencyEntities('&bogus;')).toBe('&bogus;')
    expect(decodeCurrencyEntities('&#0;')).toBe('&#0;')
    expect(decodeCurrencyEntities('&#99999999;')).toBe('&#99999999;')
  })
})

describe('isKnownCurrencyCode', () => {
  it('accepts ISO codes Intl knows and nothing else', () => {
    expect(isKnownCurrencyCode('SEK')).toBe(true)
    expect(isKnownCurrencyCode('EUR')).toBe(true)
    expect(isKnownCurrencyCode('sek')).toBe(false)
    expect(isKnownCurrencyCode('KR')).toBe(false)
    expect(isKnownCurrencyCode('ABC')).toBe(false)
    expect(isKnownCurrencyCode('&#107;&#114;')).toBe(false)
  })
})

describe('resolveOrderCurrency', () => {
  it('maps a store symbol to the store currency for other kronor stores too', () => {
    expect(resolveOrderCurrency('kr', 'NOK')).toBe('NOK')
    expect(resolveOrderCurrency('&#36;', 'USD')).toBe('USD')
    expect(resolveOrderCurrency('&euro;', 'EUR')).toBe('EUR')
  })

  it("accepts WooCommerce's own symbol table entry for the store currency", () => {
    // DKK and ISK are "kr." in WooCommerce's table, not Intl's "kr" or "DKK".
    expect(resolveOrderCurrency('kr.', 'DKK')).toBe('DKK')
    expect(resolveOrderCurrency(' KR. ', 'DKK')).toBe('DKK')
    expect(resolveOrderCurrency('kr.', 'ISK')).toBe('ISK')
    expect(resolveOrderCurrency('&#107;&#114;', 'NOK')).toBe('NOK')
    expect(resolveOrderCurrency('&pound;', 'GBP')).toBe('GBP')
    expect(resolveOrderCurrency('&#122;&#322;', 'PLN')).toBe('PLN')
    expect(resolveOrderCurrency('&#67;&#72;&#70;', 'CHF')).toBe('CHF')
  })

  it('refuses another currency\'s WooCommerce symbol ("kr." is not the SEK symbol)', () => {
    expect(resolveOrderCurrency('kr.', 'SEK')).toBeNull()
    expect(resolveOrderCurrency('kr.', 'NOK')).toBeNull()
    expect(resolveOrderCurrency('&#122;&#322;', 'SEK')).toBeNull()
  })

  it('never lends the store currency to another currency symbol', () => {
    expect(resolveOrderCurrency('&euro;', 'SEK')).toBeNull()
    expect(resolveOrderCurrency('$', 'SEK')).toBeNull()
    expect(resolveOrderCurrency('kr', 'EUR')).toBeNull()
  })

  it('refuses non-strings and an unusable store currency', () => {
    expect(resolveOrderCurrency(null, 'SEK')).toBeNull()
    expect(resolveOrderCurrency(undefined, 'SEK')).toBeNull()
    expect(resolveOrderCurrency('kr', 'kr')).toBeNull()
    expect(resolveOrderCurrency('kr', '')).toBeNull()
  })
})
