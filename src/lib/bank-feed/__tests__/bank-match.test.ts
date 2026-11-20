import { describe, expect, it } from 'vitest'
import { matchBankByName } from '../bank-match'

const banks = [
  { bic: 'SWEDSESS', name: 'Swedbank' },
  { bic: 'ESSESESS', name: 'SEB' },
  { bic: 'NDEASESS', name: 'Nordea' },
  { bic: 'ELLFSESS', name: 'Länsförsäkringar' },
]

describe('matchBankByName', () => {
  it('matches the exact name, case and surrounding space aside', () => {
    expect(matchBankByName('swedbank', banks)?.bic).toBe('SWEDSESS')
    expect(matchBankByName('  SEB ', banks)?.bic).toBe('ESSESESS')
  })

  it('falls back to containment either way', () => {
    expect(matchBankByName('Länsförsäkringar Bank', banks)?.bic).toBe('ELLFSESS')
    expect(matchBankByName('Nordea Bank Abp', banks)?.bic).toBe('NDEASESS')
    expect(matchBankByName('Swed', banks)?.bic).toBe('SWEDSESS')
  })

  it('prefers the exact name over a containing one', () => {
    const list = [{ bic: 'A', name: 'Svea Bank' }, { bic: 'B', name: 'Svea' }]
    expect(matchBankByName('Svea', list)?.bic).toBe('B')
  })

  it('answers null for an unknown bank, an empty name or no list', () => {
    expect(matchBankByName('Wise', banks)).toBeNull()
    expect(matchBankByName('', banks)).toBeNull()
    expect(matchBankByName(null, banks)).toBeNull()
    expect(matchBankByName('SEB', null)).toBeNull()
    expect(matchBankByName('SEB', [])).toBeNull()
  })
})
