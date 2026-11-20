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

  // PH 204: Spiris writes its customer export headers in PascalCase.
  it('splits camelCase and PascalCase headers into their words', () => {
    expect(normalize('InvoicePostalCode')).toBe('invoice postal code')
    expect(normalize('CorporateIdentityNumber')).toBe('corporate identity number')
    expect(normalize('VATNumber')).toBe('vat number')
    expect(normalize('DeliveryAddress1')).toBe('delivery address1')
  })

  it('leaves all-caps, lowercase and Swedish compound headers whole', () => {
    expect(normalize('ORGNR')).toBe('orgnr')
    expect(normalize('Organisationsnummer')).toBe('organisationsnummer')
    expect(normalize('E-POST')).toBe('e post')
    expect(normalize('Postadress 1')).toBe('postadress 1')
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

describe('matchTier on joined words and compounds', () => {
  // PH 204: read as one run, "InvoicePostalCode" contained "epost" and was
  // taken as the e-mail column of a Spiris customer export.
  it('does not find a keyword across the words of a camelCase header', () => {
    expect(matchTier('InvoicePostalCode', ['epost', 'e post', 'e-post'])).toBeNull()
    expect(matchTier('InvoicePostalCode', ['postal code'])).toBe('word')
  })

  it('matches a header whose words are run together or split apart', () => {
    expect(matchTier('KundNummer', ['kundnummer'])).toBe('exact')
    expect(matchTier('Post nr', ['postnr'])).toBe('exact')
    expect(matchTier('CustomerNumber', ['customer number'])).toBe('exact')
  })

  it('keeps a phrase that is the head or the tail of a Swedish compound', () => {
    expect(matchTier('E-postadress', ['e post'])).toBe('substring')
    expect(matchTier('Fakturaadress 2', ['adress 2'])).toBe('substring')
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
