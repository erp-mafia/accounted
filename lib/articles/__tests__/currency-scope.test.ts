import { describe, expect, it } from 'vitest'
import {
  ALL_CURRENCIES,
  articleCurrency,
  listArticleCurrencies,
  matchesCurrencyScope,
  resolveCurrencyScope,
} from '@/lib/articles/currency-scope'

describe('articleCurrency', () => {
  it('normalizes the code', () => {
    expect(articleCurrency({ currency: 'eur' })).toBe('EUR')
  })

  it('treats a missing or blank currency as SEK', () => {
    expect(articleCurrency({})).toBe('SEK')
    expect(articleCurrency({ currency: null })).toBe('SEK')
    expect(articleCurrency({ currency: '' })).toBe('SEK')
  })
})

describe('listArticleCurrencies', () => {
  it('lists each present currency once, SEK first then alphabetically', () => {
    expect(
      listArticleCurrencies([
        { currency: 'USD' },
        { currency: 'EUR' },
        { currency: 'SEK' },
        { currency: 'EUR' },
        { currency: 'NOK' },
      ]),
    ).toEqual(['SEK', 'EUR', 'NOK', 'USD'])
  })

  it('folds legacy blank rows into SEK', () => {
    expect(listArticleCurrencies([{ currency: null }, { currency: 'sek' }])).toEqual(['SEK'])
  })

  it('is empty for an empty register, so the picker can stay hidden', () => {
    expect(listArticleCurrencies([])).toEqual([])
  })
})

describe('resolveCurrencyScope', () => {
  const available = ['SEK', 'EUR']

  it('defaults to no scope', () => {
    expect(resolveCurrencyScope(null, available)).toBe(ALL_CURRENCIES)
    expect(resolveCurrencyScope(undefined, available)).toBe(ALL_CURRENCIES)
  })

  it('accepts a present currency, case-insensitively', () => {
    expect(resolveCurrencyScope('eur', available)).toBe('EUR')
  })

  // A stale or hand-edited link must not empty the register: the fallback is
  // "show everything", which the user can see and recover from.
  it('falls back to no scope for a currency that is not in the register', () => {
    expect(resolveCurrencyScope('USD', available)).toBe(ALL_CURRENCIES)
    expect(resolveCurrencyScope('nonsense', available)).toBe(ALL_CURRENCIES)
    expect(resolveCurrencyScope('EUR', [])).toBe(ALL_CURRENCIES)
  })
})

describe('matchesCurrencyScope', () => {
  it('keeps every article when unscoped', () => {
    expect(matchesCurrencyScope({ currency: 'USD' }, ALL_CURRENCIES)).toBe(true)
  })

  it('keeps only the scoped currency', () => {
    expect(matchesCurrencyScope({ currency: 'EUR' }, 'EUR')).toBe(true)
    expect(matchesCurrencyScope({ currency: 'USD' }, 'EUR')).toBe(false)
  })

  it('matches legacy blank rows under SEK', () => {
    expect(matchesCurrencyScope({ currency: null }, 'SEK')).toBe(true)
  })
})
