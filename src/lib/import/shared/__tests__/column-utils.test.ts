import { describe, it, expect } from 'vitest'
import {
  EXTERNAL_NUMBER_KEYWORDS,
  findColumn,
  findColumnMatch,
  matchTier,
  normalize,
} from '../column-utils'

describe('normalize', () => {
  it('lowercases, strips separators and collapses whitespace', () => {
    expect(normalize('  C/O ')).toBe('c o')
    expect(normalize('Address_Line-2')).toBe('address line 2')
  })
})

describe('matchTier', () => {
  it('grades exact, whole-word and substring matches', () => {
    expect(matchTier('Supplier name', ['supplier name'])).toBe('exact')
    expect(matchTier('Supplier name', ['supplier'])).toBe('word')
    expect(matchTier('Leverantörsnamn', ['leverantör'])).toBe('substring')
    expect(matchTier('Bankgiro', ['iban'])).toBeNull()
  })

  it('only matches short keywords as whole words', () => {
    // 'vat' inside "Privat", 'co' inside "Corporate"/"Country": the substring
    // hits that mis-mapped Visma exports (#2548).
    expect(matchTier('Privat', ['vat'])).toBeNull()
    expect(matchTier('Corporate identity number', ['co'])).toBeNull()
    expect(matchTier('Country', ['co'])).toBeNull()
    expect(matchTier('C/O', ['c o'])).toBe('exact')
    expect(matchTier('CO', ['co'])).toBe('exact')
    expect(matchTier('VAT number', ['vat'])).toBe('word')
  })
})

describe('findColumnMatch', () => {
  it('picks the best-graded header, not the leftmost one', () => {
    const headers = ['Supplier number', 'Supplier name']
    const match = findColumnMatch(headers, ['supplier', 'supplier name'], new Set())
    expect(match).toEqual({ index: 1, tier: 'exact' })
  })

  it('gives equally graded headers to the leftmost column', () => {
    const match = findColumnMatch(['Namn', 'Name'], ['namn', 'name'], new Set())
    expect(match?.index).toBe(0)
  })

  it('skips headers rejected as record numbers', () => {
    const taken = new Set<number>()
    const match = findColumnMatch(['Kundnummer', 'Postnr'], ['kund'], taken, {
      reject: EXTERNAL_NUMBER_KEYWORDS,
    })
    expect(match).toBeNull()
    expect(taken.size).toBe(0)
  })

  it('claims the column it matched so later fields cannot reuse it', () => {
    const taken = new Set<number>()
    expect(findColumn(['Adress', 'C/O'], ['adress'], taken)).toBe(0)
    expect(findColumn(['Adress', 'C/O'], ['c o', 'co'], taken)).toBe(1)
    expect(findColumn(['Adress', 'C/O'], ['adress'], taken)).toBeNull()
  })
})
