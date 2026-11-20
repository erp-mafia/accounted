/**
 * matchBankByName: the deep-link resolver behind /import?mode=psd2&bank=<name>.
 * Conservative on purpose: starting a consent at the wrong institution is
 * worse than falling back to the prefilled picker.
 */
import { describe, expect, it } from 'vitest'
import { matchBankByName } from '../lib/bank-match'

const BANKS = [
  { name: 'Swedbank' },
  { name: 'SEB' },
  { name: 'Nordea' },
  { name: 'Handelsbanken' },
  { name: 'Danske Bank' },
  { name: 'Länsförsäkringar Bank' },
  { name: 'Länsförsäkringar Skåne' },
  { name: 'ICA Banken' },
  { name: 'Svea Bank' },
]

describe('matchBankByName', () => {
  it('matches exact names case-insensitively', () => {
    expect(matchBankByName(BANKS, 'swedbank')?.name).toBe('Swedbank')
    expect(matchBankByName(BANKS, 'SEB')?.name).toBe('SEB')
    expect(matchBankByName(BANKS, '  handelsbanken  ')?.name).toBe('Handelsbanken')
  })

  it('matches a unique prefix', () => {
    expect(matchBankByName(BANKS, 'nord')?.name).toBe('Nordea')
    expect(matchBankByName(BANKS, 'danske')?.name).toBe('Danske Bank')
  })

  it('matches a unique substring', () => {
    expect(matchBankByName(BANKS, 'ica')?.name).toBe('ICA Banken')
  })

  it('returns null for an ambiguous name instead of guessing an institution', () => {
    expect(matchBankByName(BANKS, 'länsförsäkringar')).toBeNull()
  })

  it('resolves a brand held at another bank: ?bank=Bokio starts the Svea Bank consent', () => {
    expect(matchBankByName(BANKS, 'Bokio')?.name).toBe('Svea Bank')
    expect(matchBankByName(BANKS, 'bokio företagskonto')?.name).toBe('Svea Bank')
    expect(matchBankByName(BANKS, 'svea')?.name).toBe('Svea Bank')
  })

  it('does not auto-start a consent from a partial alias or an unlisted or doubled alias bank', () => {
    expect(matchBankByName(BANKS, 'bok')).toBeNull()
    expect(matchBankByName(BANKS.filter((b) => b.name !== 'Svea Bank'), 'Bokio')).toBeNull()
    expect(matchBankByName([...BANKS, { name: 'SVEA BANK' }], 'Bokio')).toBeNull()
  })

  it('returns null for unknown or empty input', () => {
    expect(matchBankByName(BANKS, 'Monopolbanken')).toBeNull()
    expect(matchBankByName(BANKS, '')).toBeNull()
    expect(matchBankByName(BANKS, '   ')).toBeNull()
  })
})
