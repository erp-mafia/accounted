import { describe, it, expect } from 'vitest'
import { nextLineDescriptionForAccountChange } from '@/components/bookkeeping/correction-line-description'

const ACCOUNTS = [
  { account_number: '2393', account_name: 'Lån från närstående personer, långfristig del' },
  { account_number: '2893', account_name: 'Skulder till närstående personer, kortfristig del' },
  { account_number: '1930', account_name: 'Företagskonto' },
]

describe('nextLineDescriptionForAccountChange', () => {
  it('refreshes the carried-over description when switching 2393 -> 2893 (the reported bug)', () => {
    // Original correction line pre-filled from 2393 with 2393's name.
    const result = nextLineDescriptionForAccountChange(
      'Lån från närstående personer, långfristig del',
      '2393',
      '2893',
      ACCOUNTS,
    )
    expect(result).toBe('Skulder till närstående personer, kortfristig del')
  })

  it('fills the description when the line had no description yet', () => {
    expect(nextLineDescriptionForAccountChange('', '', '2893', ACCOUNTS)).toBe(
      'Skulder till närstående personer, kortfristig del',
    )
  })

  it('preserves a memo the user typed themselves', () => {
    expect(
      nextLineDescriptionForAccountChange('Återbetalning till Anna', '1930', '2893', ACCOUNTS),
    ).toBe('Återbetalning till Anna')
  })

  it('leaves the description untouched when the new account is unknown', () => {
    expect(
      nextLineDescriptionForAccountChange('Lån från närstående personer, långfristig del', '2393', '9999', ACCOUNTS),
    ).toBe('Lån från närstående personer, långfristig del')
  })

  it('returns the current description when the account is cleared', () => {
    expect(nextLineDescriptionForAccountChange('Företagskonto', '1930', '', ACCOUNTS)).toBe('Företagskonto')
  })

  it('treats a description equal to the new account name as already correct', () => {
    // Switching to an account whose name already matches: no visible change.
    expect(
      nextLineDescriptionForAccountChange('Skulder till närstående personer, kortfristig del', '2393', '2893', ACCOUNTS),
    ).toBe('Skulder till närstående personer, kortfristig del')
  })
})
