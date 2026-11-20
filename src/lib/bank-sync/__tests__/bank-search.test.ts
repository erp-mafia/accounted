/**
 * Bank search aliases: a brand held at another bank must be findable by the
 * brand's name, in the settings picker, the onboarding bank step and the
 * ?bank= deep link, without widening any other search.
 */
import { describe, expect, it } from 'vitest'
import {
  BANK_SEARCH_ALIASES,
  bankMatchesQuery,
  bankNameForAlias,
  bankSearchAlias,
  searchAliasHint,
} from '../bank-search'

const BANKS = [
  { name: 'Swedbank' },
  { name: 'SEB' },
  { name: 'Nordea' },
  { name: 'Handelsbanken' },
  { name: 'Svea Bank' },
  { name: 'ICA Banken' },
]

const search = (query: string) => BANKS.filter((b) => bankMatchesQuery(b, query)).map((b) => b.name)

describe('bankMatchesQuery', () => {
  it('finds Svea Bank for "bokio" and "Bokio Företagskonto", in any case and with stray spaces', () => {
    expect(search('bokio')).toEqual(['Svea Bank'])
    expect(search('Bokio')).toEqual(['Svea Bank'])
    expect(search('  BOKIO  ')).toEqual(['Svea Bank'])
    expect(search('Bokio Företagskonto')).toEqual(['Svea Bank'])
    expect(search('bokio   företagskonto')).toEqual(['Svea Bank'])
  })

  it('finds Svea Bank while "bokio" is being typed and when more words follow it', () => {
    expect(search('bok')).toEqual(['Svea Bank'])
    expect(search('bokio konto')).toEqual(['Svea Bank'])
  })

  it('treats a decomposed ö like the composed one', () => {
    expect(search('bokio företagskonto')).toEqual(['Svea Bank'])
  })

  it('keeps the plain name search as it was', () => {
    expect(search('svea')).toEqual(['Svea Bank'])
    expect(search('Swed')).toEqual(['Swedbank'])
    expect(search('bank')).toEqual(['Swedbank', 'Handelsbanken', 'Svea Bank', 'ICA Banken'])
  })

  it('does not list Svea Bank for a word that only occurs inside the alias', () => {
    expect(search('konto')).toEqual([])
    expect(search('företagskonto')).toEqual([])
  })

  it('finds nothing for an unknown name and everything for an empty query', () => {
    expect(search('Monopolbanken')).toEqual([])
    expect(search('')).toHaveLength(BANKS.length)
    expect(search('   ')).toHaveLength(BANKS.length)
  })

  it('never aliases a bank with another name', () => {
    expect(bankMatchesQuery({ name: 'Swedbank' }, 'bokio')).toBe(false)
  })
})

describe('bankSearchAlias', () => {
  it('names the alias when the bank was found through it', () => {
    expect(bankSearchAlias({ name: 'Svea Bank' }, 'Bokio')).toMatchObject({
      bank: 'Svea Bank',
      product: 'Bokio Företagskonto',
    })
  })

  it('is null when the bank name itself matches, so no hint is shown for "svea"', () => {
    expect(bankSearchAlias({ name: 'Svea Bank' }, 'svea')).toBeNull()
    expect(bankSearchAlias({ name: 'Svea Bank' }, 'b')).toBeNull()
  })

  it('matches the listed name case-insensitively', () => {
    expect(bankSearchAlias({ name: 'SVEA BANK' }, 'bokio')?.bank).toBe('Svea Bank')
  })
})

describe('searchAliasHint', () => {
  it('returns the alias behind the first result found through one', () => {
    expect(searchAliasHint(BANKS, 'bokio')?.product).toBe('Bokio Företagskonto')
  })

  it('is null when every result matched by name, or the query is empty', () => {
    expect(searchAliasHint(BANKS, 'svea')).toBeNull()
    expect(searchAliasHint(BANKS, 'swed')).toBeNull()
    expect(searchAliasHint(BANKS, '')).toBeNull()
    expect(searchAliasHint([], 'bokio')).toBeNull()
  })
})

describe('bankNameForAlias', () => {
  it('resolves a complete alias term to the bank that holds the account', () => {
    expect(bankNameForAlias('Bokio')).toBe('Svea Bank')
    expect(bankNameForAlias(' bokio företagskonto ')).toBe('Svea Bank')
  })

  it('does not resolve a partial word: a deep link starts a consent without a click', () => {
    expect(bankNameForAlias('bo')).toBeNull()
    expect(bankNameForAlias('bokio konto')).toBeNull()
    expect(bankNameForAlias('')).toBeNull()
  })
})

describe('BANK_SEARCH_ALIASES', () => {
  it('pins the Svea Bank ASPSP name the Bokio alias depends on', () => {
    // Enable Banking lists the institution as "Svea Bank" (bank_connections.bank_name).
    // If the ASPSP is ever renamed this entry must follow, or the alias finds nothing.
    expect(BANK_SEARCH_ALIASES.find((a) => a.product === 'Bokio Företagskonto')?.bank).toBe('Svea Bank')
  })

  it('stores every term in normalized form, so startsWith compares like with like', () => {
    for (const alias of BANK_SEARCH_ALIASES) {
      for (const term of alias.terms) {
        expect(term).toBe(term.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase())
      }
    }
  })

  it('never lets a term be claimed by two banks', () => {
    const terms = BANK_SEARCH_ALIASES.flatMap((a) => a.terms)
    expect(new Set(terms).size).toBe(terms.length)
  })
})
