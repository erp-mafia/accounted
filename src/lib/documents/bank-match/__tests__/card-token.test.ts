import { describe, expect, it } from 'vitest'
import { cardEvidence, cardTokensIn, normaliseCardLast4 } from '../card-token'

describe('cardTokensIn', () => {
  it('reads the bank\'s K-token and masked card numbers', () => {
    expect(cardTokensIn(['X CORP. PAID FEATURES K3667'])).toEqual(['3667'])
    expect(cardTokensIn(['SPOTIFY ****1234'])).toEqual(['1234'])
    expect(cardTokensIn(['SPOTIFY XXXX 1234'])).toEqual(['1234'])
    expect(cardTokensIn(['Kortköp', 'Kort 4321'])).toEqual(['4321'])
    expect(cardTokensIn(['kortnr: *5678'])).toEqual(['5678'])
  })

  it('reads no card from other digits: amounts, years, order numbers, words ending in K', () => {
    expect(cardTokensIn(['BETALNING 2026-10-05 3667'])).toEqual([])
    expect(cardTokensIn(['ORDER 12345678'])).toEqual([])
    expect(cardTokensIn(['BOK2026', 'K36670', 'PACK3667'])).toEqual([])
    expect(cardTokensIn([null, undefined, ''])).toEqual([])
  })

  it('names each card once', () => {
    expect(cardTokensIn(['K3667', 'X K3667 ****3667'])).toEqual(['3667'])
  })
})

describe('normaliseCardLast4', () => {
  it('takes four digits as printed, nothing else', () => {
    expect(normaliseCardLast4('3667')).toBe('3667')
    expect(normaliseCardLast4('•• 3667')).toBe('3667')
    expect(normaliseCardLast4('**** 3667')).toBe('3667')
    expect(normaliseCardLast4('36671')).toBeNull()
    expect(normaliseCardLast4('')).toBeNull()
    expect(normaliseCardLast4(3667)).toBeNull()
  })
})

describe('cardEvidence', () => {
  it('agrees, contradicts or says nothing', () => {
    expect(cardEvidence('3667', ['X CORP. K3667'])).toBe('agrees')
    expect(cardEvidence('1234', ['X CORP. K3667'])).toBe('contradicts')
    expect(cardEvidence('3667', ['X CORP.'])).toBe('none')
    expect(cardEvidence(null, ['X CORP. K3667'])).toBe('none')
    expect(cardEvidence('3667', ['K1234', 'K3667'])).toBe('agrees')
  })
})
