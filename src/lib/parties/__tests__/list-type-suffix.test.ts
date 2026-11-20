import { describe, it, expect } from 'vitest'
import { dominantPartyType, partyTypeSuffix } from '@/lib/parties/list-type-suffix'

const ORDER = ['swedish_business', 'individual', 'eu_business', 'non_eu_business'] as const
type T = (typeof ORDER)[number]

describe('dominantPartyType', () => {
  it('picks the type most rows share', () => {
    const types: T[] = ['swedish_business', 'eu_business', 'swedish_business', 'individual', 'swedish_business']
    expect(dominantPartyType(types, ORDER)).toBe('swedish_business')
  })

  it('picks individuals in a mostly-private list', () => {
    const types: T[] = ['individual', 'individual', 'swedish_business']
    expect(dominantPartyType(types, ORDER)).toBe('individual')
  })

  it('breaks a tie by the given order, not by row order', () => {
    expect(dominantPartyType<T>(['individual', 'swedish_business'], ORDER)).toBe('swedish_business')
    expect(dominantPartyType<T>(['swedish_business', 'individual'], ORDER)).toBe('swedish_business')
  })

  it('answers null for an empty list and ignores missing types', () => {
    expect(dominantPartyType<T>([], ORDER)).toBeNull()
    expect(dominantPartyType<T>([null, undefined], ORDER)).toBeNull()
    expect(dominantPartyType<T>([null, 'eu_business'], ORDER)).toBe('eu_business')
  })
})

describe('partyTypeSuffix', () => {
  it('says nothing for the normal type', () => {
    expect(partyTypeSuffix<T>('swedish_business', 'swedish_business')).toBeNull()
  })

  it('names a deviating type', () => {
    expect(partyTypeSuffix<T>('eu_business', 'swedish_business')).toBe('eu_business')
    expect(partyTypeSuffix<T>('swedish_business', 'individual')).toBe('swedish_business')
  })

  it('says nothing for a row without a type', () => {
    expect(partyTypeSuffix<T>(null, 'swedish_business')).toBeNull()
    expect(partyTypeSuffix<T>(undefined, 'swedish_business')).toBeNull()
  })
})
